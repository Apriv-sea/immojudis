from __future__ import annotations

import json
import logging
import re
from datetime import date
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from src.config import TARGET_DEPARTMENTS, load_settings
from src.enrichment.surface_reasoning import extract_surface_facts_from_text
from src.normalize import clean_text, has_rented_occupancy_signal, no_lease_occupancy_status, strip_accents
from src.raw_models import validate_raw_sales
from src.source_checkpoint import CheckpointSales
from src.sources.common import PaginationCoverage, PoliteHttpClient, ScrapeResult, should_fetch_detail, unique_dicts
from src.sources.image_candidates import html_image_candidates

BASE_URL = "https://encheresimmobilieres.fr"
LIST_URL = f"{BASE_URL}/biens-en-vente"
LOGGER = logging.getLogger(__name__)
SALE_ID_MARKER = r"\"id\":"
DETAIL_OVERRIDE_FIELDS = {
    "title",
    "description",
    "address",
    "postal_code",
    "surface_m2",
    "land_surface_m2",
    "starting_price_eur",
    "sale_date",
    "visit_dates",
    "lawyer_name",
    "lawyer_contact",
    "tribunal",
    "occupancy_status",
    "documents",
    "raw_image_url",
    "source_images",
    "raw_text",
    "source_blocks",
}
SHORT_MONTHS = {
    "JANV": "janvier",
    "FÉVR": "février",
    "FEVR": "février",
    "MARS": "mars",
    "AVR": "avril",
    "MAI": "mai",
    "JUIN": "juin",
    "JUIL": "juillet",
    "AOÛT": "août",
    "AOUT": "août",
    "SEPT": "septembre",
    "OCT": "octobre",
    "NOV": "novembre",
    "DÉC": "décembre",
    "DEC": "décembre",
}
MONTH_NUMBERS = {
    "janvier": 1,
    "février": 2,
    "mars": 3,
    "avril": 4,
    "mai": 5,
    "juin": 6,
    "juillet": 7,
    "août": 8,
    "septembre": 9,
    "octobre": 10,
    "novembre": 11,
    "décembre": 12,
}


def scrape_encheres_immobilieres_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_encheres_immobilieres_aquitaine_result(max_pages=max_pages).sales


