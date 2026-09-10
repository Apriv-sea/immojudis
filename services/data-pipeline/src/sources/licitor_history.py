from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from statistics import median
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup, Tag

from src.config import TARGET_DEPARTMENTS, load_settings
from src.normalize import clean_text, normalize_property_type
from src.raw_models import validate_raw_sales
from src.sources.common import ScrapeResult, is_allowed_origin_url
from src.sources.licitor import (
    ALLOWED_ORIGINS,
    LICITOR_ZONE_URLS,
    LicitorClient,
    parse_licitor_detail_html,
)

LICITOR_HISTORY_ZONE_URLS = tuple(
    url.replace("prochaines-ventes.html", "historique-des-adjudications.html") for url in LICITOR_ZONE_URLS
)
LICITOR_HISTORY_CONNECTOR_VERSION = "licitor-history/5"
LICITOR_RIGHTS_URL = "https://www.licitor.com/droits-auteur.html"

_HISTORY_PATH = re.compile(r"/ventes-aux-encheres-immobilieres/.+/historique-des-adjudications\.html$")
_DETAIL_PATH = re.compile(r"/annonce/.+/\d+\.html$")
_PAGE_EXTERNAL_ID = re.compile(r"/(\d+)\.html$")
_LOT_LABEL = re.compile(r"(\d+)(?:er|e|eme|ème)?\s+lot\s*:\s*([^€]+€)", re.I)
_MONEY = re.compile(r"([0-9][0-9\s\u00a0\u202f]*(?:[.,][0-9]{1,2})?)\s*€")
_ISO_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
_FRENCH_RESULT_DATE = re.compile(r"\b(\d{2})-(\d{2})-(\d{4})\b")


class LicitorHistoricalAuthorizationError(RuntimeError):
    """Raised when the network crawl is requested without a reviewed right to reuse."""


@dataclass(frozen=True, slots=True)
class LicitorHistoryIndexEntry:
    source_url: str
    department: str | None
    city: str | None
    property_type: str | None
    description: str | None
    result_date: date | None
    hammer_price_eur: Decimal | None
    page_position: int


@dataclass(frozen=True, slots=True)
class LicitorHistoryIndexPage:
    entries: tuple[LicitorHistoryIndexEntry, ...]
    next_urls: tuple[str, ...]
    declared_total: int | None
    declared_pages: int | None


def parse_licitor_history_list_html(
    html: str,
    page_url: str = LICITOR_HISTORY_ZONE_URLS[0],
) -> LicitorHistoryIndexPage:
    """Parse one public Licitor results page without following any link."""

    soup = BeautifulSoup(html, "html.parser")
    entries: list[LicitorHistoryIndexEntry] = []
    for position, link in enumerate(soup.select("#zone-list a.Ad.Archives[href]"), start=1):
        href = str(link.get("href") or "")
        source_url = _without_fragment(urljoin(page_url, href))
        if not is_allowed_origin_url(source_url, ALLOWED_ORIGINS):
            continue
        if not _DETAIL_PATH.search(urlsplit(source_url).path):
            continue
        department = _node_text(link.select_one(".Location .Number"))
        if department:
            department = department.upper()
        result_text = _node_text(link.select_one(".Result")) or ""
        entries.append(
            LicitorHistoryIndexEntry(
                source_url=source_url,
                department=department,
                city=_node_text(link.select_one(".Location .City")),
                property_type=_node_text(link.select_one(".Description .Name")),
                description=_node_text(link.select_one(".Description .Text")),
                result_date=_result_date(result_text),
                hammer_price_eur=_money(_node_text(link.select_one(".Result .PriceNumber"))),
                page_position=position,
            )
        )

    next_urls: list[str] = []
    for link in soup.select("#zone-list .Pagination a[href]"):
        absolute = urljoin(page_url, str(link.get("href") or ""))
        parsed = urlsplit(absolute)
        if not is_allowed_origin_url(absolute, ALLOWED_ORIGINS):
            continue
        if not _HISTORY_PATH.search(parsed.path) or not parsed.query:
            continue
        if absolute not in next_urls:
            next_urls.append(absolute)

    total_input = soup.select_one("#zone-list .PageField input[name='total']")
    total_pages = _node_text(soup.select_one("#zone-list .PageTotal"))
    return LicitorHistoryIndexPage(
        entries=tuple(entries),
        next_urls=tuple(next_urls),
        declared_total=_positive_int(total_input.get("value") if isinstance(total_input, Tag) else None),
        declared_pages=_last_positive_int(total_pages),
    )


