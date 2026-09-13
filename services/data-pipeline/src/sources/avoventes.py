from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from src.catalogue_proof import CatalogueEvidence, canonical
from src.config import TARGET_DEPARTMENTS, load_settings
from src.normalize import clean_text, extract_department
from src.raw_models import validate_raw_sales
from src.source_checkpoint import CheckpointSales
from src.sources.common import PoliteHttpClient, ScrapeResult, is_allowed_origin_url
from src.sources.image_candidates import html_image_candidates

BASE_URL = "https://avoventes.fr"
SEARCH_URL = f"{BASE_URL}/recherche"
ALLOWED_ORIGINS = (BASE_URL, "https://www.avoventes.fr")
LOGGER = logging.getLogger(__name__)


class AvoventesClient(PoliteHttpClient):
    def __init__(self, user_agent: str, delay_seconds: float, timeout_seconds: float):
        super().__init__(base_url=BASE_URL, user_agent=user_agent,
                         delay_seconds=delay_seconds, timeout_seconds=timeout_seconds,
                         allowed_redirect_origins=ALLOWED_ORIGINS)


def scrape_avoventes_aquitaine() -> list[dict[str, Any]]:
    return scrape_avoventes_aquitaine_result().sales


def scrape_avoventes_aquitaine_result(known: dict[str, str] | None = None) -> ScrapeResult:
    settings = load_settings()
    client = AvoventesClient(
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = CheckpointSales()
    catalogue = CatalogueEvidence("avoventes")
    exclusions: dict[str, str] = {}
    seen_urls: set[str] = set()
    parsed_count = 0
    unresolved_locations: list[str] = []
    # Avoventes ignore le paramètre ?departement= et sert la liste nationale
    # complète sur une seule page : on la récupère une fois et on filtre les
    # départements en local (au lieu de re-télécharger la même page par dépt).
    url = f"{SEARCH_URL}?display=liste&order=asc&sort=date"
    try:
        html = client.get(url)
    except Exception as exc:
        LOGGER.error("Avoventes list fetch failed: %s", exc)
        errors.append(f"list: {exc}")
        html = None
    if html:
        parsed_sales = parse_avoventes_html(html, page_url=url, fallback_department=None)
        # Certify the public national catalogue before applying the configured
        # department filter. The proof itself excludes cards marked ``Vente
        # amiable``; counting only the filtered output would hide omissions.
        proof = catalogue.observe(html, url, parsed_sales)
        amicable_urls = set(proof["outside_scope_urls"])
        exclusions.update({source_url: "vente_amiable" for source_url in amicable_urls})
        parsed_count = len(parsed_sales)
        for sale in parsed_sales:
            source_url = canonical(str(sale.get("source_url") or ""))
            if source_url in amicable_urls:
                continue
            postal_code = sale.get("postal_code")
            department = extract_department(str(postal_code) if postal_code else None)
            from src.source_checkpoint import restore_detail
            detail_checked = restore_detail(sale)
            department = sale.get("department") or extract_department(sale.get("postal_code")) or department
            if not department and not detail_checked:
                _enrich_sale_from_detail(client, sale, errors)
                detail_checked = True
                department = sale.get("department") or extract_department(sale.get("postal_code"))
            if not department:
                unresolved_locations.append(str(sale["source_url"]))
                continue
            if department not in TARGET_DEPARTMENTS:
                exclusions[source_url] = "department_filter"
                continue
            sale["department"] = department
            if sale["source_url"] in seen_urls:
                continue
            seen_urls.add(sale["source_url"])
            # Avoventes keeps photos and several detail fields off the list page;
            # always refresh the detail page after filtering to the target territory.
            if not detail_checked:
                _enrich_sale_from_detail(client, sale, errors)
            raw_sales.append(sale)
    validated_sales = validate_raw_sales("avoventes", raw_sales, errors)
    catalogue_metrics = catalogue.metrics(
        validated_sales,
        errors,
        exclusions=exclusions,
        scope={"public": "national", "configured": "target_departments"},
    )
    return ScrapeResult(
        validated_sales,
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(),
         "inventory_before_department_filter": parsed_count,
         "unresolved_location_count": len(unresolved_locations),
         "unresolved_location_urls": unresolved_locations,
         **catalogue_metrics},
    )


