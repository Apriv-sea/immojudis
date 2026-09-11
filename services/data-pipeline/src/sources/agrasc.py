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
from src.normalize import clean_text, extract_department, strip_accents
from src.raw_models import validate_raw_sales
from src.sources.agrasc_operators import enrich_agrasc_operator
from src.sources.common import PoliteHttpClient, ScrapeResult, unique_dicts
from src.sources.image_candidates import html_image_candidates
from src.sources.linked_pages import LinkedPages

BASE_URL = "https://agrasc.gouv.fr"
LIST_URL = f"{BASE_URL}/ventes-aux-encheres"
LOGGER = logging.getLogger(__name__)
SURFACE_VALUE_PATTERN = r"([0-9]+(?:[ .][0-9]{3})*(?:[,.][0-9]+)?|[0-9]+(?:[,.][0-9]+)?)"
URL_CITY_PREFIXES = {
    "appartement",
    "bien",
    "en",
    "immobilier",
    "immeuble",
    "local",
    "maison",
    "terrain",
    "vente",
    "villa",
}


def agrasc_tls_context() -> ssl.SSLContext:
    # Supply the omitted intermediate, while still requiring a trusted root.
    context = ssl.create_default_context(cafile=certifi.where())
    context.verify_flags &= ~ssl.VERIFY_X509_PARTIAL_CHAIN
    context.load_verify_locations(str(Path(__file__).with_name("certificates") / "sectigo-qualified-r39.pem"))
    return context


def scrape_agrasc_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_agrasc_aquitaine_result(max_pages=max_pages).sales


def scrape_agrasc_aquitaine_result(max_pages: int | None = None) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        tls_context=agrasc_tls_context(),
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = []
    operator_clients: dict[str, PoliteHttpClient] = {}
    pages = LinkedPages(LIST_URL, "page", 0, max_pages or 100)
    seen_sales: set[str] = set()
    for page_url in pages:
        try:
            html = client.get(page_url)
        except Exception as exc:
            LOGGER.error("AGRASC list fetch failed: %s", exc)
            errors.append(f"{page_url}: {exc}")
            break
        pages.observe(html, page_url)
        for sale in parse_agrasc_html(html, page_url=page_url):
            url = str(sale.get("source_url"))
            if url in seen_sales:
                continue
            seen_sales.add(url)
            if sale.get("department") in TARGET_DEPARTMENTS:
                enrich_agrasc_operator(sale, operator_clients, settings, errors)
                raw_sales.append(sale)

    return ScrapeResult(
        validate_raw_sales("agrasc", unique_dicts(raw_sales, "source_url"), errors),
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(),
         **pages.metrics(),
         "operator_details": {status: sum(s.get("operator_detail_status") == status for s in raw_sales)
                              for status in ("complete", "partial", "failed", "unsupported")}},
    )


def parse_agrasc_html(html: str, page_url: str = LIST_URL) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sales: list[dict[str, Any]] = []
    inventory = soup.select_one(".view-liste-ventes-immobilieres") or soup
    for card in inventory.select(".card-vente-immo"):
        sale = _parse_card(card, page_url)
        if sale:
            sales.append(sale)
    return sales


def _parse_card(card: Tag, page_url: str) -> dict[str, Any] | None:
    link = card.select_one(".fr-card__title a[href]")
    if link is None:
        return None
    raw_text = "\n".join(
        line for line in (clean_text(part) for part in card.get_text("\n", strip=True).splitlines()) if line
    )
    source_url = urljoin(page_url, str(link.get("href")))
    city, department = _location(_first_detail(card))
    url_city, postal_code = _location_from_url(source_url)
    if url_city and (not city or _slugify(city) != _slugify(url_city)):
        city = url_city
    title = clean_text(link.get_text(" ", strip=True))
    description = _node_text(card.select_one(".fr-card__desc"))
    surface = _extract_badge_surface(card) or _extract_surface(raw_text)
    land_surface = _extract_land_surface(description)
    starting_price = _extract_after(raw_text, r"MAP\s*:?\s*([0-9][0-9\s.,]+)\s*€")
    sale_date = _extract_sale_window(card)
    source_images = _extract_images(card, page_url)
    return {
        "source_name": "agrasc",
        "source_url": source_url,
        "external_id": _external_id(str(link.get("href"))),
        "department": department,
        "city": city,
        "postal_code": postal_code,
        "property_type": title,
        "title": title,
        "description": description,
        "surface_m2": surface,
        "land_surface_m2": land_surface,
        "starting_price_eur": starting_price,
        "sale_date": sale_date,
        "status": "upcoming" if re.search(r"\bEn cours\b", raw_text, re.I) else "unknown",
        "documents": [],
        "raw_text": raw_text,
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
        "source_blocks": {
            key: value
            for key, value in {
                "titre": title,
                "description": description,
                "ville": city,
                "departement": department,
                "code_postal": postal_code,
                "surface": surface,
                "surface_terrain": land_surface,
                "mise_a_prix": starting_price,
                "date_vente": sale_date,
                "page_text": raw_text,
            }.items()
            if value
        },
    }