def parse_licitor_historical_detail_html(
    html: str,
    source_url: str,
) -> list[dict[str, Any]]:
    """Return one candidate per price-bearing lot from a Licitor archive page.

    Multi-lot pages are split deterministically. The returned rows are catalogue
    candidates only: they remain grade C and non-training until independently
    matched and reviewed in the Outcome Graph.
    """

    canonical_url = _without_fragment(source_url)
    base = parse_licitor_detail_html(html, canonical_url)
    soup = BeautifulSoup(html, "html.parser")
    base["tribunal"] = _node_text(soup.select_one(".LegalAd .Court"))
    page_external_id = str(base.get("external_id") or _external_id(canonical_url) or "unknown")
    result_date = _detail_result_date(soup)
    publication_date = _detail_publication_date(soup)
    common_quality_flags = [
        "third_party_result_candidate",
        "commercial_reuse_rights_pending",
    ]
    records: list[dict[str, Any]] = []
    lots = list(soup.select(".LegalAd .AddressBlock > .Lot"))
    has_priced_lot = any(
        _lot_result_prices(_node_text(lot.select_one(":scope > h3")) or "")
        for lot in lots
    )
    for lot_position, lot in enumerate(lots, start=1):
        location = lot.parent.select_one(":scope > .Location") if isinstance(lot.parent, Tag) else None
        city_label = _node_text(location.select_one(".City")) if location else None
        department_label = re.search(r"\(([^)]+)\)\s*$", city_label or "")
        lot_base = {
            **base,
            "city": clean_text(re.sub(r"\s*\([^)]*\)\s*$", "", city_label or "")),
            "address": _node_text(location.select_one(".Street")) if location else None,
            "department": None,
            "postal_code": None,
            "source_department_label": department_label.group(1) if department_label else None,
        }
        explicit_lot_heading = _node_text(lot.select_one(":scope > h1"))
        lot_heading = explicit_lot_heading or f"lot {lot_position}"
        result_text = _node_text(lot.select_one(":scope > h3")) or ""
        starting_text = _node_text(lot.select_one(":scope > h4")) or ""
        result_prices = _lot_result_prices(result_text)
        starting_prices = _money_values(starting_text)
        sublots = list(lot.select(":scope > .SousLot"))

        # Some archive pages prepend a generic, untitled "result unknown"
        # block before the actual numbered, price-bearing lots. It is page
        # chrome rather than another lot and would otherwise collide with lot 1.
        if (
            has_priced_lot
            and explicit_lot_heading is None
            and not result_prices
            and re.search(r"r[eé]sultat\s+d['’]?adjudication\s+inconnu", result_text, re.I)
        ):
            continue

        if result_prices:
            for result_position, (lot_number, hammer_price) in enumerate(result_prices, start=1):
                starting_price = _paired_starting_price(
                    starting_prices,
                    result_count=len(result_prices),
                    result_position=result_position,
                    explicitly_per_lot=bool(re.search(r"chaque lot|par lot", starting_text, re.I)),
                )
                sublot = _paired_sublot(sublots, len(result_prices), result_position)
                property_type = _node_text(sublot.select_one("h2")) if sublot else None
                description = _node_text(sublot.select_one("p")) if sublot else None
                logical_lot = lot_number or _lot_number(lot_heading) or str(lot_position)
                records.append(
                    _historical_raw_sale(
                        base=lot_base,
                        canonical_url=canonical_url,
                        page_external_id=page_external_id,
                        logical_lot=logical_lot,
                        lot_heading=lot_heading,
                        property_type=property_type,
                        description=description,
                        result_date=result_date,
                        publication_date=publication_date,
                        starting_price=starting_price,
                        hammer_price=hammer_price,
                        status="adjudicated",
                        result_text=result_text,
                        starting_text=starting_text,
                        quality_flags=common_quality_flags,
                    )
                )
            continue

        if result_text:
            no_bid = bool(re.search(r"carence\s+d['’]?ench[eè]res?|aucune\s+ench[eè]re", result_text, re.I))
            sublot = sublots[0] if sublots else None
            records.append(
                _historical_raw_sale(
                    base=lot_base,
                    canonical_url=canonical_url,
                    page_external_id=page_external_id,
                    logical_lot=_lot_number(lot_heading) or str(lot_position),
                    lot_heading=lot_heading,
                    property_type=_node_text(sublot.select_one("h2")) if sublot else None,
                    description=_node_text(sublot.select_one("p")) if sublot else None,
                    result_date=result_date,
                    publication_date=publication_date,
                    starting_price=starting_prices[0] if len(starting_prices) == 1 else None,
                    hammer_price=None,
                    status="past",
                    result_text=result_text,
                    starting_text=starting_text,
                    quality_flags=[
                        *common_quality_flags,
                        "held_no_bid_candidate" if no_bid else "unparsed_outcome_candidate",
                    ],
                )
            )

    return records