def parse_avoventes_html(
    html: str, page_url: str = SEARCH_URL, fallback_department: str | None = None
) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sale_nodes = _find_sale_nodes(soup)
    if not sale_nodes:
        text = soup.get_text("\n", strip=True)
        return [_parse_text_block(text, page_url, fallback_department)] if "Mise à prix" in text else []
    parsed_sales = [_parse_sale_node(node, page_url, fallback_department) for node in sale_nodes]
    return [sale for sale in parsed_sales if sale is not None]


def _find_sale_nodes(soup: BeautifulSoup) -> list[Tag]:
    candidates: list[Tag] = [
        node for node in soup.find_all(attrs={"data-link": True}) if "Mise à prix" in node.get_text(" ", strip=True)
    ]
    for price_label in soup.find_all(string=re.compile(r"Mise à prix", re.I)):
        parent = price_label.parent
        for _ in range(6):
            if parent is None:
                break
            text = parent.get_text(" ", strip=True)
            classes = set(parent.get("class") or [])
            if "Mise à prix" in text and ("Date de la vente" in text or parent.get("data-link")):
                if parent.get("data-link") or "row" in classes or parent.name == "article":
                    candidates.append(parent)
                    break
            parent = parent.parent

    unique: list[Tag] = []
    seen: set[int] = set()
    for candidate in candidates:
        marker = id(candidate)
        if marker not in seen:
            seen.add(marker)
            unique.append(candidate)
    return unique


def _parse_sale_node(node: Tag, page_url: str, fallback_department: str | None) -> dict[str, Any] | None:
    raw_text = node.get_text("\n", strip=True)
    links = node.find_all("a", href=True)
    sale_url = urljoin(BASE_URL, str(node.get("data-link") or _choose_sale_url(links, page_url)))
    if not is_allowed_origin_url(sale_url, ALLOWED_ORIGINS):
        LOGGER.warning("Ignoring Avoventes listing with an untrusted source URL: %s", sale_url)
        return None
    documents = _extract_documents(links, page_url)
    return _parse_text_block(raw_text, sale_url, fallback_department, documents=documents)


