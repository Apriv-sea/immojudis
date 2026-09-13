from __future__ import annotations

import json
import logging
import re
import unicodedata
from typing import Any
from urllib.parse import urlencode

import httpx

from src.config import FRANCE_DEPARTMENTS, TARGET_DEPARTMENTS, load_settings
from src.normalize import LATIN_LETTERS_PATTERN, SURFACE_VALUE_PATTERN, clean_text, parse_french_datetime, parse_surface
from src.raw_models import validate_raw_sales
from src.source_checkpoint import CheckpointSales
from src.sources.common import PaginationCoverage, PoliteHttpClient, ScrapeResult, unique_dicts

BASE_URL = "https://www.immobilier.notaires.fr"
API_URL = f"{BASE_URL}/pub-services/inotr-www-annonces/v1/annonces"
TRANSACTION_TYPES = ("VAE", "VNI")
LOGGER = logging.getLogger(__name__)
PROPERTY_TYPE_LABELS = {
    "APP": "appartement",
    "MAI": "maison",
    "TER": "terrain",
    "IMB": "immeuble",
    "LOC": "local commercial",
    "COM": "local commercial",
    "GAR": "parking",
    "PKG": "parking",
}
PROPERTY_BLOCK_KEYS = {
    "APP": "appartement",
    "MAI": "maison",
    "TER": "terrain",
    "IMB": "immeuble",
    "LOC": "local",
    "COM": "local",
}


def scrape_notaires_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_notaires_aquitaine_result(max_pages=max_pages).sales