def build_licitor_price_statistics(
    records: Iterable[dict[str, Any]],
    *,
    as_of: date,
    recent_months: int = 36,
    minimum_sample: int = 10,
) -> dict[str, object]:
    """Compute Adjugé-equivalent facts from independently captured lot rows."""

    if recent_months < 1:
        raise ValueError("recent_months must be positive")
    if minimum_sample < 1:
        raise ValueError("minimum_sample must be positive")
    unique: dict[str, dict[str, Any]] = {}
    conflicts: set[str] = set()
    for position, record in enumerate(records):
        identity = str(record.get("external_id") or record.get("source_url") or f"anonymous:{position}")
        if (row := _stat_row(record)) is None or row["result_date"] > as_of:
            continue
        if identity in unique and row != unique[identity]:
            conflicts.add(identity)
        else:
            unique[identity] = row
    window_start = licitor_window_start(as_of)
    normalized = [
        row
        for identity, row in unique.items()
        if identity not in conflicts and window_start <= row["result_date"] <= as_of
    ]
    recent_start = _subtract_calendar_months(as_of, recent_months)
    recent = [row for row in normalized if recent_start <= row["result_date"] <= as_of]
    return {
        "schemaVersion": "licitor_price_statistics_v2",
        "method": {
            "ratio": "hammer_price_eur / starting_price_eur",
            "startingPriceFloorExclusiveEur": 1_000,
            "aboveStarting": "hammer_price_eur > starting_price_eur",
            "atLeastDouble": "hammer_price_eur >= 2 * starting_price_eur",
            "minimumDiagnosticSample": minimum_sample,
            "conflictingLotIdsExcluded": len(conflicts),
            "retentionWindowMonths": 36,
            "retentionWindowStart": window_start.isoformat(),
        },
        "source": {
            "name": "Licitor public results",
            "publisher": "Ferrari Conseil S.A.",
            "official": False,
            "rightsStatus": "see_run_authorization_record",
            "rightsUrl": LICITOR_RIGHTS_URL,
            "trainingEligible": False,
            "publicationEligible": False,
            "reviewStatus": "pending",
        },
        "periods": {
            # Compatibility key: this now means the complete retained three-year window.
            "fullArchive": _aggregate(normalized, minimum_sample=minimum_sample),
            f"last{recent_months}Months": {
                "start": recent_start.isoformat(),
                "end": as_of.isoformat(),
                "national": _aggregate(recent, minimum_sample=minimum_sample),
                "departments": _grouped_aggregates(
                    recent,
                    key="department",
                    minimum_sample=minimum_sample,
                ),
                "tribunals": _grouped_aggregates(
                    recent,
                    key="tribunal",
                    minimum_sample=minimum_sample,
                ),
                "propertyTypes": _grouped_aggregates(
                    recent,
                    key="property_type",
                    minimum_sample=minimum_sample,
                ),
            },
        },
    }