def _first_detail(card: Tag) -> str | None:
    for node in card.select(".fr-card__detail"):
        text = clean_text(node.get_text(" ", strip=True))
        if text and re.search(r"\((?:\d{2,3}|\d{5}|2[AB]|O\d)\)", text):
            return text
    return None


def _location(text: str | None) -> tuple[str | None, str | None]:
    if not text:
        return None, None
    match = re.search(r"(.+?)\s*\((\d{2,3}|\d{5}|2[AB]|O\d)\)", text)
    if not match:
        return None, None
    code = match.group(2).replace("O", "0")
    department = extract_department(code) if len(code) == 5 else code
    return clean_text(match.group(1)), department


def _extract_sale_window(card: Tag) -> str | None:
    for node in card.select(".fr-card__detail"):
        text = clean_text(node.get_text(" ", strip=True))
        if text and re.search(r"\b\d{1,2}\b.*\b20\d{2}\b", text):
            return _normalize_sale_window(text)
    return None


def _extract_badge_surface(card: Tag) -> str | None:
    for node in card.select(".fr-badge"):
        text = clean_text(node.get_text(" ", strip=True))
        if not text:
            continue
        match = re.fullmatch(rf"{SURFACE_VALUE_PATTERN}\s*m(?:²|2)", text, flags=re.I)
        if match:
            return _normalize_surface_number(match.group(1))
    return None


def _extract_surface(text: str) -> str | None:
    match = re.search(rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b", text, flags=re.I)
    return _normalize_surface_number(match.group(1)) if match else None


def _extract_land_surface(text: str | None) -> str | None:
    if not text:
        return None
    for pattern in (
        rf"\b(?:terrain|parcelle)\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
        rf"\b(?:terrain|parcelle)\b.{{0,80}}?\b{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
    ):
        match = re.search(pattern, text, flags=re.I)
        if match:
            return _normalize_surface_number(match.group(1))
    return None


def _extract_images(card: Tag, page_url: str) -> list[str]:
    urls: list[str] = []
    for image in card.find_all("img"):
        for candidate in html_image_candidates(image):
            src = clean_text(candidate)
            if not src:
                continue
            absolute = urljoin(page_url, src)
            if _looks_like_property_image(absolute) and absolute not in urls:
                urls.append(absolute)
    return urls


def _looks_like_property_image(url: str) -> bool:
    text = strip_accents(clean_text(url) or "").lower()
    if not re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", text):
        return False
    return not re.search(r"\b(?:logo|favicon|sprite|icon|picto|placeholder|avatar|loader)\b", text)


def _normalize_sale_window(text: str) -> str:
    for pattern in (
        r"\b\d{1,2}\s+au\s+(\d{1,2}\s+[A-Za-zÀ-ÖØ-öø-ÿ]+\s+20\d{2})\b",
        r"\b\d{1,2}\s+[A-Za-zÀ-ÖØ-öø-ÿ]+\s+au\s+(\d{1,2}\s+[A-Za-zÀ-ÖØ-öø-ÿ]+\s+20\d{2})\b",
    ):
        match = re.search(pattern, text, flags=re.I)
        if match:
            return clean_text(match.group(1)) or text
    return text


def _normalize_surface_number(value: str) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    text = text.replace(" ", "")
    if "," not in text and re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        text = text.replace(".", "")
    return text


def _location_from_url(source_url: str) -> tuple[str | None, str | None]:
    match = re.search(rf"/([^/?#]+)-({FRENCH_POSTAL_CODE_PATTERN})(?=[-./_]|$)", source_url, flags=re.I)
    if not match:
        return None, None
    slug = match.group(1).rsplit("/", 1)[-1]
    city = _city_from_slug(slug)
    return city, match.group(2)


def _city_from_slug(slug: str) -> str | None:
    tokens = [token for token in slug.split("-") if token]
    while tokens and (tokens[0].lower() in URL_CITY_PREFIXES or re.fullmatch(r"\d+(?:m2|p|pieces?|euros?)", tokens[0])):
        tokens.pop(0)
    if not tokens:
        return None
    return " ".join(part.capitalize() for part in tokens)


def _slugify(value: str | None) -> str:
    text = strip_accents(clean_text(value) or "").lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def _extract_after(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, flags=re.I)
    return clean_text(match.group(1)) if match else None


def _external_id(url: str) -> str:
    return url.rstrip("/").split("/")[-1] or url


def _node_text(node: Tag | None) -> str | None:
    return clean_text(node.get_text(" ", strip=True)) if node else None
