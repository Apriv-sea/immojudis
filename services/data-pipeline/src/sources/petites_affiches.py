from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup, Tag

from src.catalogue_proof import CatalogueEvidence
from src.config import FRANCE_DEPARTMENTS, FRENCH_POSTAL_CODE_PATTERN, TARGET_DEPARTMENTS, load_settings
from src.normalize import SURFACE_VALUE_PATTERN, clean_text
from src.raw_models import validate_raw_sales
from src.source_checkpoint import CheckpointSales
from src.sources.common import PoliteHttpClient, ScrapeResult, should_fetch_detail, unique_dicts
from src.sources.image_candidates import html_image_candidates
from src.sources.linked_pages import LinkedPages

BASE_URL = "https://www.petitesaffiches.fr"
LIST_URL = f"{BASE_URL}/encheres-immobilieres/"
LOGGER = logging.getLogger(__name__)
DETAIL_FIELDS = {
    "description",
    "address",
    "postal_code",
    "surface_m2",
    "starting_price_eur",
    "lawyer_name",
    "lawyer_contact",
    "tribunal",
    "visit_dates",
    "documents",
    "raw_text",
    "source_blocks",
    "raw_image_url",
    "source_images",
}


def scrape_petites_affiches_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_petites_affiches_aquitaine_result(max_pages=max_pages).sales


def scrape_petites_affiches_aquitaine_result(
    max_pages: int | None = None, known: dict[str, str] | None = None
) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["browser_user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
        accept="text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        extra_headers={"Origin": BASE_URL, "Referer": LIST_URL},
    )

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = CheckpointSales()
    partitions: list[dict[str, Any]] = []
    catalogue = CatalogueEvidence("petites_affiches")
    seen_sales: set[str] = set()
    for department in _department_filters():
        partition = f"department:{department or 'all'}"
        pages = LinkedPages(LIST_URL, "", 1, max_pages or 100,
                            path_pattern=r"/encheres-immobilieres/ventes-aux-encheres-immobilieres-p(\d+)\.html")
        for page_url in pages:
            try:
                html = (_fetch_listing(client, department) if page_url == LIST_URL
                        else _fetch_listing(client, department, page_url))
            except Exception as exc:
                LOGGER.error("Petites Affiches list fetch failed for %s: %s", page_url, exc)
                errors.append(f"{page_url}: {exc}")
                break
            pages.observe(html, page_url)
            page_sales = parse_petites_affiches_html(html, page_url=page_url, fallback_department=department)
            # Certify every department POST before the global URL deduplication.
            # A URL repeated by two department partitions is still evidence in
            # both public catalogues and must not hide a partial partition.
            catalogue.observe(html, page_url, page_sales, partition=partition)
            for sale in page_sales:
                url = str(sale.get("source_url"))
                if url in seen_sales:
                    continue
                seen_sales.add(url)
                if should_fetch_detail(sale, known):
                    _enrich_sale_from_detail(client, sale, errors)
                raw_sales.append(sale)
        partitions.append({"department": department, "partition": partition, **pages.metrics()})

    pagination_incomplete = [item for item in partitions if not item["linked_pages_complete"]]
    pagination_metrics = {
        "coverage_complete": False if pagination_incomplete else None,
        "stop_reason": "partition_pagination_incomplete" if pagination_incomplete else "published_links_exhausted",
    }
    validated_sales = validate_raw_sales("petites_affiches", unique_dicts(raw_sales, "source_url"), errors)
    catalogue_metrics = catalogue.metrics(
        validated_sales,
        errors,
        coverage=pagination_metrics,
        scope={"public": "configured_departments", "configured": "target_departments"},
    )

    return ScrapeResult(
        validated_sales,
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(),
         **pagination_metrics,
         "partitions": partitions,
         "linked_pages_complete": not pagination_incomplete,
         **catalogue_metrics},
    )


def _department_filters() -> tuple[str | None, ...]:
    if set(TARGET_DEPARTMENTS) == set(FRANCE_DEPARTMENTS):
        return (None,)
    return TARGET_DEPARTMENTS


