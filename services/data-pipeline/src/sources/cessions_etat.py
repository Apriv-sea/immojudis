from __future__ import annotations

import logging
import re
import ssl
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import certifi
from bs4 import BeautifulSoup, Tag

from src.config import FRENCH_POSTAL_CODE_PATTERN, TARGET_DEPARTMENTS, load_settings
from src.normalize import clean_text
from src.raw_models import validate_raw_sales
from src.sources.common import PaginationCoverage, PoliteHttpClient, ScrapeResult, should_fetch_detail, unique_dicts
from src.sources.image_candidates import html_image_candidates

BASE_URL = "https://cessions.immobilier-etat.gouv.fr"
LIST_URL = f"{BASE_URL}/"
LOGGER = logging.getLogger(__name__)
DETAIL_FIELDS = {
    "description",
    "starting_price_eur",
    "sale_date",
    "visit_dates",
    "documents",
    "raw_text",
    "surface_m2",
    "land_surface_m2",
    "postal_code",
    "raw_image_url",
    "source_images",
    "source_blocks",
}
SURFACE_VALUE_PATTERN = r"([0-9]+(?:[ .][0-9]{3})*(?:[,.][0-9]+)?|[0-9]+(?:[,.][0-9]+)?)"


def cessions_tls_context() -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=certifi.where())
    context.verify_flags &= ~ssl.VERIFY_X509_PARTIAL_CHAIN
    context.load_verify_locations(str(Path(__file__).with_name("certificates") / "sectigo-public-ov-r36.pem"))
    return context


def scrape_cessions_etat_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_cessions_etat_aquitaine_result(max_pages=max_pages).sales


