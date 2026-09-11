from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from src.config import TARGET_DEPARTMENTS, load_settings
from src.normalize import (
    LATIN_LETTERS_PATTERN,
    SURFACE_VALUE_PATTERN,
    clean_text,
    extract_department,
    has_rented_occupancy_signal,
    no_lease_occupancy_status,
)
from src.raw_models import validate_raw_sales
from src.sources.common import PaginationCoverage, PoliteHttpClient, ScrapeResult, should_fetch_detail, unique_dicts
from src.sources.image_candidates import html_image_candidates

BASE_URL = "https://www.info-encheres.com"
LIST_URL = f"{BASE_URL}/vente-encheres-immobilieres-annonces.html"
LOGGER = logging.getLogger(__name__)
DETAIL_OVERRIDE_FIELDS = {
    "title",
    "description",
    "address",
    "postal_code",
    "surface_m2",
    "starting_price_eur",
    "sale_date",
    "visit_dates",
    "lawyer_name",
    "lawyer_contact",
    "tribunal",
    "latitude",
    "longitude",
    "occupancy_status",
    "raw_text",
    "raw_image_url",
    "source_images",
}


def scrape_info_encheres_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_info_encheres_aquitaine_result(max_pages=max_pages).sales


def scrape_info_encheres_aquitaine_result(
    max_pages: int | None = None, known: dict[str, str] | None = None
) -> ScrapeResult:
    """Collect Info Encheres judicial real-estate listings for the target departments."""
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    max_pages = max_pages or int(settings["info_encheres_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = []
    pagination = PaginationCoverage()
    for page_url in _list_urls(max_pages):
        try:
            html = client.get(page_url)
        except Exception as exc:
            LOGGER.error("Info Encheres list fetch failed for %s: %s", page_url, exc)
            errors.append(f"{page_url}: {exc}")
            continue
        page_sales = parse_info_encheres_list_html(html, page_url=page_url)
        if not pagination.accept(page_sales):
            break
        for sale in page_sales:
            if sale.get("department") not in TARGET_DEPARTMENTS:
                continue
            if should_fetch_detail(sale, known):
                _enrich_sale_from_detail(client, sale, errors)
            raw_sales.append(sale)
    return ScrapeResult(
        validate_raw_sales("info_encheres", unique_dicts(raw_sales, "source_url"), errors),
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(), **pagination.metrics()},
    )


def parse_info_encheres_list_html(html: str, page_url: str = LIST_URL) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for row in soup.select("tr"):
        cells = [_text(cell.get_text(" ", strip=True)) for cell in row.find_all("td")]
        if len(cells) < 7 or not re.fullmatch(r"\d+", cells[0] or ""):
            continue
        department = cells[2]
        if not department or not re.fullmatch(r"\d{2,3}", department):
            continue
        link = row.find("a", href=True)
        if link is None:
            continue
        source_url = urljoin(f"{BASE_URL}/", str(link["href"]))
        city = _title_case_city(cells[1])
        property_type = cells[3]
        raw_text = "\n".join(
            filter(
                None,
                (
                    f"Reference: {cells[0]}",
                    f"Ville: {city}",
                    f"Departement: {department}",
                    f"Nature: {property_type}",
                    f"Mise a prix: {cells[4]}",
                    f"Vente le: {cells[5]}",
                    f"Avocat: {cells[6]}",
                ),
            )
        )
        sales.append(
            {
                "source_name": "info_encheres",
                "source_url": source_url,
                "external_id": cells[0],
                "department": department,
                "city": city,
                "property_type": property_type,
                "title": _join_title(property_type, city),
                "starting_price_eur": cells[4],
                "sale_date": cells[5],
                "lawyer_name": cells[6],
                "status": "unknown",
                "documents": [],
                "raw_text": raw_text,
            }
        )
    return sales


def parse_info_encheres_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    page_text = "\n".join(
        line for line in (_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line
    )
    details = _extract_key_values(soup)
    address = details.get("adresse")
    postal_code, city = _extract_postal_city(address)
    lawyer_name = _text(soup.select_one(".avocat .nom b").get_text(" ", strip=True)) if soup.select_one(".avocat .nom b") else None
    lawyer_contact = (
        _text(soup.select_one(".avocat .nom .tel").get_text(" ", strip=True)) if soup.select_one(".avocat .nom .tel") else None
    )
    description = _extract_description(soup)
    latitude, longitude = _extract_coordinates(html)
    title = _extract_meta(soup, "title") or (_text(soup.title.get_text(" ", strip=True)) if soup.title else None)
    documents = _extract_documents(soup, source_url)
    source_images = _extract_images(soup, source_url)
    source_blocks = _extract_source_blocks(details, description, lawyer_name, lawyer_contact, documents, page_text)
    raw_text = _build_detail_raw_text(source_blocks)

    return {
        "source_name": "info_encheres",
        "source_url": source_url,
        "external_id": details.get("reference") or _extract_after(page_text, r"\bref[ée]rence\s*:?\s*(\d+)"),
        "department": extract_department(postal_code) or _extract_department_from_url(source_url),
        "city": city,
        "address": address,
        "postal_code": postal_code,
        "property_type": details.get("nature du bien"),
        "title": title,
        "description": description,
        "surface_m2": _extract_surface(description, page_text),
        "starting_price_eur": details.get("mise a prix") or details.get("mise à prix"),
        "sale_date": _sale_date_with_audience_time(details.get("vente le"), description or page_text),
        "visit_dates": [details["date de visite"]] if details.get("date de visite") else [],
        "lawyer_name": lawyer_name,
        "lawyer_contact": lawyer_contact,
        "tribunal": details.get("au tribunal judiciaire de"),
        "latitude": latitude,
        "longitude": longitude,
        "occupancy_status": _extract_occupancy_status(description or page_text),
        "documents": documents,
        "raw_text": raw_text or page_text,
        "source_blocks": source_blocks,
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
    }


def _sale_date_with_audience_time(date_text: str | None, text: str) -> str | None:
    if not date_text or not re.fullmatch(r"\d{2}/\d{2}/\d{4}", date_text.strip()):
        return date_text
    match = re.search(r"audience[^.\n]{0,70}d[ée]bute\s+[àa]\s+(\d{1,2})[hH:](\d{2})?\b", text, re.I)
    if match and int(match.group(1)) < 24 and int(match.group(2) or 0) < 60:
        return f"{date_text} à {match.group(1)}h{match.group(2) or '00'}"
    return date_text


def _list_urls(max_pages: int) -> list[str]:
    urls = [LIST_URL]
    for page_index in range(2, max_pages + 1):
        urls.append(f"{BASE_URL}/recherche.php?1=1&cat=1&snr={page_index}")
    return urls


def _enrich_sale_from_detail(client: PoliteHttpClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not source_url.startswith(BASE_URL):
        return
    try:
        html = client.get(source_url)
    except Exception as exc:
        LOGGER.warning("Info Encheres detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        return
    sale["source_detail_status"] = "complete"
    details = parse_info_encheres_detail_html(html, source_url)
    for key, value in details.items():
        if value in (None, "", []):
            continue
        if key == "documents":
            sale[key] = _merge_documents(sale.get(key), value)
        elif key == "source_images":
            sale[key] = _merge_text_values(sale.get(key), value)
            if not sale.get("raw_image_url") and sale[key]:
                sale["raw_image_url"] = sale[key][0]
        elif key == "raw_image_url":
            if not sale.get("raw_image_url"):
                sale[key] = value
        elif key == "raw_text" and sale.get("raw_text"):
            sale[key] = f"{sale['raw_text']}\n{value}"
        elif key in DETAIL_OVERRIDE_FIELDS:
            sale[key] = value
        elif not sale.get(key):
            sale[key] = value


def _extract_key_values(soup: BeautifulSoup) -> dict[str, str]:
    values: dict[str, str] = {}
    for row in soup.select("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        label = _normalize_label(cells[0].get_text(" ", strip=True))
        value = (
            _extract_tribunal_cell(cells[1])
            if label == "au tribunal judiciaire de"
            else _text(cells[1].get_text(" ", strip=True))
        )
        if label and value:
            values[label] = value
    return values


def _extract_tribunal_cell(cell: object) -> str | None:
    if not hasattr(cell, "stripped_strings"):
        return None
    parts = [_text(part) for part in cell.stripped_strings]
    first_line = next((part for part in parts if part), None)
    if not first_line:
        return None
    city = re.sub(r"^(?:Tribunal\s+Judiciaire\s+de|TJ\s+(?:de\s+)?)\s+", "", first_line, flags=re.I)
    city = re.split(
        r"\s+(?:\d|rue|avenue|av\.?|bd|boulevard|place|cours|all[ée]e|route|chemin)\b|[,.;]",
        city,
        maxsplit=1,
        flags=re.I,
    )[0]
    city = _text(city)
    return f"Tribunal Judiciaire de {city}" if city else None


def _normalize_label(value: str | None) -> str | None:
    text = _text(value)
    if not text:
        return None
    text = (
        text.lower()
        .replace("référence", "reference")
        .replace("mise à prix", "mise a prix")
        .replace(":", "")
        .strip()
    )
    return text or None


def _extract_description(soup: BeautifulSoup) -> str | None:
    for title in soup.find_all(string=re.compile(r"Description", re.I)):
        parent = title.parent
        for _ in range(4):
            if parent is None:
                break
            container = parent.find_next(class_="int2") if hasattr(parent, "find_next") else None
            if container:
                return _text(container.get_text(" ", strip=True))
            parent = parent.parent
    return None


def _extract_source_blocks(
    details: dict[str, str],
    description: str | None,
    lawyer_name: str | None,
    lawyer_contact: str | None,
    documents: list[dict[str, str]],
    page_text: str,
) -> dict[str, str]:
    blocks = {f"detail_{_slug_label(label)}": value for label, value in details.items() if value}
    blocks.update(
        {
            "description": description,
            "avocat": lawyer_name,
            "contact_avocat": lawyer_contact,
            "documents": "; ".join(document["label"] for document in documents if document.get("label")) or None,
            "page_text": page_text,
        }
    )
    return {key: value for key, value in blocks.items() if value}


def _slug_label(value: str) -> str:
    text = value.lower()
    text = (
        text.replace("é", "e")
        .replace("è", "e")
        .replace("ê", "e")
        .replace("à", "a")
        .replace("ù", "u")
        .replace("ç", "c")
    )
    return re.sub(r"[^a-z0-9]+", "_", text).strip("_")


def _build_detail_raw_text(source_blocks: dict[str, str]) -> str | None:
    parts = [
        f"Référence: {source_blocks['detail_reference']}" if source_blocks.get("detail_reference") else None,
        f"Nature: {source_blocks['detail_nature_du_bien']}" if source_blocks.get("detail_nature_du_bien") else None,
        f"Adresse: {source_blocks['detail_adresse']}" if source_blocks.get("detail_adresse") else None,
        f"Mise a prix: {source_blocks['detail_mise_a_prix']}" if source_blocks.get("detail_mise_a_prix") else None,
        f"Vente le: {source_blocks['detail_vente_le']}" if source_blocks.get("detail_vente_le") else None,
        f"Tribunal: {source_blocks['detail_au_tribunal_judiciaire_de']}"
        if source_blocks.get("detail_au_tribunal_judiciaire_de")
        else None,
        f"Visite: {source_blocks['detail_date_de_visite']}" if source_blocks.get("detail_date_de_visite") else None,
        source_blocks.get("description"),
        f"Avocat: {source_blocks['avocat']}" if source_blocks.get("avocat") else None,
        f"Contact: {source_blocks['contact_avocat']}" if source_blocks.get("contact_avocat") else None,
        f"Documents: {source_blocks['documents']}" if source_blocks.get("documents") else None,
    ]
    return "\n".join(part for part in parts if part) or None


def _extract_images(soup: BeautifulSoup, source_url: str) -> list[str]:
    urls: list[str] = []
    for meta in soup.find_all("meta"):
        property_name = _text(meta.get("property") or meta.get("name"))
        if property_name and property_name.lower() in {"og:image", "twitter:image"}:
            _append_image_url(urls, meta.get("content"), source_url)
    for image in soup.find_all("img"):
        for candidate in html_image_candidates(image):
            _append_image_url(urls, candidate, source_url)
    return urls


def _append_image_url(urls: list[str], value: object, source_url: str) -> None:
    src = _text(value)
    if not src:
        return
    absolute = urljoin(source_url, src)
    if not _looks_like_property_image(absolute) or absolute in urls:
        return
    urls.append(absolute)


def _looks_like_property_image(url: str) -> bool:
    text = _normalize_document_text(url)
    if "/pix/" in text:
        return False
    if not re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", text):
        return False
    return not re.search(r"\b(?:logo|favicon|sprite|icon|picto|placeholder|avatar|loader)\b", text)


def _extract_surface(*values: object) -> str | None:
    text = " ".join(str(value) for value in values if value)
    match = re.search(rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b", text, re.I)
    return _normalize_surface_number(match.group(1)) if match else None


def _normalize_surface_number(value: str) -> str | None:
    text = _text(value)
    if not text:
        return None
    text = text.replace(" ", "")
    if "," in text:
        return text.replace(".", "").replace(",", ".")
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        return text.replace(".", "")
    return text


def _extract_occupancy_status(raw_text: str) -> str | None:
    lowered = raw_text.lower()
    if re.search(r"sans\s+droit\s+ni\s+titre|squat", lowered):
        return "squatted"
    if re.search(r"propri[ée]taires?\s+occupants?|occup[ée]s?\s+par\s+les?\s+propri[ée]taires?", lowered):
        return "owner_occupied"
    if re.search(r"libres?\s+(?:de\s+toute\s+occupation|d[\s’\x27]*occupation)|biens?\s+libres?|inoccup[ée]s?|vacants?", lowered):
        return "vacant"
    if no_lease_status := no_lease_occupancy_status(lowered):
        return no_lease_status
    if has_rented_occupancy_signal(lowered):
        return "rented"
    if re.search(r"occup[ée]", lowered):
        return "occupied"
    return None


def _extract_coordinates(html: str) -> tuple[str | None, str | None]:
    lat = _extract_after(html, r"var\s+lat\s*=\s*([0-9.,-]+)")
    lon = _extract_after(html, r"var\s+lon\s*=\s*([0-9.,-]+)")
    return lat, lon


def _extract_documents(soup: BeautifulSoup, source_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href") or "")
        label = _text(link.get_text(" ", strip=True)) or href.rstrip("/").split("/")[-1] or "document"
        if not _looks_like_document_link(href, label):
            continue
        documents.append({"label": label, "url": urljoin(source_url, href), "type": _document_type(label, href)})
    return _merge_documents([], documents)


def _looks_like_document_link(href: str, label: str | None) -> bool:
    text = _normalize_document_text(f"{href} {label or ''}")
    return bool(
        ".pdf" in text
        or re.search(
            r"\b(?:documents?|dossiers?|cahiers?|conditions?|diagnostics?|annexes?|"
            r"pv|pvd|proces\s+verbal|proces-verbal|descriptif|telecharg\w*|download\w*)\b",
            text,
        )
    )


def _document_type(label: str, href: str) -> str:
    searchable = _normalize_document_text(f"{label} {href}")
    if "proces" in searchable or "procès" in searchable or "pv" in searchable:
        return "pv_descriptif"
    if "diagnostic" in searchable:
        return "diagnostics"
    if "cahier" in searchable:
        return "cahier_conditions"
    return "pdf"


def _normalize_document_text(value: str | None) -> str:
    text = clean_text(value) or ""
    return (
        text.lower()
        .replace("é", "e")
        .replace("è", "e")
        .replace("ê", "e")
        .replace("à", "a")
        .replace("â", "a")
        .replace("î", "i")
        .replace("ï", "i")
        .replace("ô", "o")
        .replace("û", "u")
        .replace("ù", "u")
        .replace("ç", "c")
    )


def _merge_documents(existing: object, incoming: list[dict[str, str]]) -> list[dict[str, str]]:
    documents = existing if isinstance(existing, list) else []
    by_url: dict[str, dict[str, str]] = {}
    for document in [*documents, *incoming]:
        if isinstance(document, dict) and document.get("url"):
            by_url[str(document["url"])] = {
                "label": str(document.get("label") or "document"),
                "url": str(document["url"]),
                "type": str(document.get("type") or "pdf"),
            }
    return list(by_url.values())


def _merge_text_values(existing: object, incoming: object) -> list[str]:
    values: list[str] = []
    for item in [*_as_text_list(existing), *_as_text_list(incoming)]:
        if item not in values:
            values.append(item)
    return values


def _as_text_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [value] if _text(value) else []
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := _text(item))]


def _extract_meta(soup: BeautifulSoup, name: str) -> str | None:
    node = soup.find("meta", attrs={"name": name})
    return _text(node.get("content")) if node and node.get("content") else None


def _extract_after(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, re.I)
    return _text(match.group(1)) if match else None


def _extract_postal_city(address: str | None) -> tuple[str | None, str | None]:
    if not address:
        return None, None
    match = re.search(
        rf"\b(\d{{5}})\s+([{LATIN_LETTERS_PATTERN}'’ -]+)\b(?=$|[,.;])",
        address,
    )
    if not match:
        return None, None
    return match.group(1), _title_case_city(match.group(2))


def _extract_department_from_url(source_url: str) -> str | None:
    match = re.search(r"-(\d{2,3})-ref-", source_url)
    return match.group(1) if match else None


def _join_title(property_type: str | None, city: str | None) -> str | None:
    if property_type and city:
        return f"{property_type} à {city}"
    return property_type or city


def _title_case_city(value: str | None) -> str | None:
    text = _text(value)
    return text.title() if text and text.isupper() else text


def _text(value: object | None) -> str | None:
    return clean_text(value)