def scrape_licitor_historical_result(
    *,
    max_pages_per_zone: int,
    max_details: int | None = None,
    authorization_confirmed: bool = False,
) -> ScrapeResult:
    """Bounded, robots-aware crawler kept closed until rights are approved."""

    if not authorization_confirmed:
        raise LicitorHistoricalAuthorizationError(
            "Licitor historical crawling requires explicit source reuse authorization."
        )
    if max_pages_per_zone < 1:
        raise ValueError("max_pages_per_zone must be positive")
    if max_details is not None and max_details < 1:
        raise ValueError("max_details must be positive")

    settings = load_settings()
    if not bool(settings["licitor_historical_authorized"]):
        raise LicitorHistoricalAuthorizationError(
            "LICITOR_HISTORICAL_AUTHORIZED must be true for an explicitly authorized run."
        )
    client = LicitorClient(
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    errors: list[str] = []
    pages_fetched = 0
    entries: list[LicitorHistoryIndexEntry] = []
    for start_url in _history_start_urls_for_target_departments():
        pending = [start_url]
        visited: set[str] = set()
        while pending and len(visited) < max_pages_per_zone:
            page_url = pending.pop(0)
            if page_url in visited:
                continue
            visited.add(page_url)
            try:
                page = parse_licitor_history_list_html(client.get(page_url), page_url)
            except Exception as exc:  # pragma: no cover - live network failure
                errors.append(f"{page_url}: {exc}")
                continue
            pages_fetched += 1
            entries.extend(page.entries)
            pending.extend(url for url in page.next_urls if url not in visited and url not in pending)

    entries_by_url: dict[str, list[LicitorHistoryIndexEntry]] = defaultdict(list)
    ordered_detail_urls: list[str] = []
    for entry in entries:
        if entry.source_url not in entries_by_url:
            ordered_detail_urls.append(entry.source_url)
        entries_by_url[entry.source_url].append(entry)
    if max_details is not None:
        ordered_detail_urls = ordered_detail_urls[:max_details]

    raw_sales: list[dict[str, Any]] = []
    details_fetched = 0
    for detail_url in ordered_detail_urls:
        try:
            parsed = parse_licitor_historical_detail_html(client.get(detail_url), detail_url)
        except Exception as exc:  # pragma: no cover - live network failure
            errors.append(f"{detail_url}: {exc}")
            continue
        details_fetched += 1
        raw_sales.extend(_select_indexed_records(parsed, entries_by_url[detail_url]))

    return ScrapeResult(
        validate_raw_sales("licitor", raw_sales, errors),
        errors,
        {
            "connector_version": LICITOR_HISTORY_CONNECTOR_VERSION,
            "index_pages_fetched": pages_fetched,
            "index_entries_seen": len(entries),
            "detail_pages_fetched": details_fetched,
            "candidate_lots": len(raw_sales),
            "rights_status": "authorization_confirmed_for_this_run",
        },
    )


def _historical_raw_sale(
    *,
    base: dict[str, Any],
    canonical_url: str,
    page_external_id: str,
    logical_lot: str,
    lot_heading: str,
    property_type: str | None,
    description: str | None,
    result_date: date | None,
    publication_date: date | None,
    starting_price: Decimal | None,
    hammer_price: Decimal | None,
    status: str,
    result_text: str,
    starting_text: str,
    quality_flags: list[str],
) -> dict[str, Any]:
    fragment = _fragment(logical_lot)
    title = clean_text(property_type) or clean_text(base.get("title")) or lot_heading
    property_kind = normalize_property_type(title)
    if re.search(r"emplacement.*(?:v[eé]hicule|automobile|voiture|stationnement)", title, re.I):
        property_kind = "parking"
    lot_description = clean_text(description) or clean_text(base.get("description")) or title
    raw_text = "\n".join(part for part in (lot_heading, title, lot_description, result_text, starting_text) if part)
    source_url = f"{canonical_url}#lot-{fragment}"
    row = {
        **base,
        "source_name": "licitor",
        "source_url": source_url,
        "source_urls": [canonical_url],
        "external_id": f"{page_external_id}:lot:{logical_lot}",
        "property_type": property_kind,
        "property_type_source_label": title,
        "title": title,
        "description": lot_description,
        "sale_date": result_date.isoformat() if result_date else base.get("sale_date"),
        "status": status,
        "starting_price_eur": _decimal_string(starting_price),
        "adjudication_price_eur": _decimal_string(hammer_price),
        "raw_text": raw_text,
        "quality_flags": quality_flags,
        "candidate_grade": "C",
        "evidence_grade": "C",
        "training_eligible": False,
        "source_is_official": False,
        "sale_venue_type": "tribunal" if re.search(r"\btribunal\b", str(base.get("tribunal") or ""), re.I) else "other",
        "publication_eligible": False,
        "review_status": "pending",
        "finality_status": "unknown",
        "source_page_url": canonical_url,
        "source_published_date": publication_date.isoformat() if publication_date else None,
        "source_blocks": {
            "lot": lot_heading,
            "titre": title,
            "description": lot_description,
            "mise_a_prix": _decimal_string(starting_price),
            "adjudication": _decimal_string(hammer_price),
            "resultat_source": result_text,
            "date_vente": result_date.isoformat() if result_date else None,
            "page_source": canonical_url,
        },
    }
    # Page-wide features may describe a different lot. They must not leak into
    # this result candidate or become mistaken price/m² inputs.
    for key in (
        "surface_m2",
        "lawyer_name",
        "lawyer_contact",
        "visit_dates",
        "occupancy_status",
        "latitude",
        "longitude",
        "raw_image_url",
        "source_images",
        "documents",
    ):
        row.pop(key, None)
    row["documents"] = []
    if hammer_price is None:
        row.pop("adjudication_price_eur", None)
    if starting_price is None:
        row.pop("starting_price_eur", None)
    return row


def _select_indexed_records(
    parsed: Sequence[dict[str, Any]],
    entries: Sequence[LicitorHistoryIndexEntry],
) -> list[dict[str, Any]]:
    remaining = list(parsed)
    selected: list[dict[str, Any]] = []
    duplicate_fragments: defaultdict[str, int] = defaultdict(int)
    for entry in entries:
        match_index = next(
            (
                index
                for index, row in enumerate(remaining)
                if _money(row.get("adjudication_price_eur")) == entry.hammer_price_eur
                and _loosely_same_text(row.get("property_type"), entry.property_type)
            ),
            None,
        )
        if match_index is None:
            match_index = next(
                (
                    index
                    for index, row in enumerate(remaining)
                    if _money(row.get("adjudication_price_eur")) == entry.hammer_price_eur
                ),
                None,
            )
        if match_index is not None:
            row = dict(remaining.pop(match_index))
        else:
            row = _index_only_candidate(entry, duplicate_fragments[entry.source_url] + 1)
        duplicate_fragments[entry.source_url] += 1
        if entry.department:
            row["department"] = entry.department
        if entry.city:
            row["city"] = entry.city
        if entry.result_date:
            row["sale_date"] = entry.result_date.isoformat()
        selected.append(row)
    return selected


def _index_only_candidate(entry: LicitorHistoryIndexEntry, ordinal: int) -> dict[str, Any]:
    page_external_id = _external_id(entry.source_url) or "unknown"
    fragment = f"archive-result-{ordinal}"
    return {
        "source_name": "licitor",
        "source_url": f"{entry.source_url}#{fragment}",
        "source_urls": [entry.source_url],
        "external_id": f"{page_external_id}:archive-result:{ordinal}",
        "department": entry.department,
        "city": entry.city,
        "property_type": entry.property_type,
        "title": entry.property_type or "Résultat d'adjudication",
        "description": entry.description or entry.property_type or "Résultat d'adjudication",
        "sale_date": entry.result_date.isoformat() if entry.result_date else None,
        "status": "adjudicated" if entry.hammer_price_eur is not None else "past",
        "adjudication_price_eur": _decimal_string(entry.hammer_price_eur),
        "documents": [],
        "raw_text": clean_text(" ".join(part for part in (entry.property_type, entry.description) if part)),
        "quality_flags": [
            "third_party_result_candidate",
            "commercial_reuse_rights_pending",
            "starting_price_missing_from_detail",
        ],
        "candidate_grade": "C",
        "evidence_grade": "C",
        "training_eligible": False,
        "source_is_official": False,
        "source_page_url": entry.source_url,
    }


def _lot_result_prices(value: str) -> list[tuple[str | None, Decimal]]:
    labeled = [
        (match.group(1), amount)
        for match in _LOT_LABEL.finditer(value)
        if (amount := _money(match.group(2))) is not None
    ]
    if labeled:
        return labeled
    if re.search(r"adjudication", value, re.I):
        values = _money_values(value)
        if len(values) == 1:
            return [(None, values[0])]
    return []


def _paired_starting_price(
    values: Sequence[Decimal],
    *,
    result_count: int,
    result_position: int,
    explicitly_per_lot: bool = False,
) -> Decimal | None:
    if len(values) == 1 and (result_count == 1 or explicitly_per_lot):
        return values[0]
    if len(values) == result_count:
        return values[result_position - 1]
    return None


def _paired_sublot(sublots: Sequence[Tag], result_count: int, result_position: int) -> Tag | None:
    if len(sublots) == result_count:
        return sublots[result_position - 1]
    return sublots[0] if sublots else None


def _stat_row(record: dict[str, Any]) -> dict[str, Any] | None:
    if record.get("sale_venue_type", "tribunal") != "tribunal":
        return None
    if {
        "index_detail_date_conflict",
        "conflicting_announcement_alias_capture",
        "cached_reparse_failed",
        "source_result_changed_pending_review",
        "lot_missing_in_latest_capture",
    }.intersection(record.get("quality_flags") or []):
        return None
    starting = _money(record.get("starting_price_eur"))
    hammer = _money(record.get("adjudication_price_eur"))
    result_date = _coerce_date(record.get("sale_date"))
    if starting is None or hammer is None or result_date is None:
        return None
    if starting <= Decimal("1000") or hammer <= 0:
        return None
    return {
        "starting": starting,
        "hammer": hammer,
        "ratio": hammer / starting,
        "result_date": result_date,
        "department": _optional_text(record.get("department")),
        "tribunal": _optional_text(record.get("tribunal")),
        "property_type": normalize_property_type(record.get("property_type")),
    }


def _aggregate(rows: Sequence[dict[str, Any]], *, minimum_sample: int) -> dict[str, object]:
    sample_size = len(rows)
    if sample_size < minimum_sample:
        return {
            "status": "insufficient_data",
            "sampleSize": sample_size,
            "medianHammerToStartingRatio": None,
            "aboveStartingRate": None,
            "atLeastDoubleRate": None,
            "medianHammerPriceEur": None,
            "medianStartingPriceEur": None,
            "hammerPriceMiddle50Eur": None,
            "ratioMiddle50": None,
            "bidDistribution": None,
        }
    return {
        "status": "sample_threshold_met_not_reviewed",
        "sampleSize": sample_size,
        "medianHammerToStartingRatio": _rounded_decimal(median(row["ratio"] for row in rows), 4),
        "aboveStartingRate": round(sum(row["hammer"] > row["starting"] for row in rows) / sample_size, 6),
        "atLeastDoubleRate": round(
            sum(row["hammer"] >= row["starting"] * 2 for row in rows) / sample_size,
            6,
        ),
        "medianHammerPriceEur": _rounded_decimal(median(row["hammer"] for row in rows), 0),
        "medianStartingPriceEur": _rounded_decimal(median(row["starting"] for row in rows), 0),
        "hammerPriceMiddle50Eur": _middle_half([row["hammer"] for row in rows], 0),
        "ratioMiddle50": _middle_half([row["ratio"] for row in rows], 4),
        "bidDistribution": [
            {"band": label, "count": count, "share": round(count / sample_size, 6)}
            for label, count in (
                ("below_starting", sum(row["ratio"] < 1 for row in rows)),
                ("at_starting", sum(row["ratio"] == 1 for row in rows)),
                ("above_1_below_1_5", sum(1 < row["ratio"] < Decimal("1.5") for row in rows)),
                ("from_1_5_below_2", sum(Decimal("1.5") <= row["ratio"] < 2 for row in rows)),
                ("at_least_2", sum(row["ratio"] >= 2 for row in rows)),
            )
        ],
    }


def _middle_half(values: Sequence[Decimal], precision: int) -> dict[str, object]:
    """Continuous quartiles, using the same interpolation as PostgreSQL percentile_cont."""
    ordered = sorted(values)

    def quantile(fraction: Decimal) -> object:
        position = Decimal(len(ordered) - 1) * fraction
        lower = int(position)
        upper = min(lower + 1, len(ordered) - 1)
        value = ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)
        return _rounded_decimal(value, precision)

    return {"p25": quantile(Decimal("0.25")), "p75": quantile(Decimal("0.75"))}