def scrape_notaires_aquitaine_result(max_pages: int | None = None) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
        accept="application/json,text/plain,*/*",
    )
    max_pages = max_pages or int(settings["notaires_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = CheckpointSales()
    partition_states: list[dict[str, Any]] = []
    inventory_errors: list[str] = []
    for transaction_type in TRANSACTION_TYPES:
        for department in _department_filters():
            pagination = PaginationCoverage()
            state = _new_inventory_partition(transaction_type, department, pagination)
            partition_states.append(state)
            for page in range(1, max_pages + 1):
                url = _api_url(page, transaction_type, department)
                try:
                    payload = client.get(url)
                except httpx.HTTPStatusError as exc:
                    if _is_page_out_of_range_error(exc, page):
                        state["out_of_range"] = True
                        state["reasons"].append(
                            "page_out_of_range_before_advertised_terminal"
                            if state["advertised_pages"] is not None
                            else "page_out_of_range_without_terminal_metadata"
                        )
                        LOGGER.info("Notaires pagination ended at %s", url)
                        break
                    LOGGER.error("Notaires API fetch failed for %s: %s", url, exc)
                    message = f"{url}: {exc}"
                    errors.append(message)
                    inventory_errors.append(message)
                    state["api_errors"].append(message)
                    continue
                except Exception as exc:
                    LOGGER.error("Notaires API fetch failed for %s: %s", url, exc)
                    message = f"{url}: {exc}"
                    errors.append(message)
                    inventory_errors.append(message)
                    state["api_errors"].append(message)
                    continue
                try:
                    metadata = json.loads(payload)
                except (TypeError, ValueError):
                    message = f"{url}: invalid JSON inventory"
                    errors.append(message)
                    inventory_errors.append(message)
                    state["json_valid"] = False
                    state["reasons"].append("invalid_json")
                    break
                if not isinstance(metadata, dict) or not isinstance(metadata.get("annonceResumeDto"), list):
                    message = f"{url}: missing inventory rows"
                    errors.append(message)
                    inventory_errors.append(message)
                    state["json_valid"] = True
                    state["reasons"].append("inventory_rows_missing")
                    break

                state["json_valid"] = True
                state["metadata_pages_seen"] += 1
                rows = metadata["annonceResumeDto"]
                total = metadata.get("nbTotalAnnonces")
                pages = metadata.get("nbPages")
                valid_total = type(total) is int and total >= 0
                valid_pages = type(pages) is int and pages >= 0
                if valid_total:
                    if state["advertised_total"] is not None and total != state["advertised_total"]:
                        state["reasons"].append("advertised_total_changed")
                    state["advertised_total"] = total
                else:
                    state["metadata_complete"] = False
                    state["reasons"].append(
                        "advertised_total_missing" if total is None else "advertised_total_invalid"
                    )
                if valid_pages:
                    if state["advertised_pages"] is not None and pages != state["advertised_pages"]:
                        state["reasons"].append("advertised_page_count_changed")
                    state["advertised_pages"] = pages
                else:
                    state["metadata_complete"] = False
                    state["reasons"].append(
                        "advertised_page_count_missing" if pages is None else "advertised_page_count_invalid"
                    )
                terminal = bool(valid_pages and (page == pages or (pages == 0 and page == 1)))
                if valid_pages and page > pages and not terminal:
                    state["reasons"].append("page_after_advertised_terminal")
                if terminal:
                    state["terminal_page_seen"] = True

                payload_for_parser = payload if isinstance(payload, (str, bytes, bytearray)) else json.dumps(metadata)
                sales = parse_notaires_json(payload_for_parser)
                state["api_rows_seen"] += len(rows)
                state["unparsed_rows"] += max(0, len(rows) - len(sales))
                if len(rows) != len(sales):
                    state["reasons"].append("api_rows_not_emitted")
                for item in rows:
                    if not isinstance(item, dict) or item.get("typeTransaction") != transaction_type:
                        state["reasons"].append("unexpected_transaction_type")
                        break

                page_urls: set[str] = set()
                for sale in sales:
                    source_url = str(sale.get("source_url") or "")
                    if not source_url:
                        state["reasons"].append("source_url_missing")
                        continue
                    if source_url in page_urls or source_url in state["source_urls"]:
                        state["duplicate_source_urls"].add(source_url)
                    page_urls.add(source_url)

                accepted = pagination.accept(
                    sales,
                    terminal=terminal,
                    expected_total=total if valid_total else None,
                )
                if not accepted:
                    # An empty terminal page is valid when the advertised
                    # total has already been reached.  Other rejected pages
                    # are evidence that the public inventory is incomplete.
                    if not pagination.exhausted:
                        state["reasons"].append(pagination.metrics()["stop_reason"])
                    break
                state["source_emitted_rows"] += len(sales)
                for sale in sales:
                    source_url = str(sale.get("source_url") or "")
                    if source_url:
                        state["source_urls"].add(source_url)
                for sale in sales:
                    # Keep the department advertised by the public inventory
                    # row as the filter key.  Detail enrichment may omit or
                    # rewrite the department; that must not turn an API row
                    # into a successful exclusion after the inventory proof.
                    listing_department = sale.get("department")
                    from src.source_checkpoint import restore_detail
                    if restore_detail(sale):
                        pass
                    elif not _enrich_sale_from_detail(client, sale, errors):
                        sale["_detail_fetch_failed"] = True
                        sale["source_detail_status"] = "failed"
                    else:
                        sale["source_detail_status"] = "complete"
                    source_url = str(sale.get("source_url") or "")
                    effective_department = listing_department or sale.get("department")
                    if effective_department in TARGET_DEPARTMENTS:
                        if source_url:
                            state["in_scope_urls"].add(source_url)
                            state["in_scope_departments"][source_url] = effective_department
                        raw_sales.append(sale)
                    elif source_url:
                        exclusion_department = effective_department
                        reason = (
                            "department_out_of_scope"
                            if exclusion_department
                            else "department_missing"
                        )
                        state["department_exclusions"][source_url] = {
                            "url": source_url,
                            "reason": reason,
                            "department": exclusion_department,
                            "configured_departments": sorted(TARGET_DEPARTMENTS),
                        }
                if pagination.exhausted:
                    break

            _finalize_inventory_partition(state, max_pages=max_pages)

    raw_output_sales = unique_dicts(raw_sales, "source_url")
    validation_error_start = len(errors)
    validated_sales = validate_raw_sales("notaires", raw_output_sales, errors)
    validation_errors = errors[validation_error_start:]
    _record_validated_results(partition_states, validated_sales, validation_errors)
    certificate = _notaires_inventory_certificate(partition_states, inventory_errors)
    partition_metrics = [_notaires_partition_metrics(state) for state in partition_states]
    return ScrapeResult(
        validated_sales,
        errors,
        {
            **getattr(client, "coverage_metrics", lambda: {})(),
            "coverage_complete": certificate["all_discovered_announcements_emitted"],
            "partitions": partition_metrics,
            "certificate": certificate,
            "source_emitted_before_filters": sum(
                state["source_emitted_rows"] for state in partition_states
            ),
            "source_unique_urls_before_filters": sum(
                len(state["source_urls"]) for state in partition_states
            ),
        },
    )


def _new_inventory_partition(
    transaction_type: str,
    department: str | None,
    pagination: PaginationCoverage,
) -> dict[str, Any]:
    """Create the API evidence state for one (transaction, department) query."""
    return {
        "transaction_type": transaction_type,
        "department": department,
        "partition": f"{transaction_type}:{department or 'all'}",
        "pagination": pagination,
        "advertised_total": None,
        "advertised_pages": None,
        "metadata_pages_seen": 0,
        "metadata_complete": True,
        "json_valid": True,
        "api_rows_seen": 0,
        "source_emitted_rows": 0,
        "source_urls": set(),
        "duplicate_source_urls": set(),
        "in_scope_urls": set(),
        "in_scope_departments": {},
        "department_exclusions": {},
        "unhandled_urls": set(),
        "unhandled_reasons": {},
        "returned_validated_urls": set(),
        "validation_failed_urls": set(),
        "unparsed_rows": 0,
        "terminal_page_seen": False,
        "out_of_range": False,
        "api_errors": [],
        "reasons": [],
    }


def _finalize_inventory_partition(state: dict[str, Any], *, max_pages: int) -> None:
    pagination = state["pagination"]
    metrics = pagination.metrics()
    if not pagination.exhausted and metrics["stop_reason"] not in state["reasons"]:
        state["reasons"].append(metrics["stop_reason"])
    if state["advertised_pages"] is not None and not state["terminal_page_seen"]:
        state["reasons"].append("terminal_page_not_reached")
    if pagination.pages_fetched >= max_pages and not pagination.exhausted:
        state["reasons"].append("page_limit_or_count_mismatch")
    if state["advertised_total"] is not None:
        if state["source_emitted_rows"] != state["advertised_total"]:
            state["reasons"].append("source_emitted_count_mismatch")
        if len(state["source_urls"]) != state["advertised_total"]:
            state["reasons"].append("unique_source_url_count_mismatch")
    # Keep reasons deterministic and JSON-friendly for audit output.
    state["reasons"] = list(dict.fromkeys(state["reasons"]))


def _validation_error_urls(errors: list[str]) -> set[str]:
    urls: set[str] = set()
    for error in errors:
        if not error.startswith("validation "):
            continue
        marker = error[len("validation "):]
        url, separator, _ = marker.partition(": ")
        if separator and url:
            urls.add(url)
    return urls


def _record_validated_results(
    partition_states: list[dict[str, Any]],
    validated_sales: list[dict[str, Any]],
    validation_errors: list[str],
) -> None:
    """Attach final returned URLs to their API partition after one validation pass."""
    validated_urls = {
        str(sale.get("source_url") or "")
        for sale in validated_sales
        if sale.get("source_url")
    }
    validation_failed_urls = _validation_error_urls(validation_errors)
    for state in partition_states:
        state["returned_validated_urls"].update(
            state["in_scope_urls"] & validated_urls
        )
        state["validation_failed_urls"].update(
            state["in_scope_urls"] & validation_failed_urls
        )
        for _url, exclusion in state["department_exclusions"].items():
            # Department-filtered rows are intentionally outside the returned
            # scope and therefore count as successful, URL-addressed exclusions.
            exclusion.setdefault("successful", True)
        for url in sorted(state["in_scope_urls"] - state["returned_validated_urls"]):
            reason = (
                "validation_failed"
                if url in state["validation_failed_urls"]
                else "returned_validated_missing"
            )
            # A validation failure is a public row that was not returned.  It
            # is deliberately unhandled, rather than a successful exclusion:
            # only an explicit configured-department filter can exclude a URL.
            state["unhandled_urls"].add(url)
            state["unhandled_reasons"][url] = reason


def _notaires_partition_metrics(state: dict[str, Any]) -> dict[str, Any]:
    pagination = state["pagination"]
    metrics = pagination.metrics()
    metrics.update(
        {
            "partition": state["partition"],
            "transaction_type": state["transaction_type"],
            "department": state["department"],
            "api_scope": {
                "transaction_type": state["transaction_type"],
                "department": state["department"],
            },
            "returned_scope": {
                "departments": sorted(TARGET_DEPARTMENTS),
            },
            "advertised_pages": state["advertised_pages"],
            "metadata_pages_seen": state["metadata_pages_seen"],
            "terminal_page_seen": state["terminal_page_seen"],
            "out_of_range": state["out_of_range"],
            "json_valid": state["json_valid"],
            "metadata_complete": state["metadata_complete"],
            "api_rows_seen": state["api_rows_seen"],
            "source_emitted_rows": state["source_emitted_rows"],
            "source_emitted_before_filters": state["source_emitted_rows"],
            "source_unique_urls": len(state["source_urls"]),
            "source_unique_urls_before_filters": len(state["source_urls"]),
            "public_urls": sorted(state["source_urls"]),
            "public_parsed_urls": sorted(state["source_urls"]),
            "public_urls_parsed": sorted(state["source_urls"]),
            "returned_validated_urls": sorted(state["returned_validated_urls"]),
            "in_scope_public_urls": sorted(state["in_scope_urls"]),
            "excluded_urls": [
                {
                    "url": url,
                    "reason": state["department_exclusions"][url]["reason"],
                }
                for url in sorted(state["department_exclusions"])
            ],
            "exclusion_reasons": {
                url: record["reason"]
                for url, record in sorted(state["department_exclusions"].items())
            },
            "exclusions": [
                state["department_exclusions"][url]
                for url in sorted(state["department_exclusions"])
            ],
            "successful_excluded_urls": sorted(
                url
                for url, record in state["department_exclusions"].items()
                if record.get("successful") is True
            ),
            "validation_failed_urls": sorted(state["validation_failed_urls"]),
            "unhandled_urls": sorted(state["unhandled_urls"]),
            "unhandled_reasons": dict(sorted(state["unhandled_reasons"].items())),
            "duplicate_source_urls": sorted(state["duplicate_source_urls"]),
            "unparsed_rows": state["unparsed_rows"],
            "api_errors": list(state["api_errors"]),
            "reasons": list(state["reasons"]),
        }
    )
    return metrics


def _notaires_inventory_certificate(
    partition_states: list[dict[str, Any]],
    inventory_errors: list[str],
) -> dict[str, Any]:
    partitions: list[dict[str, Any]] = []
    for state in partition_states:
        metrics = _notaires_partition_metrics(state)
        public_certified = bool(
            state["metadata_complete"]
            and state["json_valid"]
            and state["advertised_total"] is not None
            and state["advertised_pages"] is not None
            and state["terminal_page_seen"]
            and state["pagination"].exhausted
            and not state["api_errors"]
            and not state["duplicate_source_urls"]
            and state["unparsed_rows"] == 0
            and state["source_emitted_rows"] == state["advertised_total"]
            and len(state["source_urls"]) == state["advertised_total"]
            and not state["reasons"]
        )
        returned_validated_complete = bool(
            public_certified
            and state["in_scope_urls"] <= state["returned_validated_urls"]
            and not state["validation_failed_urls"]
            and not state["unhandled_urls"]
            and all(
                record.get("successful") is True
                for record in state["department_exclusions"].values()
            )
        )
        metrics["public_inventory_certified"] = public_certified
        metrics["returned_validated_complete"] = returned_validated_complete
        metrics["all_discovered_announcements_emitted"] = returned_validated_complete
        metrics["certified"] = public_certified
        partitions.append(metrics)

    public_certified = bool(partitions) and all(
        partition["public_inventory_certified"] for partition in partitions
    ) and not inventory_errors
    all_emitted = bool(partitions) and all(
        partition["all_discovered_announcements_emitted"] for partition in partitions
    ) and not inventory_errors
    public_urls = sorted({url for state in partition_states for url in state["source_urls"]})
    returned_validated_urls = sorted(
        {url for state in partition_states for url in state["returned_validated_urls"]}
    )
    exclusions = {
        url: record["reason"]
        for state in partition_states
        for url, record in state["department_exclusions"].items()
    }
    exclusion_records = [
        state["department_exclusions"][url]
        for state in partition_states
        for url in sorted(state["department_exclusions"])
    ]
    unhandled_urls = sorted({
        url for state in partition_states for url in state["unhandled_urls"]
    })
    unhandled_reasons = {
        url: reason
        for state in partition_states
        for url, reason in state["unhandled_reasons"].items()
    }
    validation_failed_urls = sorted({
        url for state in partition_states for url in state["validation_failed_urls"]
    })
    return {
        "scope": (
            "Public Notaires API inventory partitioned by typeTransaction and "
            "department; source rows are counted before output filters; database persistence is excluded."
        ),
        "scope_detail": (
            "API partitions are certified independently; returned rows are the validated listings "
            "kept for the configured department scope."
        ),
        "partitioning": ["transaction_type", "department"],
        "public_inventory_certified": public_certified,
        # Keep the catalogue-proof vocabulary available to callers that consume
        # multiple source adapters through the same summary shape.
        "public_inventorycertified": public_certified,
        "public_discovery_certified": public_certified,
        "addressable_public_inventory_certified": public_certified,
        "all_discovered_announcements_emitted": all_emitted,
        "database_completeness_certified": False,
        "public_parsed_urls": public_urls,
        "public_urls_parsed": public_urls,
        "returned_validated_urls": returned_validated_urls,
        "excluded_urls": [
            {"url": url, "reason": exclusions[url]}
            for url in sorted(exclusions)
        ],
        "exclusions": exclusion_records,
        "exclusion_reasons": exclusions,
        "unhandled_public_urls": unhandled_urls,
        "unhandled_reasons": unhandled_reasons,
        "validation_failed_urls": validation_failed_urls,
        "discovered_but_not_emitted_count": len(unhandled_urls),
        "discovered_but_not_emitted_urls": unhandled_urls,
        "invalid_exclusion_urls": [],
        "api_scope": {
            "partitioning": ["transaction_type", "department"],
            "description": "Rows advertised by each public Notaires API partition before output filters.",
        },
        "returned_scope": {
            "departments": sorted(TARGET_DEPARTMENTS),
            "description": "Validated rows retained for the configured department scope.",
        },
        "inventory_errors": list(inventory_errors),
        "partitions": partitions,
    }


def _department_filters() -> tuple[str | None, ...]:
    if set(TARGET_DEPARTMENTS) == set(FRANCE_DEPARTMENTS):
        return (None,)
    return TARGET_DEPARTMENTS


def parse_notaires_json(payload: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return []
    rows = data.get("annonceResumeDto") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []

    sales: list[dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, dict) or item.get("typeTransaction") not in TRANSACTION_TYPES:
            continue
        source_url = clean_text(item.get("urlDetailAnnonceFr")) or _fallback_source_url(item)
        raw_text = "\n".join(
            filter(
                None,
                (
                    clean_text(item.get("reference")),
                    clean_text(item.get("descriptionFr")),
                    clean_text(item.get("communeNom")),
                    clean_text(item.get("departementNom")),
                    clean_text(item.get("typeTransaction")),
                ),
            )
        )
        sales.append(
            {
                "source_name": "notaires",
                "source_url": source_url,
                "external_id": str(item.get("annonceId") or item.get("id") or source_url),
                "department": clean_text(item.get("inseeDepartement")),
                "city": clean_text(item.get("communeNom") or item.get("localiteNom")),
                "postal_code": clean_text(item.get("codePostal")),
                "property_type": _property_type_label(item.get("typeBien")),
                "title": _title(item),
                "description": clean_text(item.get("descriptionFr")),
                "surface_m2": item.get("surface"),
                "land_surface_m2": item.get("surfaceTerrain"),
                "rooms_count": item.get("nbPieces"),
                "bedrooms_count": item.get("nbChambres"),
                "starting_price_eur": item.get("prixAffiche") or item.get("premiereOffrePossible"),
                "sale_date": _sale_date(item, item.get("typeTransaction")),
                "source_sale_schedule": _sale_schedule(item, item.get("typeTransaction")),
                "lawyer_contact": clean_text(item.get("telephone")),
                "status": "past" if item.get("bienVendu") == "OUI" else "upcoming",
                "documents": [],
                "raw_text": raw_text,
                "raw_image_url": clean_text(item.get("urlPhotoPrincipale")),
                "source_images": _unique_texts([clean_text(item.get("urlPhotoPrincipale"))]),
                "source_blocks": {
                    "type_transaction": clean_text(item.get("typeTransaction")),
                    "reference": clean_text(item.get("reference")),
                },
            }
        )
    return sales


def parse_notaires_detail_json(payload: str, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}

    source_blocks = (fallback or {}).get("source_blocks")
    source_blocks = source_blocks if isinstance(source_blocks, dict) else {}
    bien = data.get("bien") if isinstance(data.get("bien"), dict) else {}
    transaction_type = clean_text(data.get("typeTransaction")) or clean_text(source_blocks.get("type_transaction"))
    transaction = data.get((transaction_type or "").lower())
    transaction = transaction if isinstance(transaction, dict) else {}
    property_block = _property_block(bien)
    description = _description(transaction)
    description_text = description.get("long") or description.get("short") or ""
    visit = transaction.get("visite") if isinstance(transaction.get("visite"), dict) else {}
    contact = data.get("contact") if isinstance(data.get("contact"), dict) else {}
    postal_code = clean_text(property_block.get("codePostal") or transaction.get("codePostal"))
    city = clean_text(property_block.get("communeNom") or property_block.get("localiteNom") or transaction.get("ville"))
    source_images = _multimedia_images(transaction.get("multimedias"))
    address = _address(property_block, postal_code, city, description_text)
    text_surface, text_surface_evidence = _built_surface_from_text(description_text, description.get("short"))
    generic_text_surface, generic_text_evidence = text_surface, text_surface_evidence
    text_surface, text_surface_evidence = _habitable_surface_from_text(description_text, description.get("short"))
    text_carrez_surface, _ = _carrez_surface_from_text(description_text, description.get("short"))
    api_habitable_surface = _usable_habitable_surface(property_block.get("surfaceHabitable"), description_text)
    if _should_prefer_text_surface(api_habitable_surface, text_surface, text_surface_evidence):
        habitable_surface = text_surface
        habitable_surface_source = "notaires.description.surface_batie"
        habitable_surface_confidence = 0.9
        habitable_surface_evidence = text_surface_evidence
    elif api_habitable_surface is None and text_surface is not None:
        habitable_surface = text_surface
        habitable_surface_source = "notaires.description.surface_batie"
        habitable_surface_confidence = 0.86
        habitable_surface_evidence = text_surface_evidence
    elif api_habitable_surface is not None:
        habitable_surface = api_habitable_surface
        habitable_surface_source = "notaires.surfaceHabitable"
        habitable_surface_confidence = 0.95
        habitable_surface_evidence = text_surface_evidence or f"surfaceHabitable: {habitable_surface} m²"
    else:
        habitable_surface = None
        habitable_surface_source = None
        habitable_surface_confidence = None
        habitable_surface_evidence = None
    api_carrez_surface = _surface_value(property_block.get("surfaceCarrez"))
    carrez_surface = (
        text_carrez_surface
        if _should_prefer_text_surface(api_carrez_surface, text_carrez_surface, "surface Carrez")
        else api_carrez_surface or text_carrez_surface
    )
    source_land_surface = _surface_value(property_block.get("surfaceTerrain"))
    cadastral_surface, cadastral_evidence = _cadastral_surface_from_text(description_text)
    land_surface = source_land_surface or cadastral_surface
    generic_surface = _usable_generic_surface(property_block.get("surface"), land_surface)
    generic_from_text = generic_surface is None and generic_text_surface is not None
    if generic_from_text:
        generic_surface = generic_text_surface
    if source_land_surface is not None:
        land_surface_source = "notaires.surfaceTerrain"
        land_surface_evidence = cadastral_evidence or f"surfaceTerrain: {source_land_surface} m²"
    elif cadastral_surface is not None:
        land_surface_source = "notaires.description.cadastre"
        land_surface_evidence = cadastral_evidence
    else:
        land_surface_source = None
        land_surface_evidence = None
    is_land_only_surface = habitable_surface is None and generic_surface is None and land_surface is not None
    if habitable_surface is not None:
        surface_source = habitable_surface_source
        surface_confidence = habitable_surface_confidence
        surface_evidence = habitable_surface_evidence
    elif generic_surface is not None:
        surface_source = "notaires.description.surface_batie" if generic_from_text else "notaires.surface"
        surface_confidence = 0.8
        surface_evidence = generic_text_evidence if generic_from_text else f"surface: {generic_surface} m²"
    elif is_land_only_surface:
        surface_source = land_surface_source
        surface_confidence = 0.9
        surface_evidence = land_surface_evidence
    else:
        surface_source = None
        surface_confidence = None
        surface_evidence = None
    raw_text = _raw_text(
        [
            clean_text(transaction.get("reference")),
            description_text,
            address,
            city,
            clean_text(property_block.get("departementNom")),
            clean_text(transaction_type),
            clean_text(visit.get("visiteLibre")),
            _contact_text(contact),
        ]
    )

    conflicts = []
    if api_habitable_surface and text_surface and abs(float(api_habitable_surface) - float(text_surface)) > max(1, float(text_surface) * 0.01):
        source_url = (fallback or {}).get("source_url") or f"{API_URL}/{data.get('id', '')}"
        conflicts.append({"code": "source_surface_disagreement", "field": "habitable_surface_m2",
            "selected": habitable_surface, "alternative": text_surface if habitable_surface != text_surface else api_habitable_surface,
            "selected_source": source_url, "alternative_source": source_url,
            "evidence": {"api_surfaceHabitable": api_habitable_surface, "description": text_surface_evidence}})
    latitude, longitude = _coordinates(property_block)
    return {
        "source_conflicts": conflicts,
        "department": clean_text(property_block.get("inseeDepartement")),
        "city": city,
        "postal_code": postal_code,
        "address": address,
        "property_type": _property_type_from_detail(
            property_block.get("typeBien") or bien.get("typeBien"),
            description.get("short"),
            description_text,
        ),
        "title": description.get("short"),
        "description": description.get("long") or description.get("short"),
        "surface_m2": habitable_surface or generic_surface,
        "habitable_surface_m2": habitable_surface,
        "carrez_surface_m2": carrez_surface,
        "land_surface_m2": land_surface,
        "surface_source": surface_source,
        "surface_confidence": surface_confidence,
        "surface_evidence": surface_evidence,
        "rooms_count": property_block.get("nbPieces"),
        "bedrooms_count": property_block.get("nbChambres") or _bedrooms_from_text(description_text),
        "bathrooms_count": property_block.get("nbSdb") or _bathrooms_from_text(description_text),
        "parking_count": property_block.get("nbStationnements"),
        "has_garden": _yes_no(property_block.get("jardin")),
        "has_terrace": _yes_no(property_block.get("terrasse")),
        "has_garage": _first_known(
            _has_word(description_text, "garage"),
            _yes_no(property_block.get("boxFerme")),
            _yes_no(property_block.get("stationnement")),
        ),
        "has_pool": _yes_no(property_block.get("piscine")),
        "has_air_conditioning": _yes_no(property_block.get("climatisation")),
        "starting_price_eur": transaction.get("miseAPrix")
        or transaction.get("premierPrix")
        or transaction.get("prixMin"),
        "sale_date": _sale_date(transaction, transaction_type),
        "source_sale_schedule": _sale_schedule(transaction, transaction_type),
        "visit_dates": _visit_dates(visit),
        "lawyer_name": _notary_from_text(description_text)
        or clean_text(contact.get("nom") or visit.get("visiteNomContact")),
        "lawyer_contact": _contact_text(contact) or clean_text(visit.get("visiteContact")),
        "status": _status(transaction),
        "latitude": latitude,
        "longitude": longitude,
        "occupancy_status": clean_text(property_block.get("situationLocative")),
        "risk_notes": _risk_notes(description_text),
        "raw_text": raw_text,
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
        "source_blocks": {
            "type_transaction": transaction_type,
            "reference": clean_text(transaction.get("reference")),
            "source_updated_at": clean_text(transaction.get("dateMaj") or data.get("dateMaj")),
            "type_adjudication": clean_text(transaction.get("typeAdjudication")),
            "origine_judiciaire": clean_text(transaction.get("origineJudiciaire")),
            "consignation": transaction.get("consignation"),
            "auction_location": _address(transaction, clean_text(transaction.get("codePostal")), clean_text(transaction.get("ville"))),
            "mode_vente": clean_text(transaction.get("modeVente")),
            "surenchere": clean_text(transaction.get("surenchere")),
            "seance_heure_depot": clean_text(transaction.get("seanceHeureDepot")),
            "seance_paiement": clean_text(transaction.get("seancePaiement")),
            "notary_name": _notary_from_text(description_text),
            "usage": clean_text(property_block.get("sousType")),
            "etat": clean_text(property_block.get("etat")),
            "ancien_neuf": clean_text(property_block.get("ancienNeuf")),
            "sous_type": clean_text(property_block.get("sousType")),
            "dpe_classe": clean_text(property_block.get("consommationClasse")),
            "ges_classe": clean_text(property_block.get("emissionGesClasse")),
            "nb_etages": property_block.get("nbEtages"),
            "detail_enriched": True,
        },
    }


def _api_url(page: int, transaction_type: str, department: str | None) -> str:
    params = {"page": page, "parPage": 24, "typeTransactions": transaction_type}
    if department:
        params["departements"] = department
    if transaction_type == "VAE":
        params["isProchainesVae"] = "true"
    return f"{API_URL}?{urlencode(params)}"


def _detail_api_url(sale: dict[str, Any]) -> str | None:
    external_id = clean_text(sale.get("external_id"))
    return f"{API_URL}/{external_id}" if external_id else None


def _is_page_out_of_range_error(exc: httpx.HTTPStatusError, page: int) -> bool:
    if page <= 1 or exc.response is None or exc.response.status_code != 400:
        return False
    text = unicodedata.normalize("NFKD", exc.response.text or "")
    normalized = text.encode("ascii", "ignore").decode("ascii").lower()
    return "numero de page demande" in normalized and "superieur au nombre de" in normalized


def _sale_date(transaction: dict, transaction_type: str | None):
    if transaction_type == 'VNI':
        return transaction.get('dateFinEncheres') or transaction.get('dateDebutEncheres') or transaction.get('seanceDate')
    return transaction.get('seanceDate') or transaction.get('dateFinEncheres') or transaction.get('dateDebutEncheres')


def _sale_schedule(transaction: dict, transaction_type: str | None) -> dict | None:
    if transaction_type != 'VNI' and not transaction.get('dateDebutEncheres') and not transaction.get('dateFinEncheres'):
        return None
    start = parse_french_datetime(transaction.get('dateDebutEncheres'))
    end = parse_french_datetime(transaction.get('dateFinEncheres'))
    # Keep incomplete intervals explicit: retention must not use the opening date.
    return {'opens_at': start.isoformat() if start else None,
            'closes_at': end.isoformat() if end else None,
            'source': 'notarial_transaction'}


def _enrich_sale_from_detail(client: PoliteHttpClient, sale: dict[str, Any], errors: list[str]) -> bool:
    detail_url = _detail_api_url(sale)
    if not detail_url:
        errors.append(f"missing detail url for {sale.get('source_url')}")
        return False
    try:
        detail = parse_notaires_detail_json(client.get(detail_url), fallback=sale)
    except Exception as exc:
        LOGGER.warning("Notaires detail fetch failed for %s: %s", detail_url, exc)
        errors.append(f"detail {detail_url}: {exc}")
        return False
    if not detail:
        errors.append(f"detail {detail_url}: empty or invalid JSON")
        return False
    _merge_detail(sale, detail)
    return True


def _merge_detail(sale: dict[str, Any], detail: dict[str, Any]) -> None:
    for key, value in detail.items():
        if value in (None, "", [], {}):
            continue
        if key == "source_blocks" and isinstance(sale.get(key), dict) and isinstance(value, dict):
            sale[key].update({k: v for k, v in value.items() if v not in (None, "")})
        else:
            sale[key] = value


def _title(item: dict[str, Any]) -> str | None:
    description = clean_text(item.get("descriptionFr"))
    if description:
        return description.split("\n", 1)[0][:180]
    parts = [_property_type_label(item.get("typeBien")), clean_text(item.get("communeNom") or item.get("localiteNom"))]
    return " - ".join(part for part in parts if part) or clean_text(item.get("reference"))


def _fallback_source_url(item: dict[str, Any]) -> str:
    marker = item.get("annonceId") or item.get("id") or "unknown"
    return f"{BASE_URL}/fr/annonces-immobilieres-liste?typeTransaction=VENTE,VNI,VAE#annonce-{marker}"


def _property_type_label(value: object | None) -> str | None:
    code = clean_text(value)
    return PROPERTY_TYPE_LABELS.get((code or "").upper(), code)


def _property_type_from_detail(code: object | None, *texts: str | None) -> str | None:
    label = _property_type_label(code)
    code_text = (clean_text(code) or "").upper()
    text = clean_text(" ".join(value for value in texts if value)) or ""
    headline = text[:600]
    if code_text in {"", "MAI", "IMB"} and re.search(r"\b(?:immeuble|ensemble\s+immobilier)\b", headline, re.I):
        return "immeuble"
    if code_text in {"", "MAI"} and re.search(r"\b(?:maison|villa)\b", headline, re.I):
        return "maison"
    return label


def _property_block(value: object | None) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    key = PROPERTY_BLOCK_KEYS.get(str(value.get("typeBien") or "").upper())
    if key and isinstance(value.get(key), dict):
        return value[key]
    for candidate in value.values():
        if isinstance(candidate, dict) and any(
            field in candidate for field in ("adresse4", "surfaceHabitable", "communeNom")
        ):
            return candidate
    return value


def _description(transaction: dict[str, Any]) -> dict[str, str | None]:
    rows = transaction.get("descriptions")
    if not isinstance(rows, list):
        return {"short": None, "long": None}
    for row in rows:
        if isinstance(row, dict) and clean_text(row.get("langue")) == "fr":
            return {"short": clean_text(row.get("descCourte")), "long": clean_text(row.get("descLongue"))}
    return {"short": None, "long": None}


def _address(
    property_block: dict[str, Any],
    postal_code: str | None,
    city: str | None,
    description: str | None = None,
) -> str | None:
    street = clean_text(property_block.get("adresse4") or property_block.get("adresse1"))
    street = street or _street_from_description(description, postal_code, city)
    if not street:
        return None
    locality = " ".join(part for part in (postal_code, city) if part)
    return clean_text(f"{street}, {locality}") if locality else street


def _street_from_description(text: str | None, postal_code: str | None, city: str | None) -> str | None:
    text = clean_text(text)
    if not text or not postal_code or not city:
        return None
    city_pattern = rf"(?:LE\s+|LA\s+|LES\s+|L['’]\s*)?{re.escape(city)}"
    patterns = [
        rf"\b{city_pattern}\s*\(\s*{re.escape(postal_code)}\s*\)\s*[,:;\-–—]?\s+(.+?)"
        rf"(?=\s+(?:Quartier|Maison|Appartement|Terrain|Immeuble|Edifi[ée]|Comprenant|DPE|Mise à prix|Consignation|ABSENCE|Renseignements)\b|[.;]|$)",
        rf"\b(?:adresse|bien sis|bien sise|sis|sise|situ[ée]e?)\s*:?\s*(.+?\b{re.escape(postal_code)}\s+{city_pattern}\b)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            street = _clean_street_candidate(match.group(1), postal_code, city_pattern)
            if street:
                return street
    return None


def _clean_street_candidate(value: str, postal_code: str, city_pattern: str) -> str | None:
    street = clean_text(value)
    if not street:
        return None
    street = re.sub(rf"\b{re.escape(postal_code)}\s+{city_pattern}\b", "", street, flags=re.I)
    street = re.split(
        r"\s+(?:Quartier|Maison|Appartement|Terrain|Immeuble|Edifi[ée]|Comprenant|DPE|Mise à prix|Consignation|ABSENCE|Renseignements)\b",
        street,
        maxsplit=1,
        flags=re.I,
    )[0]
    street = street.strip(" ,:;.-–—")
    if len(street) < 4 or len(street) > 120:
        return None
    if not re.search(
        r"\d|\b(?:rue|avenue|boulevard|bd|chemin|route|impasse|all[ée]e|cours|place|quai|passage|voie|lotissement|lieu-dit|résidence|residence|square)\b",
        street,
        re.I,
    ):
        return None
    return street


def _coordinates(property_block: dict[str, Any]) -> tuple[Any, Any]:
    coords = property_block.get("coordonneesExactesW84")
    if not isinstance(coords, dict):
        return None, None
    return coords.get("coordonneeY"), coords.get("coordonneeX")


def _surface_value(value: object | None) -> int | float | None:
    surface = parse_surface(value)
    if surface is None or surface <= 0:
        return None
    return int(surface) if surface == surface.to_integral_value() else float(surface)


def _usable_habitable_surface(value: object | None, description_text: str | None) -> int | float | None:
    surface = _surface_value(value)
    if surface is None:
        return None
    if surface >= 9:
        return surface
    text = clean_text(description_text) or ""
    if re.search(r"\b(?:surface\s+habitable|m(?:2|²)\s+habitables?|habitables?)\b", text, re.I):
        return surface
    return None


def _should_prefer_text_surface(
    api_surface: object | None,
    text_surface: object | None,
    text_evidence: str | None,
) -> bool:
    if api_surface is None or text_surface is None:
        return False
    try:
        api_value = float(api_surface)
        text_value = float(text_surface)
    except (TypeError, ValueError):
        return False
    if api_value == text_value:
        return False
    if not text_value.is_integer() and int(api_value) == int(text_value):
        return True
    if not text_evidence or min(api_value, text_value) <= 0:
        return False
    ratio = max(api_value, text_value) / min(api_value, text_value)
    explicitly_qualified = bool(
        re.search(
            r"\b(?:surface|superficie)\s+habitable\b|\bm(?:2|²)\s+habitables?\b|\b(?:surface|superficie)\s+(?:loi\s+)?carrez\b",
            text_evidence,
            re.I,
        )
    )
    return text_value >= 9 and ratio >= 1.5 and explicitly_qualified


def _usable_generic_surface(value: object | None, land_surface: object | None) -> int | float | None:
    surface = _surface_value(value)
    if surface is None:
        return None
    if land_surface is not None and surface < 9:
        return None
    return surface


def _habitable_surface_from_text(*values: str | None) -> tuple[int | float | None, str | None]:
    text = clean_text("\n".join(value for value in values if value)) or ""
    patterns = (
        rf"\b(?:surface|superficie)\s+habitable\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
        rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+habitables?\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            if not _is_surface_context_excluded(text, match.start(), match.end()):
                return _surface_value(match.group(1)), _evidence_sentence(text, match.start(), match.end())
    return None, None


def _built_surface_from_text(*values: str | None) -> tuple[int | float | None, str | None]:
    text = clean_text("\n".join(value for value in values if value))
    if not text:
        return None, None
    patterns = (
        rf"\b(?:surface|superficie)\s+habitable\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
        (
            r"\b(?:un|une|l['’]|le|la)?\s*"
            r"(?:immeuble|maison|appartement|local|commerce|ensemble\s+immobilier|bien\s+immobilier)\b"
            r".{0,140}?\b(?:de|d['’]une\s+superficie\s+de|d['’]une\s+surface\s+de)\s+"
            rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b"
        ),
        (
            r"\b(?:maison|immeuble|appartement|local|commerce)\b"
            rf"[^.;\n]{{0,90}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s*(?:environ|env\.?)?\b"
        ),
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            if _is_surface_context_excluded(text, match.start(), match.end()):
                continue
            return _surface_value(match.group(1)), _evidence_sentence(text, match.start(), match.end())
    return None, None


def _carrez_surface_from_text(*values: str | None) -> tuple[int | float | None, str | None]:
    text = clean_text("\n".join(value for value in values if value))
    if not text:
        return None, None
    patterns = (
        rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s*(?:loi\s+)?carrez\b",
        rf"\b(?:surface|superficie)\s+(?:loi\s+)?carrez\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            return _surface_value(match.group(1)), _evidence_sentence(text, match.start(), match.end())
    return None, None


def _is_surface_context_excluded(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 80) : end]
    if re.search(r"\b(?:cadastr[ée]e?|terrain|parcelle|jardin|terrasse|balcon)\b", context, re.I):
        return True
    if re.search(r"\b(?:sous-sol|garage|r[ée]serve|cellier|cave|d[ée]pendance)\b", context, re.I):
        return not re.search(r"\b(?:surface|superficie)\s+habitable\b", context, re.I)
    return False


def _cadastral_surface_from_text(value: str | None) -> tuple[int | float | None, str | None]:
    text = clean_text(value)
    if not text:
        return None, None
    patterns = (
        rf"\bcadastr[ée]e?.{{0,140}}?\b(?:total|superficie|contenance)\b.{{0,30}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
        rf"\bsection\s+[A-Z]{{1,4}}\s*(?:n[°o]\s*)?[0-9A-Z]+.{{0,100}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.S)
        if match:
            return _surface_value(match.group(1)), _evidence_sentence(text, match.start(), match.end())
    return None, None


def _evidence_sentence(text: str, start: int, end: int) -> str:
    before = text.rfind(".", 0, start)
    before = text.rfind("\n", 0, start) if before == -1 else before
    after = text.find(".", end)
    after = len(text) if after == -1 else after + 1
    return clean_text(text[max(0, before + 1) : after]) or text[start:end]


def _multimedia_images(value: object | None) -> list[str]:
    if not isinstance(value, list):
        return []
    images: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        for candidate in (
            item.get("urlHighestResolution"),
            (item.get("qxga") or {}).get("url") if isinstance(item.get("qxga"), dict) else None,
            (item.get("vga") or {}).get("url") if isinstance(item.get("vga"), dict) else None,
        ):
            url = clean_text(candidate)
            if url:
                images.append(url)
                break
    return _unique_texts(images)


def _visit_dates(visit: dict[str, Any]) -> list[str]:
    return _unique_texts([*_visit_texts(visit.get("visiteLibre")), *_visit_texts(visit.get("visiteFixe"))])


def _visit_texts(value: object | None) -> list[str | None]:
    if isinstance(value, list):
        texts: list[str | None] = []
        for item in value:
            texts.extend(_visit_texts(item))
        return texts
    if isinstance(value, dict):
        return []
    text = clean_text(value)
    if not text or _is_visit_ui_state(text):
        return []
    return [text]


def _is_visit_ui_state(value: str) -> bool:
    text = value.strip()
    if not (text.startswith("[") or text.startswith("{")):
        return False
    return bool(re.search(r"['\"]?opened['\"]?\s*:\s*(?:true|false)", text, re.I))


def _contact_text(contact: dict[str, Any]) -> str | None:
    return clean_text(" | ".join(part for part in (contact.get("telephone"), contact.get("mail")) if clean_text(part)))


def _notary_from_text(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(
        rf"\b(?ai:M(?:e|a[iîÎ]tre))\s+"
        rf"([{LATIN_LETTERS_PATTERN}][{LATIN_LETTERS_PATTERN}'’ -]+?),\s+notaire\b",
        text,
    )
    return clean_text(f"Me {match.group(1)}") if match else None


def _status(transaction: dict[str, Any]) -> str:
    if transaction.get("bienVendu") == "OUI":
        return "past"
    if transaction.get("venteReportee") == "OUI" or transaction.get("bienRetire") == "OUI":
        return "unknown"
    return "upcoming"


def _bedrooms_from_text(value: str | None) -> int | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"\b([1-9][0-9]?)\s*chambres?\b", text, re.I)
    return int(match.group(1)) if match else None


def _bathrooms_from_text(value: str | None) -> int | None:
    text = clean_text(value)
    if not text:
        return None
    matches = re.findall(r"\bsalle\s+(?:d['’ ]eau|de\s+bains?)\b", text, re.I)
    return len(matches) or None


def _has_word(value: str | None, word: str) -> bool | None:
    text = clean_text(value)
    if not text:
        return None
    return bool(re.search(rf"\b{re.escape(word)}s?\b", text, re.I))


def _risk_notes(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    notes = []
    if re.search(r"\barr[êe]t[ée]\s+de\s+p[ée]ril\b", text, re.I):
        notes.append("Arrêté de péril")
    if re.search(r"\babsence\s+de\s+visite\b", text, re.I):
        notes.append("Absence de visite")
    if re.search(r"\bdpe\s*:?\s+non\s+soumis\b", text, re.I):
        notes.append("DPE non soumis")
    return "; ".join(notes) or None


def _yes_no(value: object | None) -> bool | None:
    text = clean_text(value)
    if text == "OUI":
        return True
    if text == "NON":
        return False
    return None


def _first_known(*values: bool | None) -> bool | None:
    for value in values:
        if value is not None:
            return value
    return None


def _raw_text(values: list[str | None]) -> str | None:
    return clean_text("\n".join(value for value in values if value))


def _unique_texts(values: list[str | None]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))