def _fetch_listing(client: PoliteHttpClient, department: str | None, page_url: str = LIST_URL) -> str:
    form = {"historique": "0"}
    if department is not None:
        form["select_dep"] = department
    try:
        return client.post_form(page_url, form)
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code if exc.response is not None else None
        if department is None and status in {403, 405, 406, 415, 429}:
            LOGGER.warning("Petites Affiches POST refused with %s; falling back to national GET listing", status)
            return client.get(page_url)
        raise


def parse_petites_affiches_html(
    html: str,
    page_url: str = LIST_URL,
    fallback_department: str | None = None,
) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for card in soup.select("div[class*='annonce_lot_']"):
        sale = _parse_card(card, page_url, fallback_department)
        if sale:
            sales.append(sale)
    return sales


def _parse_card(card: Tag, page_url: str, fallback_department: str | None) -> dict[str, Any] | None:
    link = card.select_one(".titreVente a[href]") or card.select_one(".imgList a[href]")
    if link is None:
        return None
    source_url = urljoin(page_url, str(link.get("href")))
    raw_text = "\n".join(
        line for line in (clean_text(part) for part in card.get_text("\n", strip=True).splitlines()) if line
    )
    title, reference, property_type = _title_reference_type(link.get_text(" ", strip=True))
    property_type = _property_type_from_title(title) or property_type
    image = card.select_one(".imgList img")
    image_url = urljoin(page_url, str(image.get("data-src") or image.get("src"))) if image else None
    tribunal = _node_text(card.select_one(".lieuVente strong"))
    city = _node_text(card.select_one(".lot-adresse"))

    return {
        "source_name": "petites_affiches",
        "source_url": source_url,
        "external_id": _external_id(card, source_url),
        "department": fallback_department,
        "city": city,
        "property_type": property_type,
        "title": title,
        "description": title,
        "starting_price_eur": _node_text(card.select_one(".miseAPrix strong")),
        "sale_date": _node_text(card.select_one(".dateVente strong")),
        "surface_m2": _extract_surface(raw_text),
        "postal_code": _extract_postal(raw_text),
        "lawyer_name": _extract_lawyer(raw_text),
        "tribunal": tribunal,
        "status": "upcoming",
        "documents": [],
        "raw_text": raw_text,
        "raw_image_url": image_url,
        "source_images": [image_url] if image_url else [],
        "source_blocks": {"reference": reference, "type_vente": _node_text(card.select_one(".typeVente strong"))},
    }