def _grouped_aggregates(
    rows: Sequence[dict[str, Any]],
    *,
    key: str,
    minimum_sample: int,
) -> list[dict[str, object]]:
    grouped: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        value = row.get(key)
        if isinstance(value, str) and value:
            grouped[value].append(row)
    result = [
        {"scope": scope, **_aggregate(values, minimum_sample=minimum_sample)}
        for scope, values in grouped.items()
        if len(values) >= minimum_sample
    ]
    return sorted(result, key=lambda item: (-int(item["sampleSize"]), str(item["scope"])))


def _detail_result_date(soup: BeautifulSoup) -> date | None:
    node = soup.select_one(".LegalAd .Date time[datetime]")
    return _coerce_date(node.get("datetime") if isinstance(node, Tag) else None)


def _detail_publication_date(soup: BeautifulSoup) -> date | None:
    node = soup.select_one(".LegalAd .PublishingDate time[datetime]")
    return _coerce_date(node.get("datetime") if isinstance(node, Tag) else None)


def _result_date(value: str) -> date | None:
    match = _FRENCH_RESULT_DATE.search(value)
    if not match:
        return None
    try:
        return date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
    except ValueError:
        return None


def _coerce_date(value: object) -> date | None:
    text = clean_text(value)
    if not text:
        return None
    match = _ISO_DATE.match(text)
    if not match:
        return None
    try:
        return date.fromisoformat(match.group(1))
    except ValueError:
        return None