def _parse_text_block(
    raw_text: str,
    source_url: str,
    fallback_department: str | None,
    documents: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    lines = [line for line in (clean_text(part) for part in raw_text.splitlines()) if line]
    joined = "\n".join(lines)
    title = _extract_title(lines)
    address = _extract_address(lines)
    postal_code, city = _extract_location(address, joined)
    property_type = _extract_property_type(joined)
    starting_price = _extract_after_label(joined, r"Mise à prix(?: initiale)?\s*:?\s*([^\n]+)")
    adjudication_price = _extract_after_label(joined, r"Adjug[ée]\s*:?\s*([0-9][0-9\s,.]*\s*(?:€|euros?)?)")
    sale_date = _extract_after_label(joined, r"Date de la vente\s*:?\s*([^\n]+)")
    visit_dates = _extract_visit_dates(joined)
    lawyer_name = _extract_after_label(joined, r"Cabinet\s*:?\s*([^\n]+)")
    return {
        "source_name": "avoventes",
        "source_url": source_url,
        "external_id": source_url.rstrip("/").split("/")[-1],
        "department": fallback_department or extract_department(postal_code),
        "title": title,
        "address": address,
        "city": city,
        "postal_code": postal_code,
        "property_type": property_type,
        "starting_price_eur": starting_price,
        "adjudication_price_eur": adjudication_price,
        "sale_date": sale_date,
        "visit_dates": visit_dates,
        "lawyer_name": lawyer_name,
        "status": "adjudicated" if adjudication_price else None,
        "documents": documents or [],
        "raw_text": joined,
        "source_blocks": {
            key: value
            for key, value in {
                "titre": title,
                "adresse": address,
                "type_bien": property_type,
                "mise_a_prix": starting_price,
                "prix_adjudication": adjudication_price,
                "date_vente": sale_date,
                "visites": " | ".join(visit_dates) if visit_dates else None,
                "cabinet": lawyer_name,
                "page_text": joined,
            }.items()
            if value
        },
    }


def _choose_sale_url(links: list[Tag], page_url: str) -> str:
    for link in links:
        href = str(link.get("href"))
        if "/enchere/" in href:
            return urljoin(BASE_URL, href)
    for link in links:
        href = str(link.get("href"))
        if href and not href.startswith("#") and not href.lower().endswith(".pdf"):
            return urljoin(BASE_URL, href)
    return page_url


def _extract_documents(links: list[Tag], page_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in links:
        href = str(link.get("href"))
        text = clean_text(link.get_text(" ", strip=True))
        searchable = f"{href} {text or ''}".lower()
        if href.startswith("javascript:") or href.startswith("#"):
            continue
        if ".pdf" in searchable or any(word in searchable for word in ("document", "affiche", "cahier")):
            document_url = urljoin(page_url, href)
            if not is_allowed_origin_url(document_url, ALLOWED_ORIGINS):
                LOGGER.warning("Ignoring Avoventes document with an untrusted URL: %s", document_url)
                continue
            label = text or href.rstrip("/").split("/")[-1] or "document"
            documents.append({"label": label, "url": document_url, "type": _document_type(href, label)})
    return documents


def _enrich_sale_from_detail(client: AvoventesClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not is_allowed_origin_url(source_url, ALLOWED_ORIGINS):
        return
    try:
        html = client.get(source_url)
        details = parse_avoventes_detail_html(html, source_url)
    except Exception as exc:
        LOGGER.warning("Avoventes detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        sale["_detail_fetch_failed"] = True
        sale["source_detail_status"] = "failed"
        return

    sale["source_detail_status"] = "complete"
    if details.get("source_blocks"):
        existing_blocks = sale.get("source_blocks") if isinstance(sale.get("source_blocks"), dict) else {}
        sale["source_blocks"] = {**existing_blocks, **details["source_blocks"]}
    if details.get("title") and _is_generic_title(sale.get("title")):
        sale["title"] = details["title"]
    if details.get("documents"):
        sale["documents"] = _merge_documents(sale.get("documents", []), details["documents"])
    if details.get("source_images"):
        sale["source_images"] = _merge_text_values(sale.get("source_images"), details["source_images"])
        if not sale.get("raw_image_url") and sale["source_images"]:
            sale["raw_image_url"] = sale["source_images"][0]
    elif details.get("raw_image_url") and not sale.get("raw_image_url"):
        sale["raw_image_url"] = details["raw_image_url"]
    if details.get("raw_text"):
        sale["raw_text"] = f"{sale.get('raw_text') or ''}\n{details['raw_text']}".strip()
    for key in ("tribunal", "description", "lawyer_contact", "surface_m2", "adjudication_price_eur", "status", "postal_code", "department"):
        if details.get(key) and (key == "description" or not sale.get(key)):
            sale[key] = details[key]


def parse_avoventes_detail_html(html: str, page_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    if len(soup.select('select option')) > 100 and not soup.select_one('#lightSliderDetails') and not _property_description(soup):
        raise ValueError('Requested detail returned the catalogue/search page; property identity unverified')
    _remove_non_listing_detail_sections(soup)
    raw_text = soup.get_text("\n", strip=True)
    documents = _extract_documents(soup.find_all("a", href=True), page_url)
    images = _extract_images(soup, page_url)
    title = _extract_detail_title(soup, raw_text)
    tribunal = _extract_after_label(raw_text, r"(?:Tribunal\s+Judiciaire|TJ)\s+de?\s*([^\n]+)")
    description = _property_description(soup) or _extract_description(raw_text)
    location = _property_location_codes(description)
    lawyer_contact = _extract_after_label(raw_text, r"(?:Téléphone|Tél\.?|Tel\.?)\s*:?\s*([^\n]+)")
    adjudication_price = _extract_after_label(raw_text, r"Adjug[ée]\s*:?\s*([0-9][0-9\s,.]*\s*(?:€|euros?)?)")
    own_header = re.split(r"[ÀA] propos du bien|Autres biens", raw_text, maxsplit=1, flags=re.I)[0]
    event = None
    for pattern, value in ((r"vente\s+report[ée]e?", "postponed"),
                           (r"vente\s+annul[ée]e?", "cancelled"),
                           (r"vente\s+retir[ée]e?", "withdrawn")):
        if re.search(pattern, own_header, re.I):
            event = value
            break
    surface = _extract_after_label(
        raw_text,
        r"(?:Surface(?:\s+(?:habitable|totale))?|Superficie(?:\s+(?:des\s+)?Lots?\b[^:\n]{0,80})?)\s*:?\s*([0-9\s,.]+)\s*m",
    )
    return {
        **location,
        "documents": documents,
        "source_images": images,
        "raw_image_url": images[0] if images else None,
        "raw_text": raw_text,
        "title": title,
        "tribunal": tribunal,
        "description": description,
        "lawyer_contact": lawyer_contact,
        "adjudication_price_eur": adjudication_price,
        "status": event or ("adjudicated" if adjudication_price else None),
        "surface_m2": surface,
        "source_blocks": {
            key: value
            for key, value in {
                "titre_detail": title,
                "description": description,
                "tribunal": tribunal,
                "contact_avocat": lawyer_contact,
                "prix_adjudication": adjudication_price,
                "surface": surface,
                "documents": "; ".join(document["label"] for document in documents if document.get("label")) or None,
                "page_text": raw_text,
            }.items()
            if value
        },
    }


def _remove_non_listing_detail_sections(soup: BeautifulSoup) -> None:
    """Remove nearby facts without dropping the detail page's own metadata.

    Avoventes appends a heading followed by one or more ``data-link`` cards
    for nearby auctions.  Only the ``Autres biens à proximité`` boundary is
    exhaustive: removing only its first sibling leaves later cards in
    ``get_text()`` and lets their address, price, or sale status contaminate the
    listing being enriched.  The existing one-sibling treatment is retained
    for the plain ``À proximité`` map and ``Valeurs foncières`` table so that
    the listing's complementary facts remain available.
    """
    for heading in list(soup.find_all(["h2", "h3", "h4"])):
        if heading.parent is None:
            continue
        text = clean_text(heading.get_text(" ", strip=True)) or ""
        lowered = text.lower()
        is_other_listing_section = bool(re.search(r"\bautres\s+biens?\s+à\s+proximité\b", lowered))
        is_legacy_excluded_section = "proximité" in lowered or "valeurs foncières" in lowered
        if not (is_other_listing_section or is_legacy_excluded_section):
            continue
        if is_other_listing_section:
            for sibling in list(heading.next_siblings):
                sibling.extract()
        else:
            sibling = heading.find_next_sibling()
            if sibling and sibling.name in {"div", "table"}:
                sibling.decompose()
        heading.decompose()


def _property_location_codes(description: str | None) -> dict[str, str | None]:
    # Restrict inference to the property description, never the lawyer's address.
    text = description or ""
    postals = set(re.findall(r"\((\d{5})\)", text))
    departments = {extract_department(code) for code in postals}
    explicit_departments = set(re.findall(r"\((2[AB]|\d{2,3})\)", text))
    departments.update(explicit_departments)
    departments.discard(None)
    if len(departments) != 1:
        return {}
    return {"department": next(iter(departments)),
            "postal_code": next(iter(postals)) if len(postals) == 1 and not explicit_departments else None}


def _extract_images(soup: BeautifulSoup, page_url: str) -> list[str]:
    images: list[str] = []
    for selector in ("meta[property='og:image']", "meta[name='twitter:image']"):
        for node in soup.select(selector):
            _append_image(images, node.get("content"), page_url)
    for node in soup.select("#lightSliderDetails img, #lightSliderDetails [data-src]"):
        for candidate in html_image_candidates(node):
            _append_image(images, candidate, page_url)
    return _unique_text_values(images)


def _append_image(images: list[str], value: object | None, page_url: str) -> None:
    image_url = clean_text(value)
    if not image_url or image_url.startswith("data:"):
        return
    absolute = urljoin(page_url, image_url)
    if not is_allowed_origin_url(absolute, ALLOWED_ORIGINS):
        return
    lowered = absolute.lower()
    if "/documents/" in lowered or lowered.endswith(".pdf"):
        return
    if not re.search(r"\.(?:avif|jpe?g|png|webp)(?:[?#].*)?$", lowered):
        return
    if "/public/uploads/" not in lowered:
        return
    images.append(absolute)


def _merge_documents(existing: object, incoming: list[dict[str, str]]) -> list[dict[str, str]]:
    documents = existing if isinstance(existing, list) else []
    merged: dict[str, dict[str, str]] = {}
    for document in [*documents, *incoming]:
        if isinstance(document, dict) and document.get("url"):
            merged[str(document["url"])] = {
                "label": str(document.get("label") or "document"),
                "url": str(document["url"]),
                "type": str(
                    document.get("type") or _document_type(str(document["url"]), str(document.get("label") or ""))
                ),
            }
    return list(merged.values())


def _merge_text_values(existing: object, incoming: object) -> list[str]:
    values: list[str] = []
    if isinstance(existing, list):
        values.extend(str(value) for value in existing if value)
    elif existing:
        values.append(str(existing))
    if isinstance(incoming, list):
        values.extend(str(value) for value in incoming if value)
    elif incoming:
        values.append(str(incoming))
    return _unique_text_values(values)


def _unique_text_values(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _document_type(href: str, label: str) -> str:
    text = f"{href} {label}".lower()
    if ".pdf" in text:
        return "pdf"
    return "document"


def _property_description(soup: BeautifulSoup) -> str | None:
    parts: list[str] = []
    for node in soup.find_all(["h2", "h3", "h4", "div"]):
        label = node.get_text(" ", strip=True).strip(" :").lower()
        if label not in {"à propos du bien", "informations complémentaires"}:
            continue
        content = node.find_next_sibling()
        if content:
            value = clean_text(content.get_text(" ", strip=True))
            if value and value not in parts:
                parts.append(value)
    return "\n".join(parts) or None


def _extract_description(raw_text: str) -> str | None:
    lines = [line for line in (clean_text(part) for part in raw_text.splitlines()) if line]
    for index, line in enumerate(lines):
        if re.search(r"Vente aux enchères", line, re.I):
            return clean_text(" ".join(lines[index : index + 6]))
    return None


def _extract_detail_title(soup: BeautifulSoup, raw_text: str) -> str | None:
    for node in soup.find_all(["h1", "h2"]):
        title = clean_text(node.get_text(" ", strip=True))
        if _looks_like_detail_title(title):
            return title

    lines = [line for line in (clean_text(part) for part in raw_text.splitlines()) if line]
    for index, line in enumerate(lines):
        if re.search(r"Vente aux enchères", line, re.I):
            for candidate in reversed(lines[max(0, index - 3) : index]):
                if _looks_like_detail_title(candidate):
                    return candidate
    for candidate in lines[:20]:
        if _looks_like_detail_title(candidate):
            return candidate
    return None


def _looks_like_detail_title(value: str | None) -> bool:
    text = clean_text(value)
    if not text or len(text) < 8:
        return False
    if re.search(
        r"^(?:avoventes\.fr|accueil|annuaire|connexion|retour|vente aux enchères|paramètres|documents?)$",
        text,
        re.I,
    ):
        return False
    return bool(
        re.search(r"\b(?:appartement|maison|immeuble|terrain|parcelle|b[âa]timent|local|garage|commerce)\b", text, re.I)
    )


def _extract_title(lines: list[str]) -> str | None:
    for index, line in enumerate(lines):
        if re.search(r"Vente aux enchères", line, re.I):
            for candidate in lines[index + 1 : index + 6]:
                if _looks_like_list_title(candidate):
                    return candidate
    return lines[0] if lines else None


def _looks_like_list_title(value: str | None) -> bool:
    text = clean_text(value)
    if not text:
        return False
    if re.fullmatch(r"(?:voir\s+la\s+vente|retour\s+vers\s+la\s+liste|autres?)", text, re.I):
        return False
    if re.search(r"^(?:mise à prix|date de la vente|date des visites|cabinet|adjug[ée]|surench[èe]re)\b", text, re.I):
        return False
    if re.search(r"\b\d{5}\b", text):
        return False
    return True


def _is_generic_title(value: object | None) -> bool:
    text = clean_text(value)
    return text is None or text.lower() in {"autres", "autre", "bien", "vente aux enchères"}


def _extract_address(lines: list[str]) -> str | None:
    for line in lines:
        if re.search(r"\b\d{5}\b", line):
            return line
    return None


def _extract_location(address: str | None, raw_text: str) -> tuple[str | None, str | None]:
    text = address or raw_text
    match = re.search(r"\b(\d{5})\s+([^,\n]+)", text)
    if not match:
        # Titles often put the postal code after the city, in parentheses.
        # Keep the code without inventing a city from the rest of the title.
        parenthesized = re.search(r"\((\d{5})\)", text)
        return (parenthesized.group(1), None) if parenthesized else (None, None)
    city = clean_text(match.group(2).replace("France", "").strip(" ,"))
    return match.group(1), city


def _extract_property_type(text: str) -> str | None:
    match = re.search(r"Vente aux enchères\s+([^\n]+)", text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_after_label(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_visit_dates(text: str) -> list[str]:
    match = re.search(
        r"Date des visites\s*:?\s*(.+?)(?:\n(?:Vente aux enchères|Mise à prix|Date de la vente|Cabinet)\b|$)",
        text,
        re.I | re.S,
    )
    if not match:
        return []
    visits = clean_text(match.group(1))
    return [visits] if visits else []