def scrape_cessions_etat_aquitaine_result(
    max_pages: int | None = None, known: dict[str, str] | None = None
) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        tls_context=cessions_tls_context(),
        user_agent=str(settings["browser_user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
        accept="text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        extra_headers={"Upgrade-Insecure-Requests": "1"},
    )
    max_pages = max_pages or int(settings["cessions_etat_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = []
    pagination = PaginationCoverage()
    for page_url in _list_urls(max_pages):
        try:
            html = client.get(page_url)
        except Exception as exc:
            LOGGER.error("Cessions Etat list fetch failed for %s: %s", page_url, exc)
            errors.append(f"{page_url}: {exc}")
            break
        page_sales = parse_cessions_etat_html(html, page_url=page_url)
        if not pagination.accept(page_sales):
            break
        for sale in page_sales:
            if sale.get("department") not in TARGET_DEPARTMENTS:
                continue
            if should_fetch_detail(sale, known):
                _enrich_sale_from_detail(client, sale, errors)
            raw_sales.append(sale)

    return ScrapeResult(
        validate_raw_sales("cessions_etat", unique_dicts(raw_sales, "source_url"), errors),
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(), **pagination.metrics()},
    )


def parse_cessions_etat_html(html: str, page_url: str = LIST_URL) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for card in soup.select("div[id^='bien-'][data-url]"):
        sale = _parse_card(card, page_url)
        if sale:
            sales.append(sale)
    return sales


def parse_cessions_etat_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    raw_text = "\n".join(
        line for line in (clean_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line
    )
    description = _description(soup)
    surface = _extract_surface(raw_text)
    land_surface = _extract_land_surface(raw_text)
    postal_code = _extract_postal(raw_text)
    starting_price = _extract_after(
        raw_text,
        r"(?:Prix\s*:?\s*|Prix\s+de\s+vente\s*:\s*|Mise a prix\s*:?\s*|Mise à prix\s*:?\s*)"
        r"([0-9][0-9\s.,]+)\s*(?:€|euros?)",
    )
    sale_date = _extract_sale_date(raw_text)
    visit_dates = _visit_dates(raw_text)
    documents = _documents(soup, source_url)
    source_images = _extract_images(soup, source_url)
    return {
        "source_name": "cessions_etat",
        "source_url": source_url,
        "description": description,
        "surface_m2": surface,
        "land_surface_m2": land_surface,
        "postal_code": postal_code,
        "starting_price_eur": starting_price,
        "sale_date": sale_date,
        "visit_dates": visit_dates,
        "documents": documents,
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
        "raw_text": raw_text,
        "source_blocks": {
            key: value
            for key, value in {
                "description": description,
                "surface": surface,
                "surface_terrain": land_surface,
                "code_postal": postal_code,
                "mise_a_prix": starting_price,
                "date_vente": sale_date,
                "visites": " | ".join(visit_dates) if visit_dates else None,
                "documents": "; ".join(document["label"] for document in documents if document.get("label")) or None,
                "page_text": raw_text,
            }.items()
            if value
        },
    }


def _parse_card(card: Tag, page_url: str) -> dict[str, Any] | None:
    source_url = urljoin(page_url, str(card.get("data-url") or ""))
    if not source_url:
        return None
    raw_text = "\n".join(
        line for line in (clean_text(part) for part in card.get_text("\n", strip=True).splitlines()) if line
    )
    title = clean_text(card.get("data-titre")) or _node_text(card.select_one(".fr-card__title"))
    city, department = _location(clean_text(card.get("data-localisation")) or raw_text)
    postal_code = _extract_postal(raw_text)
    surface = _extract_surface(raw_text)
    reference = _extract_after(raw_text, r"R[ée]f[ée]rence\s*:\s*([^\n]+)")
    property_type = clean_text(card.get("data-type-bien"))
    land_surface = surface if _is_land_property_type(property_type) else None
    image = _first_image(card, page_url)
    return {
        "source_name": "cessions_etat",
        "source_url": source_url,
        "external_id": str(card.get("data-nid") or card.get("node_id") or card.get("id") or source_url),
        "department": department,
        "city": city,
        "postal_code": postal_code,
        "surface_m2": surface,
        "land_surface_m2": land_surface,
        "property_type": property_type,
        "title": title,
        "description": title,
        "latitude": card.get("data-lat") or None,
        "longitude": card.get("data-lng") or None,
        "status": "past" if re.search(r"\bexpir[ée]\b", raw_text, re.I) else "unknown",
        "documents": [],
        "raw_text": raw_text,
        "raw_image_url": image,
        "source_blocks": {
            key: value
            for key, value in {
                "reference": reference,
                "titre": title,
                "type_bien": property_type,
                "ville": city,
                "departement": department,
                "code_postal": postal_code,
                "surface": surface,
                "surface_terrain": land_surface,
                "page_text": raw_text,
            }.items()
            if value
        },
    }


def _list_urls(max_pages: int) -> list[str]:
    urls = [LIST_URL]
    for index in range(1, max_pages):
        urls.append(f"{LIST_URL}?page={index}")
    return urls


def _enrich_sale_from_detail(client: PoliteHttpClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not source_url.startswith(BASE_URL):
        return
    try:
        html = client.get(source_url)
    except Exception as exc:
        LOGGER.warning("Cessions Etat detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        return
    sale["source_detail_status"] = "complete"
    detail = parse_cessions_etat_detail_html(html, source_url)
    for key in DETAIL_FIELDS:
        value = detail.get(key)
        if not value:
            continue
        if key == "source_blocks":
            existing_blocks = sale.get("source_blocks") if isinstance(sale.get("source_blocks"), dict) else {}
            sale["source_blocks"] = {**existing_blocks, **value}
        elif key == "raw_text":
            sale["raw_text"] = _join_unique_lines(sale.get("raw_text"), value)
        elif key == "source_images":
            sale["source_images"] = _unique_text_values(
                [*_as_text_list(sale.get("source_images")), *_as_text_list(value)]
            )
            if not sale.get("raw_image_url") and sale["source_images"]:
                sale["raw_image_url"] = sale["source_images"][0]
        elif key == "raw_image_url" and not sale.get("raw_image_url"):
            sale[key] = value
        elif key in {"documents", "description", "sale_date", "visit_dates"} or not sale.get(key):
            sale[key] = value


def _location(text: str | None) -> tuple[str | None, str | None]:
    if not text:
        return None, None
    match = re.search(r"(.+?)\s*-\s*(\d{2,3})\b", text)
    if not match:
        return None, None
    return clean_text(match.group(1)), match.group(2)


def _first_image(card: Tag, page_url: str) -> str | None:
    image = card.find("img")
    if image:
        if candidates := html_image_candidates(image):
            return urljoin(page_url, candidates[0])
    images = str(card.get("data-images") or "").split(",")
    return urljoin(page_url, images[0]) if images and images[0].strip() else None


def _description(soup: BeautifulSoup) -> str | None:
    for selector in ("#panel-bien .texte .fr-text", ".field--name-body", ".fr-card__desc", "article"):
        node = soup.select_one(selector)
        if node:
            text = clean_text(node.get_text(" ", strip=True))
            if text:
                return text
    return None


def _documents(soup: BeautifulSoup, page_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href") or "")
        text = clean_text(link.get_text(" ", strip=True)) or href.rsplit("/", 1)[-1]
        if not _looks_like_document_link(href, text):
            continue
        documents.append({"label": text or "document", "url": urljoin(page_url, href), "type": "pdf" if ".pdf" in href.lower() else "document"})
    return documents


def _extract_images(soup: BeautifulSoup, page_url: str) -> list[str]:
    images: list[str] = []
    for selector in ("meta[property='og:image']", "meta[name='twitter:image']"):
        for node in soup.select(selector):
            _append_image(images, node.get("content"), page_url)
    for node in soup.find_all("img"):
        for candidate in html_image_candidates(node):
            _append_image(images, candidate, page_url)
    return _unique_text_values(images)


def _append_image(images: list[str], value: object | None, page_url: str) -> None:
    image_url = clean_text(value)
    if not image_url or image_url.startswith("data:"):
        return
    absolute = urljoin(page_url, image_url)
    lowered = absolute.lower()
    if re.search(r"\.(?:pdf|svg|ico)(?:[?#].*)?$", lowered):
        return
    if not re.search(r"\.(?:avif|jpe?g|png|webp)(?:[?#].*)?$", lowered):
        return
    if any(marker in lowered for marker in ("logo", "favicon", "pictogramme", "icon-", "/themes/", "/core/")):
        return
    images.append(absolute)


def _looks_like_document_link(href: str, label: str | None) -> bool:
    text = f"{href} {label or ''}".lower()
    if "/qui-nous-sommes/" in text or "/qui-sommes-nous" in text:
        return False
    return bool(
        ".pdf" in text
        or re.search(
            r"\b(?:documents?|dossiers?|cahiers?|consultation|pr[ée]sentation|"
            r"t[ée]l[ée]charg\w*|download\w*|fichiers?|annexes?|r[èe]glement|notice)\b",
            text,
            flags=re.I,
        )
    )


def _visit_dates(text: str) -> list[str]:
    visits: list[str] = []
    for raw_line in text.splitlines():
        line = clean_text(raw_line)
        if not line or _is_virtual_visit_line(line):
            continue
        if re.fullmatch(r"visites?\s+libres?\.?", line, flags=re.I):
            visits.append(line)
            continue
        label_match = re.match(r"^(?:Visites?|Rendez-vous)\s*:\s*(.+)$", line, flags=re.I)
        if label_match:
            value = clean_text(label_match.group(1))
        elif _looks_like_visit_instruction(line):
            value = line
        else:
            value = None
        if not value or _is_virtual_visit_line(value) or value in visits:
            continue
        visits.append(value)
    return visits


def _extract_surface(text: str) -> str | None:
    for pattern in (
        rf"\bSurface\s+en\s+m(?:²|2)\s*:?\s*{SURFACE_VALUE_PATTERN}\b",
        rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
    ):
        match = re.search(pattern, text, flags=re.I)
        if match:
            return _normalize_surface_number(match.group(1))
    return None


def _extract_land_surface(text: str) -> str | None:
    for pattern in (
        rf"\bterrain\s+d['’]une\s+superficie\s+(?:totale\s+)?de\s+{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
        rf"\bterrain\s+d['’]une\s+surface\s+(?:totale\s+)?de\s+{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
        rf"\bsuperficie\s+totale\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
    ):
        match = re.search(pattern, text, flags=re.I)
        if match:
            return _normalize_surface_number(match.group(1))
    return None


def _extract_sale_date(text: str) -> str | None:
    adjudication = re.search(r"Date\s+d[’']adjudication\s*:\s*(\d{2}/\d{2}/\d{4})", text, re.I)
    if adjudication:
        from src.normalize import parse_french_datetime
        date_text = adjudication.group(1)
        expected = parse_french_datetime(date_text)
        # Only attach an hour from the procedure comment on the same sale day.
        for line in text[adjudication.end():].splitlines()[:5]:
            if not line.lower().startswith("commentaire"):
                continue
            candidate = parse_french_datetime(line)
            hour = re.search(r"\b(\d{1,2})[h:](\d{2})\b", line)
            if candidate and expected and candidate.date() == expected.date() and hour:
                return f"{date_text} à {hour.group(1)}h{hour.group(2)}"
        return date_text
    for pattern in (
        r"\bdate\s+limite\s+de\s+r[ée]ception\s+des\s+offres\s+est\s+fix[ée]e?\s+au\s+([^\n.]+)",
        r"\b(?:Date limite|Fin de candidature|Cl[oô]ture)\s*:\s*([^\n]+)",
    ):
        match = re.search(pattern, text, flags=re.I)
        if match:
            return clean_text(match.group(1).strip(" .;"))
    return None


def _normalize_surface_number(value: str) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    text = text.replace(" ", "")
    if "," not in text and re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        text = text.replace(".", "")
    return text


def _looks_like_visit_instruction(text: str) -> bool:
    return bool(
        re.search(
            r"\b(?:visite\s+(?:group[ée]e|obligatoire|est\s+obligatoire|sur\s+place|pr[ée]vue)|"
            r"sur\s+rendez[-\s]?vous|rendez[-\s]?vous)\b",
            text,
            flags=re.I,
        )
    )


def _is_virtual_visit_line(text: str) -> bool:
    return bool(re.search(r"\b(?:visite\s+virtuelle|virtuelle|partagez\s+la\s+page)\b", text, flags=re.I))


def _is_land_property_type(value: str | None) -> bool:
    return bool(value and re.search(r"\b(?:foncier|terrain|parcelle)\b", value, flags=re.I))


def _join_unique_lines(*blocks: object) -> str | None:
    lines: list[str] = []
    seen: set[str] = set()
    for block in blocks:
        if not block:
            continue
        for raw_line in str(block).splitlines():
            line = clean_text(raw_line)
            if not line:
                continue
            key = line.casefold()
            if key in seen:
                continue
            seen.add(key)
            lines.append(line)
    return "\n".join(lines) or None


def _unique_text_values(values: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        unique.append(text)
    return unique


def _as_text_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item]
    text = clean_text(value)
    return [text] if text else []


def _extract_postal(text: str) -> str | None:
    for raw_line in text.splitlines():
        line = clean_text(raw_line)
        if not line or re.fullmatch(r"\d{5}", line):
            continue
        if re.search(r"\b(?:adresse|localisation|lieu)\b", line, flags=re.I):
            match = re.search(rf"\b({FRENCH_POSTAL_CODE_PATTERN})\b", line)
            if match:
                return match.group(1)
        match = re.search(rf"(?:^|\s-\s)\b({FRENCH_POSTAL_CODE_PATTERN})\s+[A-Za-zÀ-ÖØ-öø-ÿ'-]", line)
        if match:
            return match.group(1)
    return None


def _extract_after(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, flags=re.I)
    return clean_text(match.group(1)) if match else None


def _node_text(node: Tag | None) -> str | None:
    return clean_text(node.get_text(" ", strip=True)) if node else None