def parse_petites_affiches_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    page_text = "\n".join(
        line for line in (clean_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line
    )
    detail_text = _scoped_text(soup.select_one(".row.detail")) or page_text
    contact_text = _scoped_text(soup.select_one(".contact-container")) or page_text
    address = _detail_address(soup)
    description = _meta_description(soup)
    price = _extract_price(detail_text)
    tribunal = _detail_tribunal(soup)
    lawyer_name = _extract_lawyer(contact_text)
    lawyer_contact = _extract_phone(contact_text)
    visit_dates = _detail_visits(page_text)
    documents = _detail_documents(soup, source_url)
    source_images = _detail_images(soup, source_url)
    blocks = [
        description,
        f"Adresse: {address}" if address else None,
        f"Mise a prix: {price}" if price else None,
        f"Tribunal: {tribunal}" if tribunal else None,
        f"Avocat: {lawyer_name}" if lawyer_name else None,
        f"Contact: {lawyer_contact}" if lawyer_contact else None,
        f"Visites: {' | '.join(visit_dates)}" if visit_dates else None,
        f"Documents: {'; '.join(document['label'] for document in documents)}" if documents else None,
    ]
    return {
        "source_name": "petites_affiches",
        "source_url": source_url,
        "description": description,
        "address": address,
        "postal_code": _extract_postal(address or ""),
        "surface_m2": _extract_surface(detail_text),
        "starting_price_eur": price,
        "lawyer_name": lawyer_name,
        "lawyer_contact": lawyer_contact,
        "tribunal": tribunal,
        "visit_dates": visit_dates,
        "documents": documents,
        "raw_text": "\n".join(part for part in blocks if part),
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
        "source_blocks": {
            key: value
            for key, value in {
                "description": description,
                "adresse": address,
                "mise_a_prix": price,
                "tribunal": tribunal,
                "avocat": lawyer_name,
                "contact_avocat": lawyer_contact,
                "visites": " | ".join(visit_dates) if visit_dates else None,
                "documents": "; ".join(document["label"] for document in documents if document.get("label"))
                or None,
                "page_text": page_text,
            }.items()
            if value
        },
    }


def _enrich_sale_from_detail(client: PoliteHttpClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not source_url.startswith(BASE_URL):
        return
    try:
        html = client.get(source_url)
    except Exception as exc:
        LOGGER.warning("Petites Affiches detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        sale["_detail_fetch_failed"] = True
        sale["source_detail_status"] = "failed"
        return
    access_text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
    restricted = re.search(
        r"(?:r[ée]serv[ée]e?\s+aux\s+abonn[ée]s|vous\s+devez\s+[êe]tre\s+abonn[ée])", access_text, re.I,
    )
    sale["source_detail_status"] = "restricted" if restricted else "complete"
    detail = parse_petites_affiches_detail_html(html, source_url)
    for key in DETAIL_FIELDS:
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
        if key == "raw_image_url" and not sale.get("raw_image_url"):
            sale[key] = value
            continue
        if key == "raw_text" and sale.get("raw_text"):
            sale[key] = f"{sale['raw_text']}\n{value}"
        elif not sale.get(key):
            sale[key] = value


def _title_reference_type(text: str) -> tuple[str | None, str | None, str | None]:
    text = clean_text(text)
    if not text:
        return None, None, None
    title = re.split(r"\bRef\.\s*:", text, maxsplit=1, flags=re.I)[0].strip()
    ref_match = re.search(r"Ref\.\s*:\s*([0-9]+)\s*-\s*([^|]+)$", text, re.I)
    if not ref_match:
        return title, None, None
    return title, ref_match.group(1).strip(), clean_text(ref_match.group(2))


def _property_type_from_title(title: str | None) -> str | None:
    text = _normalized_text(title)
    if not text:
        return None
    if re.search(r"\bappartement\b", text):
        return "Appartement"
    if re.search(r"\bmaison\b", text):
        return "Maison"
    if re.search(r"\b(?:terrain|parcelle)\b", text):
        return "Terrain"
    if re.search(r"\bensemble\s+immobilier\b", text):
        return "Ensemble immobilier"
    if re.search(r"\bimmeuble\b", text):
        return "Immeuble"
    if re.search(r"\b(?:magasin|local\s+commercial|commerce)\b", text):
        return "Magasin"
    if re.search(r"\b(?:emplacement\s+de\s+)?(?:stationnement|parking|garage)\b", text):
        return "Stationnement"
    return None


def _external_id(card: Tag, source_url: str) -> str:
    for class_name in card.get("class") or []:
        match = re.search(r"annonce_lot_(\d+)", str(class_name))
        if match:
            return match.group(1)
    match = re.search(r"-(\d+)\.html", source_url)
    return match.group(1) if match else source_url.rstrip("/").split("/")[-1]


def _extract_surface(text: str) -> str | None:
    match = re.search(rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b", text, re.I)
    return _normalize_surface_number(match.group(1)) if match else None


def _normalize_surface_number(value: str) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    text = text.replace(" ", "")
    if "," in text:
        return text.replace(".", "")
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        return text.replace(".", "")
    return text


def _extract_price(text: str) -> str | None:
    match = re.search(r"Mise\s*[àa]\s*Prix\s*:?\s*([0-9][0-9\s.,]+)\s*€", text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_postal(text: str) -> str | None:
    match = re.search(rf"\b({FRENCH_POSTAL_CODE_PATTERN})\b", text)
    return match.group(1) if match else None


def _extract_lawyer(text: str) -> str | None:
    match = re.search(r"\b(?:Ma[îi]tre|SELARL|SELAS|SCP)\b[^\n|]{0,80}", text, re.I)
    return clean_text(match.group(0)) if match else None


def _extract_phone(text: str) -> str | None:
    match = re.search(r"\b(?:0|\+33\s?)[1-9](?:[\s.()-]?\d{2}){4}\b", text)
    return clean_text(match.group(0)) if match else None


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
    urls: list[str] = []
    for meta in soup.find_all("meta"):
        property_name = clean_text(meta.get("property") or meta.get("name"))
        if property_name and property_name.lower() in {"og:image", "twitter:image"}:
            _append_image_url(urls, meta.get("content"), source_url)
    for image in soup.find_all("img"):
        for candidate in html_image_candidates(image):
            _append_image_url(urls, candidate, source_url)
    return urls


def _append_image_url(urls: list[str], value: object, source_url: str) -> None:
    src = clean_text(value)
    if not src:
        return
    absolute = urljoin(source_url, src)
    if not _looks_like_property_image(absolute) or absolute in urls:
        return
    urls.append(absolute)


def _looks_like_property_image(url: str) -> bool:
    text = _normalized_text(url)
    if any(marker in text for marker in ("captcha", "/squelettes/", "kiosque")):
        return False
    if not re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", text):
        return False
    return not re.search(r"\b(?:logo|favicon|sprite|icon|picto|placeholder|avatar|loader)\b", text)


def _looks_like_document_link(href: str, label: str | None) -> bool:
    text = _normalized_text(f"{href} {label or ''}")
    if "cgv" in text or "conditions-generales-de-vente" in text:
        return False
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
    values: list[str] = []
    for item in [*_as_text_list(existing), *_as_text_list(incoming)]:
        if item not in values:
            values.append(item)
    return values


def _as_text_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [value] if clean_text(value) else []
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := clean_text(item))]


def _detail_visits(page_text: str) -> list[str]:
    lines = [line for line in (clean_text(part) for part in page_text.splitlines()) if line]
    visits: list[str] = []
    for index, line in enumerate(lines):
        if _normalized_text(line) != "visites":
            continue
        parts: list[str] = []
        for next_line in lines[index + 1 : index + 8]:
            normalized = _normalized_text(next_line)
            if normalized.startswith(("adresse", "demander plus", "avocat poursuivant", "lieu de vente")):
                break
            if normalized in {"visites"}:
                continue
            parts.append(next_line)
        visit = clean_text(" ".join(parts))
        if visit and visit not in visits:
            visits.append(visit)
    return visits


def _detail_address(soup: BeautifulSoup) -> str | None:
    node = soup.select_one(".lot-adresse h4")
    text = clean_text(node.get_text(" ", strip=True)) if node else None
    if not text:
        return None
    return clean_text(re.sub(r"^Adresse\s*:\s*", "", text, flags=re.I))


def _detail_tribunal(soup: BeautifulSoup) -> str | None:
    node = soup.select_one(".lieu-vente strong a") or soup.select_one(".lieu-vente strong")
    return clean_text(node.get_text(" ", strip=True)) if node else None


def _meta_description(soup: BeautifulSoup) -> str | None:
    node = soup.find("meta", attrs={"name": "description"})
    return clean_text(node.get("content")) if node and node.get("content") else None


def _scoped_text(node: Tag | None) -> str | None:
    if node is None:
        return None
    return "\n".join(line for line in (clean_text(part) for part in node.get_text("\n", strip=True).splitlines()) if line)


def _node_text(node: Tag | None) -> str | None:
    return clean_text(node.get_text(" ", strip=True)) if node else None


def _normalized_text(value: str | None) -> str:
    text = clean_text(value) or ""
    return (
        text.lower()
        .replace("é", "e")
        .replace("è", "e")
        .replace("ê", "e")
        .replace("à", "a")
        .replace("î", "i")
    )