def _money_values(value: object) -> list[Decimal]:
    text = clean_text(value) or ""
    return [amount for match in _MONEY.finditer(text) if (amount := _money(match.group(1))) is not None]


def _money(value: object) -> Decimal | None:
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        candidate = Decimal(str(value))
        return candidate if candidate.is_finite() else None
    text = clean_text(value)
    if not text:
        return None
    match = _MONEY.search(text)
    candidate = match.group(1) if match else text
    normalized = re.sub(r"[\s\u00a0\u202f]", "", candidate).replace(",", ".")
    try:
        amount = Decimal(normalized)
    except InvalidOperation:
        return None
    return amount if amount.is_finite() else None


def _decimal_string(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(value.quantize(Decimal("0.01")), "f")


def _rounded_decimal(value: Decimal, places: int) -> int | float:
    quantum = Decimal(1).scaleb(-places)
    rounded = value.quantize(quantum, rounding=ROUND_HALF_UP)
    return int(rounded) if places == 0 else float(rounded)


def licitor_window_start(as_of: date) -> date:
    """Inclusive start of the active three-calendar-year acquisition window."""
    return _subtract_calendar_months(as_of, 36)


def _subtract_calendar_months(value: date, months: int) -> date:
    month_index = value.year * 12 + value.month - 1 - months
    year, month_zero = divmod(month_index, 12)
    month = month_zero + 1
    month_days = (date(year + (month == 12), 1 if month == 12 else month + 1, 1) - date(year, month, 1)).days
    return date(year, month, min(value.day, month_days))


def _history_start_urls_for_target_departments() -> tuple[str, ...]:
    aquitaine = {"24", "33", "40", "47", "64"}
    if set(TARGET_DEPARTMENTS).issubset(aquitaine):
        return (LICITOR_HISTORY_ZONE_URLS[4],)
    return LICITOR_HISTORY_ZONE_URLS


def _lot_number(value: str) -> str | None:
    match = re.search(r"\b(\d+)(?:er|e|eme|ème)?\s+(?:au\s+\d+(?:e|eme|ème)?\s+)?lots?", value, re.I)
    return match.group(1) if match else None


def _external_id(value: str) -> str | None:
    return match.group(1) if (match := _PAGE_EXTERNAL_ID.search(urlsplit(value).path)) else None


def _fragment(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-") or "unknown"


def _without_fragment(value: str) -> str:
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def _node_text(node: Tag | None) -> str | None:
    return clean_text(node.get_text(" ", strip=True)) if node else None


def _positive_int(value: object) -> int | None:
    text = clean_text(value)
    return int(text) if text and text.isdigit() and int(text) > 0 else None


def _last_positive_int(value: object) -> int | None:
    text = clean_text(value) or ""
    matches = re.findall(r"\d+", text)
    return int(matches[-1]) if matches and int(matches[-1]) > 0 else None


def _optional_text(value: object) -> str | None:
    return clean_text(value)


def _loosely_same_text(left: object, right: object) -> bool:
    left_text = _fragment(clean_text(left) or "")
    right_text = _fragment(clean_text(right) or "")
    return bool(left_text and right_text and (left_text in right_text or right_text in left_text))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Audit a bounded Licitor historical-results sample after rights approval."
    )
    parser.add_argument("--max-pages-per-zone", type=int, required=True)
    parser.add_argument("--max-details", type=int, default=None)
    parser.add_argument(
        "--authorization-confirmed",
        action="store_true",
        help="Confirm source reuse authorization for this run; retain its actual basis in the run record.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result = scrape_licitor_historical_result(
        max_pages_per_zone=args.max_pages_per_zone,
        max_details=args.max_details,
        authorization_confirmed=args.authorization_confirmed,
    )
    print(
        json.dumps(
            {
                "coverage": result.coverage,
                "errors": result.errors,
                "sales": result.sales,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