def scrape_encheres_immobilieres_aquitaine_result(
    max_pages: int | None = None, known: dict[str, str] | None = None
) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    max_pages = max_pages or int(settings["encheres_immobilieres_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = CheckpointSales()
    pagination = PaginationCoverage()
    for page_url in _list_urls(max_pages):
        try:
            html = client.get(page_url)
        except Exception as exc:
            LOGGER.error("EncheresImmobilieres list fetch failed for %s: %s", page_url, exc)
            errors.append(f"{page_url}: {exc}")
            break
        page_sales = parse_encheres_immobilieres_html(html)
        if not pagination.accept(page_sales):
            break
        for sale in page_sales:
            if sale.get("department") in TARGET_DEPARTMENTS:
                if should_fetch_detail(sale, known):
                    _enrich_sale_from_detail(client, sale, errors)
                raw_sales.append(sale)

    return ScrapeResult(
        validate_raw_sales("encheres_immobilieres", unique_dicts(raw_sales, "source_url"), errors),
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(), **pagination.metrics()},
    )


def parse_encheres_immobilieres_html(html: str) -> list[dict[str, Any]]:
    sales: list[dict[str, Any]] = []
    for item in _sale_objects(html):
        sale = _raw_sale(item)
        if sale:
            sales.append(sale)
    sales.extend(_rendered_listing_sales(html))
    return unique_dicts(sales, "source_url")


def parse_encheres_immobilieres_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    lines = _text_lines(soup)
    page_text = "\n".join(lines)
    compact_text = clean_text(page_text) or ""
    title = _detail_title(soup, lines) or _title_from_url(source_url)
    description = _without_template_placeholder(_detail_description(lines))
    address = _detail_asset_address(lines, compact_text)
    city, department = _city_department_from_text(" ".join(filter(None, (title, address))))
    if not department:
        city, department = _city_department_from_text(compact_text)
    postal_code = _extract_postal(address)
    visit_dates = _detail_visit_dates(lines, compact_text)
    lawyer_name, lawyer_contact = _detail_lawyer(lines, compact_text)
    tribunal = _extract_tribunal(compact_text)
    surface = _extract_surface(title, description, compact_text)
    land_surface = _extract_land_surface(description) or _extract_land_surface(title, compact_text)
    price = _extract_price(compact_text)
    sale_date = _extract_sale_date(compact_text)
    external_id = _extract_after(compact_text, r"(?:Annonce\s*n°|Réf\.\s*annonce\s*:)\s*(\d+)")
    documents = _detail_documents(soup, source_url)
    source_images = _detail_images(soup, source_url)
    raw_text = "\n".join(
        part
        for part in (
            title,
            f"Adresse: {address}" if address else None,
            f"Mise a prix: {price}" if price else None,
            f"Date de vente: {sale_date}" if sale_date else None,
            f"Tribunal: {tribunal}" if tribunal else None,
            description,
            f"Visites: {' | '.join(visit_dates)}" if visit_dates else None,
            f"Avocat: {lawyer_name}" if lawyer_name else None,
            f"Contact: {lawyer_contact}" if lawyer_contact else None,
            f"Documents: {'; '.join(document['label'] for document in documents)}" if documents else None,
        )
        if part
    )
    return {
        "source_name": "encheres_immobilieres",
        "source_url": source_url,
        "external_id": external_id or _external_id_from_url(source_url),
        "department": department,
        "city": city,
        "address": address,
        "postal_code": postal_code,
        "property_type": _property_type_from_text(title, description, compact_text),
        "title": title,
        "description": description,
        "surface_m2": surface,
        "land_surface_m2": land_surface,
        "starting_price_eur": price,
        "sale_date": sale_date,
        "visit_dates": visit_dates,
        "lawyer_name": lawyer_name,
        "lawyer_contact": lawyer_contact,
        "tribunal": tribunal,
        "occupancy_status": _occupancy_status(description, compact_text),
        "documents": documents,
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
        "raw_text": raw_text or page_text,
        "source_blocks": {
            key: value
            for key, value in {
                "titre": title,
                "description": description,
                "adresse": address,
                "code_postal": postal_code,
                "ville": city,
                "departement": department,
                "surface": surface,
                "surface_terrain": land_surface,
                "mise_a_prix": price,
                "date_vente": sale_date,
                "visites": " | ".join(visit_dates) if visit_dates else None,
                "avocat": lawyer_name,
                "contact_avocat": lawyer_contact,
                "tribunal": tribunal,
                "occupation": _occupancy_status(description, compact_text),
                "documents": "; ".join(document["label"] for document in documents if document.get("label"))
                or None,
                "page_text": page_text,
            }.items()
            if value not in (None, "", [], {})
        },
    }


def _enrich_sale_from_detail(client: PoliteHttpClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not source_url.startswith(BASE_URL):
        return
    try:
        html = client.get(source_url)
    except Exception as exc:
        LOGGER.warning("EncheresImmobilieres detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        sale["_detail_fetch_failed"] = True
        sale["source_detail_status"] = "failed"
        return
    detail = parse_encheres_immobilieres_detail_html(html, source_url)
    for key in DETAIL_OVERRIDE_FIELDS:
        value = detail.get(key)
        if value in (None, "", []):
            continue
        if key == "source_blocks":
            existing_blocks = sale.get("source_blocks") if isinstance(sale.get("source_blocks"), dict) else {}
            sale["source_blocks"] = {**existing_blocks, **value}
            continue
        if key == "documents":
            sale[key] = _merge_documents(sale.get(key), value)
            continue
        if key == "source_images":
            sale[key] = _merge_text_values(sale.get(key), value)
            if not sale.get("raw_image_url") and sale[key]:
                sale["raw_image_url"] = sale[key][0]
            continue
        if key == "raw_image_url":
            if not sale.get(key):
                sale[key] = value
            continue
        if key == "raw_text" and sale.get("raw_text"):
            sale[key] = f"{sale['raw_text']}\n{value}"
        elif not sale.get(key) or key in {"description", "visit_dates", "lawyer_contact", "tribunal", "occupancy_status"}:
            sale[key] = value


def _rendered_listing_sales(html: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href") or "")
        if not re.search(r"/ventes/\d+", href):
            continue
        source_url = urljoin(BASE_URL, href)
        text = _listing_link_text(link)
        sale = _raw_sale_from_listing_text(text, source_url)
        if sale:
            sales.append(sale)
    return sales


def _listing_link_text(link: Any) -> str | None:
    text = clean_text(link.get_text(" ", strip=True))
    if text and "mise" in text.lower():
        return text
    container = link.find_parent(["article", "li", "div"])
    if container is None:
        return text
    container_text = clean_text(container.get_text(" ", strip=True))
    return container_text if container_text and "mise" in container_text.lower() else text


def _raw_sale_from_listing_text(text: str | None, source_url: str) -> dict[str, Any] | None:
    raw_text = clean_text(re.sub(r"\bVoir\s+le\s+bien\b", "", text or "", flags=re.I))
    if not raw_text:
        return None
    city, department = _city_department_from_text(raw_text)
    if not department:
        return None
    title = _listing_title(raw_text)
    price = _extract_price(raw_text)
    sale_date = _list_sale_date(raw_text)
    tribunal = _extract_tribunal(raw_text)
    surface = _extract_surface(title, raw_text)
    land_surface = _extract_land_surface(title, raw_text)
    return {
        "source_name": "encheres_immobilieres",
        "source_url": source_url,
        "external_id": _external_id_from_url(source_url),
        "department": department,
        "city": city,
        "property_type": _property_type_from_text(title, raw_text),
        "title": title,
        "description": raw_text,
        "surface_m2": surface,
        "land_surface_m2": land_surface,
        "starting_price_eur": price,
        "sale_date": sale_date,
        "tribunal": tribunal,
        "status": "upcoming",
        "documents": [],
        "raw_text": raw_text,
        "source_blocks": {
            key: value
            for key, value in {
                "titre": title,
                "description": raw_text,
                "ville": city,
                "departement": department,
                "surface": surface,
                "surface_terrain": land_surface,
                "mise_a_prix": price,
                "date_vente": sale_date,
                "tribunal": tribunal,
                "page_text": raw_text,
            }.items()
            if value not in (None, "", [], {})
        },
    }


def _text_lines(soup: BeautifulSoup) -> list[str]:
    return [line for line in (clean_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line]


def _detail_documents(soup: BeautifulSoup, source_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href") or "")
        label = clean_text(link.get_text(" ", strip=True)) or href.rstrip("/").rsplit("/", 1)[-1] or "document"
        if not _looks_like_document_link(href, label):
            continue
        documents.append(
            {
                "label": label,
                "url": urljoin(source_url, href),
                "type": "pdf" if ".pdf" in href.lower() else "document",
            }
        )
    return _merge_documents([], documents)


def _detail_images(soup: BeautifulSoup, source_url: str) -> list[str]:
    images: list[str] = []
    for selector in ("meta[property='og:image']", "meta[name='twitter:image']"):
        for node in soup.select(selector):
            _append_image(images, node.get("content"), source_url)
    for image in soup.find_all("img"):
        for candidate in html_image_candidates(image):
            _append_image(images, candidate, source_url)
    return _merge_text_values([], images)


def _looks_like_document_link(href: str, label: str | None) -> bool:
    text = _normalize_text(f"{href} {label or ''}")
    return bool(
        ".pdf" in text
        or re.search(
            r"\b(?:documents?|dossiers?|cahiers?|conditions?|diagnostics?|annexes?|"
            r"pv|pvd|proces\s+verbal|proces-verbal|descriptif|telecharg\w*|download\w*)\b",
            text,
        )
    )


def _merge_documents(existing: object, incoming: object) -> list[dict[str, str]]:
    documents = existing if isinstance(existing, list) else []
    incoming_documents = incoming if isinstance(incoming, list) else []
    merged: dict[str, dict[str, str]] = {}
    for document in [*documents, *incoming_documents]:
        if not isinstance(document, dict) or not document.get("url"):
            continue
        url = str(document["url"])
        merged[url] = {
            "label": str(document.get("label") or "document"),
            "url": url,
            "type": str(document.get("type") or ("pdf" if url.lower().endswith(".pdf") else "document")),
        }
    return list(merged.values())


def _merge_text_values(existing: object, incoming: object) -> list[str]:
    values: list[object] = []
    values.extend(existing if isinstance(existing, list) else [existing])
    values.extend(incoming if isinstance(incoming, list) else [incoming])
    merged: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        merged.append(text)
    return merged


def _append_image(images: list[str], value: object | None, base_url: str = BASE_URL) -> None:
    image_url = clean_text(value)
    if not image_url or image_url.startswith(("data:", "#")):
        return
    absolute = urljoin(base_url, image_url)
    lowered = absolute.lower()
    if re.search(r"\.(?:pdf|svg|ico)(?:$|[?#&])", lowered):
        return
    if not re.search(r"\.(?:avif|jpe?g|png|webp)(?:$|[?#&])", lowered):
        return
    if any(marker in lowered for marker in ("logo", "favicon", "icon-", "/_next/static/", "/assets/")):
        return
    images.append(absolute)


def _detail_title(soup: BeautifulSoup, lines: list[str]) -> str | None:
    heading = soup.find(["h1", "h2"])
    title = clean_text(heading.get_text(" ", strip=True)) if heading else None
    if title:
        return title
    for line in lines:
        if re.search(r"\(\d{2,3}\)", line) and not line.lower().startswith(("vente", "adresse")):
            return line
    return None


def _detail_description(lines: list[str]) -> str | None:
    start = _line_index(lines, "Descriptif du bien")
    if start is None:
        start = _line_index(lines, "Réf. annonce")
    if start is None:
        return None
    parts: list[str] = []
    for line in lines[start + 1 :]:
        normalized = _normalize_text(line)
        if normalized.startswith(
            (
                "avocat poursuivant",
                "informations sommaires",
                "imprimer",
                "partager",
                "descriptionlocalisation",
                "telechargez",
                "agenda des ventes",
            )
        ):
            break
        if normalized in {"mise a prix", "adresse du bien", "date de mise en vente", "adresse de la vente"}:
            continue
        parts.append(line)
    return clean_text(" ".join(parts))


def _detail_asset_address(lines: list[str], compact_text: str) -> str | None:
    address = _line_after_label(lines, "Adresse du bien")
    if address:
        return address
    for line in lines:
        match = re.search(r"^(?:À|A)\s+[A-ZÀ-Ÿ' -]+\s+\(\d{2,3}\),\s*(.+)$", line)
        if match:
            return clean_text(match.group(1))
    match = re.search(r"\b(?:À|A)\s+[A-ZÀ-Ÿ' -]+\s+\(\d{2,3}\),\s*([^.\n]+)", compact_text)
    if match:
        return clean_text(match.group(1))
    match = re.search(r"\b([^.\n,]+,\s*\d{5}\s+[A-ZÀ-Ÿ' -]+)\b", compact_text)
    return clean_text(match.group(1)) if match else None


def _detail_visit_dates(lines: list[str], compact_text: str) -> list[str]:
    visits: list[str] = []
    visit = _line_after_label(lines, "Visite(s) du bien") or _line_after_label(lines, "Dates des visites")
    if visit:
        visits.append(visit)
    for match in re.finditer(
        r"\b(?:le\s+)?((?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4}\s+de\s+\d{1,2}\s*H?\s*(?:\d{2})?\s*[àa]\s+\d{1,2}\s*H?\s*(?:\d{2})?)",
        compact_text,
        re.I,
    ):
        candidate = clean_text(match.group(1))
        if candidate and candidate not in visits:
            visits.append(candidate)
    return visits


def _detail_lawyer(lines: list[str], compact_text: str) -> tuple[str | None, str | None]:
    contact = _extract_phone(compact_text) or _extract_email(compact_text)
    index = _line_index(lines, "Avocat poursuivant")
    if index is not None:
        for line in lines[index + 1 : index + 5]:
            if line and not re.search(r"^(?:\d|T[ée]l|Email|Fax|Informations sommaires)", line, re.I):
                return clean_text(line), contact
    match = re.search(r"\b((?:SCP|SELARL|SELAS|Ma[îi]tre|Me)\b[^.\n]{3,120})", compact_text, re.I)
    return (clean_text(match.group(1)) if match else None), contact


def _line_after_label(lines: list[str], label: str) -> str | None:
    index = _line_index(lines, label)
    if index is None:
        return None
    for line in lines[index + 1 : index + 4]:
        if clean_text(line) and _normalize_text(line) != _normalize_text(label):
            return clean_text(line)
    return None


def _line_index(lines: list[str], label: str) -> int | None:
    normalized_label = _normalize_text(label)
    for index, line in enumerate(lines):
        if _normalize_text(line).startswith(normalized_label):
            return index
    return None


def _listing_title(text: str) -> str | None:
    body = re.sub(r"^\d{1,2}\s+[A-ZÉÈÊÀÂÎÏÔÛÙÇ]{3,}\s+", "", text, flags=re.I)
    body = re.split(r"\bMise\s+[àa]\s+prix\b", body, maxsplit=1, flags=re.I)[0]
    body = re.sub(
        r"^(?:maison|appartement|propri[ée]t[ée]|terrain|parcelles?\s+de\s+terre|parcelles?|magasin|villa|immeuble|parking)\s+",
        "",
        body,
        flags=re.I,
    )
    city_matches = list(re.finditer(r"\b([A-ZÀ-Ÿ][A-ZÀ-Ÿ' -]+)\s+\(\d{2,3}\)", body))
    if city_matches:
        body = body[: city_matches[-1].start()].strip()
    return clean_text(body)


def _city_department_from_text(text: str) -> tuple[str | None, str | None]:
    matches = list(re.finditer(r"\b([A-ZÀ-Ÿ][A-ZÀ-Ÿ' -]+)\s+\((\d{2,3})\)", text))
    if not matches:
        return None, None
    city = clean_text(matches[-1].group(1))
    city = clean_text(re.split(r"\b[àa]\s+", city or "")[-1])
    return (city.title() if city and city.isupper() else city), matches[-1].group(2)


def _extract_postal(text: str | None) -> str | None:
    match = re.search(r"\b(\d{5})\b", text or "")
    return match.group(1) if match else None


def _extract_price(text: str | None) -> str | None:
    match = re.search(r"\bMise\s+[àa]\s+prix\s*:?\s*([0-9][0-9\s.,]+)\s*€", text or "", re.I)
    return clean_text(match.group(1)) if match else None


def _extract_sale_date(text: str | None) -> str | None:
    patterns = (
        r"\bDate\s+de\s+la\s+vente\s*:?\s*((?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\s*\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4}\s+[àa]\s+\d{1,2}h\d{0,2})",
        r"\bDate\s+de\s+mise\s+en\s+vente\s*:?\s*((?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\s*\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4}\s+[àa]\s+\d{1,2}h\d{0,2})",
        r"\bAdjudication\s+le\s+(\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4}\s+[àa]\s+\d{1,2}h\d{0,2})",
    )
    for pattern in patterns:
        match = re.search(pattern, text or "", re.I)
        if match:
            return clean_text(match.group(1))
    return None


def _list_sale_date(text: str | None) -> str | None:
    match = re.search(r"^\s*(\d{1,2})\s+([A-ZÉÈÊÀÂÎÏÔÛÙÇ]{3,})\b", text or "", re.I)
    if not match:
        return None
    month = SHORT_MONTHS.get(_normalize_text(match.group(2)).upper())
    if not month:
        return None
    day = int(match.group(1))
    year = date.today().year
    month_number = MONTH_NUMBERS[month]
    try:
        candidate = date(year, month_number, day)
    except ValueError:
        return None
    if candidate < date.today():
        year += 1
    return f"{day} {month} {year}"


def _extract_tribunal(text: str | None) -> str | None:
    match = re.search(
        r"\bTribunal\s+Judiciaire\s+de\s+([A-Za-zÀ-ÿ' -]+?)(?:\s+-|\s+Voir\s+le\s+bien|\s+Date\b|\s+Adresse\b|$)",
        text or "",
        re.I,
    )
    if not match:
        return None
    city = clean_text(match.group(1))
    return f"Tribunal Judiciaire de {city}" if city else None


def _extract_after(text: str | None, pattern: str) -> str | None:
    match = re.search(pattern, text or "", re.I)
    return clean_text(match.group(1)) if match else None


def _extract_phone(text: str | None) -> str | None:
    match = re.search(r"\b(?:0|\+33\s?)[1-9](?:[\s.()-]?\d{2}){4}\b", text or "")
    return clean_text(match.group(0)) if match else None


def _extract_email(text: str | None) -> str | None:
    match = re.search(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", text or "", re.I)
    return clean_text(match.group(0)) if match else None


def _property_type_from_text(*values: object) -> str | None:
    text = _normalize_text(" ".join(str(value) for value in values if value))
    if re.search(r"\bappartement|studio\b", text):
        return "appartement"
    if re.search(r"\bmaison|villa\b", text):
        return "maison"
    if re.search(r"\bterrain|parcelle|boisee?s?\b", text):
        return "terrain"
    if re.search(r"\bimmeuble\b", text):
        return "immeuble"
    if re.search(r"\bmagasin|local|commerce\b", text):
        return "magasin"
    if re.search(r"\bparking|stationnement|garage\b", text):
        return "parking"
    return None


def _title_from_url(source_url: str) -> str | None:
    slug = source_url.rstrip("/").rsplit("/", 1)[-1]
    slug = re.sub(r"^\d+-", "", slug)
    return clean_text(slug.replace("-", " ").title())


def _external_id_from_url(source_url: str) -> str:
    match = re.search(r"/ventes/(\d+)", source_url)
    return match.group(1) if match else source_url.rstrip("/").rsplit("/", 1)[-1]


def _normalize_text(value: object | None) -> str:
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


def _sale_objects(html: str) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    for candidate in _sale_json_candidates(html):
        try:
            decoded = json.loads(f'"{candidate}"')
            item = json.loads(decoded)
        except json.JSONDecodeError:
            try:
                item = json.loads(candidate)
            except json.JSONDecodeError:
                continue
        if item.get("titre") and item.get("url"):
            objects.append(item)
    return objects


def _sale_json_candidates(html: str) -> list[str]:
    candidates: list[str] = []
    index = 0
    while True:
        marker_index = html.find(SALE_ID_MARKER, index)
        if marker_index == -1:
            break
        start = html.rfind("{", 0, marker_index)
        if start == -1:
            index = marker_index + len(SALE_ID_MARKER)
            continue
        end = _json_object_end(html, start)
        if end is None:
            index = marker_index + len(SALE_ID_MARKER)
            continue
        candidates.append(html[start:end])
        index = end
    return candidates


def _json_object_end(text: str, start: int) -> int | None:
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index + 1
    return None


def _raw_sale(item: dict[str, Any]) -> dict[str, Any] | None:
    slug = str(item.get("url") or "")
    if not slug:
        return None
    description = _without_template_placeholder(_html_text(item.get("complement"))) or _without_template_placeholder(
        clean_text(item.get("description"))
    )
    lawyer = item.get("avocat") if isinstance(item.get("avocat"), dict) else {}
    title = clean_text(item.get("titre"))
    address = _join_address(item.get("adresse"), item.get("codePostal"), item.get("ville"))
    visit_dates = [clean_text(item.get("complementVisite"))] if clean_text(item.get("complementVisite")) else []
    lawyer_name = clean_text(lawyer.get("nom") or item.get("entete"))
    lawyer_contact = clean_text(lawyer.get("tel") or lawyer.get("email"))
    surface = _extract_surface(title, description)
    land_surface = _extract_land_surface(title, description, clean_text(item.get("complement")), clean_text(item.get("ccv")))
    rooms_count = _extract_rooms(title)
    occupancy_status = _occupancy_status(description, clean_text(item.get("description")), clean_text(item.get("complement")))
    source_images = _payload_images(item)
    adjudication_price = item.get("prixAdjudication")
    raw_text = "\n".join(
        filter(
            None,
            (
                title,
                address,
                description,
                _extract_tribunal(clean_text(item.get("tribunal")) or ""),
                clean_text(item.get("entete")),
                clean_text(item.get("ccv")),
                clean_text(item.get("complementVisite")),
            ),
        )
    )
    return {
        "source_name": "encheres_immobilieres",
        "source_url": urljoin(BASE_URL, f"/ventes/{slug}"),
        "external_id": str(item.get("id") or slug),
        "department": clean_text(item.get("departement")),
        "city": clean_text(item.get("ville")),
        "address": address,
        "postal_code": clean_text(item.get("codePostal")),
        "property_type": _property_type(item),
        "title": title,
        "description": description,
        "surface_m2": surface,
        "land_surface_m2": land_surface,
        "rooms_count": rooms_count,
        "starting_price_eur": item.get("prix"),
        "adjudication_price_eur": adjudication_price,
        "sale_date": _date_value(item.get("dateVente")),
        "visit_dates": visit_dates,
        "lawyer_name": lawyer_name,
        "lawyer_contact": lawyer_contact,
        "tribunal": _extract_tribunal(" ".join(str(item.get(key) or "") for key in ("tribunal", "lieuVente", "adresseVente", "ccv"))),
        "latitude": item.get("latitude"),
        "longitude": item.get("longitude"),
        "occupancy_status": occupancy_status,
        "status": _sale_status(adjudication_price, item.get("termine") or item.get("terminee")),
        "documents": [],
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
        "raw_text": raw_text,
        "source_blocks": {
            key: value
            for key, value in {
                "titre": title,
                "description": description,
                "adresse": address,
                "code_postal": clean_text(item.get("codePostal")),
                "ville": clean_text(item.get("ville")),
                "departement": clean_text(item.get("departement")),
                "type_vente": clean_text(item.get("typeVente")),
                "surface": surface,
                "surface_terrain": land_surface,
                "nb_pieces": rooms_count,
                "mise_a_prix": item.get("prix"),
                "prix_adjudication": adjudication_price,
                "date_vente": _date_value(item.get("dateVente")),
                "visites": " | ".join(visit_dates) if visit_dates else None,
                "avocat": lawyer_name,
                "contact_avocat": lawyer_contact,
                "tribunal": _extract_tribunal(" ".join(str(item.get(key) or "") for key in ("tribunal", "lieuVente", "adresseVente", "ccv"))),
                "occupation": occupancy_status,
                "ccv": clean_text(item.get("ccv")),
                "page_text": raw_text,
            }.items()
            if value not in (None, "", [], {})
        },
    }


def _payload_images(item: dict[str, Any]) -> list[str]:
    images: list[str] = []
    media_keys = {
        "image",
        "imageurl",
        "image_url",
        "photo",
        "photourl",
        "photo_url",
        "photos",
        "images",
        "medias",
        "media",
        "multimedias",
        "thumbnail",
        "thumb",
        "visuel",
        "lots",
        "url",
        "src",
        "path",
    }

    def collect(value: object, *, media_context: bool = False) -> None:
        if isinstance(value, str):
            if media_context:
                _append_image(images, value)
            return
        if isinstance(value, list):
            for nested in value:
                collect(nested, media_context=media_context)
            return
        if not isinstance(value, dict):
            return
        for key, nested in value.items():
            normalized_key = str(key).replace("-", "_").lower()
            nested_media_context = media_context or normalized_key in media_keys or any(
                marker in normalized_key for marker in ("image", "photo", "media", "visuel")
            )
            collect(nested, media_context=nested_media_context)

    for key in media_keys:
        if key in item:
            collect(item[key], media_context=True)
    for key, value in item.items():
        normalized_key = str(key).replace("-", "_").lower()
        if any(marker in normalized_key for marker in ("image", "photo", "media", "visuel")):
            collect(value, media_context=True)
    return _merge_text_values([], images)


def _list_urls(max_pages: int) -> list[str]:
    urls = [LIST_URL]
    for page in range(2, max_pages + 1):
        urls.append(f"{LIST_URL}?page={page}")
    return urls


def _html_text(value: Any) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    return clean_text(BeautifulSoup(text, "html.parser").get_text(" ", strip=True))


def _without_template_placeholder(value: str | None) -> str | None:
    text = clean_text(value)
    if text and re.fullmatch(r"\$[a-z0-9][a-z0-9_]*", text, re.I):
        return None
    return text


def _property_type(item: dict[str, Any]) -> str | None:
    title = clean_text(item.get("titre")) or ""
    match = re.search(r"\b(appartement|maison|villa|terrain|parking|stationnement|immeuble|parcelle)", title, re.I)
    return match.group(1) if match else clean_text(item.get("typeVente"))


def _extract_rooms(title: Any) -> int | None:
    # Nombre de pièces déduit du titre : "2P", "T3", "F4"…
    text = clean_text(title) or ""
    match = re.search(r"\b(\d{1,2})\s*[Pp]\b", text) or re.search(r"\b[TF]\s?(\d{1,2})\b", text)
    if not match:
        return None
    value = int(match.group(1))
    return value if 1 <= value <= 20 else None


def _extract_surface(*values: str | None) -> str | None:
    text = " ".join(value for value in (clean_text(v) for v in values) if value)
    asset = extract_surface_facts_from_text(text)
    if asset and asset.explicit_surfaces:
        ranked = {
            "explicit_carrez": 4,
            "explicit_habitable": 3,
            "explicit_total": 2,
            "explicit_built": 1,
        }
        candidate = max(
            asset.explicit_surfaces,
            key=lambda item: (ranked.get(item.kind, 0), item.confidence),
        )
        if candidate.kind in ranked:
            normalized = str(candidate.value_m2.normalize())
            quote = candidate.evidence.quote or ""
            return normalized if normalized in quote else normalized.replace(".", ",")
    # A bare room/annex measurement must never become the property's surface.
    match = re.search(
        r"\b(?:appartement|maison|villa|immeuble|b[âa]timent|local|logement)\b.{0,60}?"
        r"\b(?:de|surface\s+(?:de\s+)?)\s*([0-9][0-9\s.,]+)\s*m(?:2|²)\b",
        text,
        flags=re.I,
    )
    return clean_text(match.group(1)) if match else None


def _extract_land_surface(*values: str | None) -> str | None:
    text = " ".join(value for value in (clean_text(v) for v in values) if value)
    match = re.search(
        r"\b(?:terrain|parcelles?|jardin|contenance|cadastr[ée]e?).{0,120}?([0-9][0-9\s.,]+)\s*m(?:2|²)\b",
        text,
        flags=re.I,
    )
    if match:
        return clean_text(match.group(1))
    matches = re.findall(r"\b(\d{1,5})\s*a(?:\s*(\d{1,2})\s*ca)?\b", text, flags=re.I)
    if not matches or not re.search(r"\b(?:parcelles?|contenance|cadastr[ée]e?|terrain)\b", text, re.I):
        return None
    total = sum(int(ares) * 100 + int(centiares or 0) for ares, centiares in matches)
    return str(total) if total else None


def _date_value(value: Any) -> str | None:
    text = clean_text(value)
    return text[2:] if text and text.startswith("$D") else text


def _sale_status(adjudication_price: object | None, ended: object | None) -> str:
    if adjudication_price not in (None, ""):
        return "adjudicated"
    return "past" if ended else "upcoming"


def _occupancy_status(*values: str | None) -> str | None:
    text = strip_accents(" ".join(value for value in (clean_text(v) for v in values) if value)).lower()
    if not text:
        return None
    if re.search(r"sans\s+droit\s+ni\s+titre|squat", text):
        return "squatted"
    if re.search(r"proprietaire\s+occupant|occupe(?:e?s?)?\s+par\s+le\s+proprietaire", text):
        return "owner_occupied"
    if re.search(
        r"libre\s+(?:de\s+toute\s+occupation|d['’]occupation)|"
        r"bien\s+libre|"
        r"\b(?:appartement|maison|immeuble|local|logement)\s+libre\b|"
        r"inoccupe(?:e?s?)?|vacant",
        text,
    ):
        return "vacant"
    if no_lease_status := no_lease_occupancy_status(text):
        return no_lease_status
    if has_rented_occupancy_signal(text):
        return "rented"
    if re.search(r"\boccupe(?:e?s?)?\b", text):
        return "occupied"
    return None


def _join_address(address: Any, postal_code: Any, city: Any) -> str | None:
    parts = [clean_text(address), clean_text(postal_code), clean_text(city)]
    return ", ".join(part for part in parts if part) or None
