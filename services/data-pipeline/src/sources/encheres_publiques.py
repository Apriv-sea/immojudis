from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from src.config import TARGET_DEPARTMENTS, load_settings
from src.normalize import (
    SURFACE_VALUE_PATTERN,
    clean_text,
    extract_department,
    has_rented_occupancy_signal,
    no_lease_occupancy_status,
    parse_surface,
)
from src.raw_models import validate_raw_sales
from src.sources.common import PoliteHttpClient, ScrapeResult, should_fetch_detail, unique_dicts

BASE_URL = "https://www.encheres-publiques.com"
CANONICAL_BASE_URL = "https://encheres-publiques.com"
NATIONAL_LIST_URL = f"{BASE_URL}/ventes/immobilier"
LOGGER = logging.getLogger(__name__)
PARIS_TZ = ZoneInfo("Europe/Paris")
DETAIL_OVERRIDE_FIELDS = {
    "description",
    "address",
    "postal_code",
    "surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
    "rooms_count",
    "bedrooms_count",
    "bathrooms_count",
    "parking_count",
    "has_garden",
    "has_terrace",
    "has_garage",
    "has_pool",
    "starting_price_eur",
    "adjudication_price_eur",
    "sale_date",
    "visit_dates",
    "lawyer_name",
    "lawyer_contact",
    "tribunal",
    "latitude",
    "longitude",
    "occupancy_status",
    "status",
}


def scrape_encheres_publiques_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_encheres_publiques_aquitaine_result(max_pages=max_pages).sales


def scrape_encheres_publiques_aquitaine_result(
    max_pages: int | None = None, known: dict[str, str] | None = None
) -> ScrapeResult:
    """Collect Encheres-Publiques.com public listing data.

    The site exposes structured Next/Apollo state on SEO pages. We consume only
    allowed public pages and avoid disallowed query, backend service and document
    URLs from robots.txt.
    """
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        allowed_redirect_origins=(CANONICAL_BASE_URL,),
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    places = _configured_places(str(settings.get("encheres_publiques_places") or ""))
    max_pages = max_pages or int(settings["encheres_publiques_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = []
    page_urls = (
        [f"{BASE_URL}/ventes/immobilier/v/{place}" for place in places[:max_pages]]
        if places
        else [NATIONAL_LIST_URL]
    )
    for page_url in page_urls:
        try:
            html = client.get(page_url)
        except Exception as exc:
            LOGGER.error("Encheres-Publiques list fetch failed for %s: %s", page_url, exc)
            errors.append(f"{page_url}: {exc}")
            continue
        for sale in parse_encheres_publiques_html(html, page_url):
            if should_fetch_detail(sale, known):
                _enrich_sale_from_detail(client, sale, errors)
            raw_sales.append(sale)
    return ScrapeResult(
        validate_raw_sales("encheres_publiques", unique_dicts(raw_sales, "source_url"), errors),
        errors,
        getattr(client, "coverage_metrics", lambda: {})(),
    )


def parse_encheres_publiques_html(html: str, page_url: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    state = _extract_apollo_state(soup)
    if not state:
        return []
    links_by_lot_id = _extract_lot_links(soup, page_url)
    sales: list[dict[str, Any]] = []
    for key, lot in state.items():
        if not key.startswith("Lot:") or not isinstance(lot, dict):
            continue
        if lot.get("categorie") != "immobilier" or not lot.get("nom"):
            continue
        adjudication_price = lot.get("prix_adjuge")
        if lot.get("termine") is True and not _has_adjudication_price(adjudication_price):
            continue
        address = _resolve_ref(state, lot.get("adresse_defaut"))
        city_slug = str(address.get("ville_slug") or "")
        department = _department_from_slug(city_slug)
        if department not in TARGET_DEPARTMENTS:
            continue
        organizer = _resolve_ref(state, lot.get("organisateur"))
        event = _resolve_ref(state, lot.get("evenement"))
        lot_id = str(lot.get("id") or key.split(":", 1)[1])
        source_url = links_by_lot_id.get(lot_id) or f"{page_url}#lot-{lot_id}"
        raw_text = _build_raw_text(lot, address, organizer, event)
        source_blocks = _extract_listing_source_blocks(lot, address, organizer, event)
        sales.append(
            {
                "source_name": "encheres_publiques",
                "source_url": source_url,
                "external_id": lot_id,
                "department": department,
                "city": clean_text(address.get("ville")) or _city_from_slug(city_slug),
                "property_type": lot.get("sous_categorie") or lot.get("nom"),
                "title": lot.get("nom"),
                "description": lot.get("criteres_resume") or event.get("titre"),
                "surface_m2": _extract_surface(lot.get("nom"), lot.get("criteres_resume")),
                "starting_price_eur": lot.get("mise_a_prix"),
                "adjudication_price_eur": adjudication_price,
                "sale_date": _timestamp_to_iso(lot.get("ouverture_date") or event.get("ouverture_date")),
                "source_sale_schedule": _source_sale_schedule(lot, event),
                "lawyer_name": _lawyer_name(organizer),
                "tribunal": _tribunal_name(organizer, event),
                "status": _sale_status(adjudication_price, lot.get("termine")),
                "documents": [],
                "raw_text": raw_text,
                "source_blocks": source_blocks,
            }
        )
    return sales


def parse_encheres_publiques_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    state = _extract_apollo_state(soup)
    if not state:
        return {}

    lot_id = _lot_id_from_url(source_url)
    lot = state.get(f"Lot:{lot_id}") if lot_id else None
    if not isinstance(lot, dict):
        lot = _first_relevant_lot(state)
    if not lot:
        return {}

    address = _resolve_address(state, lot)
    event = _resolve_ref(state, lot.get("evenement"))
    organizer = _resolve_profile(state, lot)
    city_slug = str(address.get("ville_slug") or "")
    department = _department_from_slug(city_slug) or _department_from_address(address)
    description = _plain_text(lot.get("description")) or _plain_text(lot.get("criteres_resume"))
    address_text = _address_text(address)
    postal_code = _postal_code(address_text)
    latitude, longitude = _coordinates(address)
    visit_dates = _extract_visit_dates(state, lot)
    source_blocks = _extract_source_blocks(lot, organizer)
    raw_text = _build_detail_raw_text(lot, address, organizer, event, visit_dates, source_blocks)
    surface = _resolve_built_surface(lot)
    title = _plain_text(lot.get("nom"))
    adjudication_price = lot.get("prix_adjuge")

    return {
        "source_name": "encheres_publiques",
        "source_url": source_url,
        "external_id": str(lot.get("id") or lot_id or ""),
        "department": department,
        "city": _plain_text(address.get("ville")) or _city_from_slug(city_slug),
        "address": address_text,
        "postal_code": postal_code,
        "property_type": lot.get("sous_categorie") or title,
        "title": title,
        "description": description,
        "surface_m2": surface,
        "habitable_surface_m2": surface,
        "carrez_surface_m2": surface if _mentions_carrez(title, description) else None,
        "land_surface_m2": lot.get("critere_surface_terrain"),
        "rooms_count": lot.get("critere_nombre_de_pieces"),
        "bedrooms_count": lot.get("critere_nombre_de_chambres"),
        "bathrooms_count": lot.get("critere_nombre_de_salles_de_bain"),
        "parking_count": _parking_count(lot, description),
        "has_garden": _mentions_feature("jardin", title, description),
        "has_terrace": _mentions_feature("terrasse", title, description),
        "has_garage": _mentions_feature("garage", title, description),
        "has_pool": _mentions_feature("piscine", title, description),
        "starting_price_eur": lot.get("mise_a_prix") or lot.get("prix_plancher"),
        "adjudication_price_eur": adjudication_price,
        "sale_date": _timestamp_to_iso(lot.get("ouverture_date") or lot.get("fermeture_date") or event.get("ouverture_date")),
        "source_sale_schedule": _source_sale_schedule(lot, event),
        "visit_dates": visit_dates,
        "lawyer_name": _lawyer_name(organizer),
        "lawyer_contact": _plain_text(organizer.get("telephone") or organizer.get("phone")),
        "tribunal": _tribunal_name(organizer, event),
        "status": _sale_status(adjudication_price, lot.get("termine")),
        "latitude": latitude,
        "longitude": longitude,
        "occupancy_status": _normalize_occupancy_status(lot.get("critere_occupation_du_bien")),
        "documents": [],
        "raw_text": raw_text,
        "source_blocks": source_blocks,
        "source_images": _extract_source_images(state, lot),
    }


def _extract_apollo_state(soup: BeautifulSoup) -> dict[str, Any]:
    script = soup.select_one("script#__NEXT_DATA__")
    if script is None or not script.string:
        return {}
    try:
        data = json.loads(script.string)
    except json.JSONDecodeError:
        return {}
    page_props = data.get("props", {}).get("pageProps", {})
    raw_state = page_props.get("apolloState") or page_props.get("__APOLLO_STATE__") or {}
    state = raw_state.get("data", raw_state) if isinstance(raw_state, dict) else {}
    return state if isinstance(state, dict) else {}


def _extract_lot_links(soup: BeautifulSoup, page_url: str) -> dict[str, str]:
    links: dict[str, str] = {}
    for link in soup.find_all("a", href=True):
        href = str(link.get("href") or "")
        match = re.search(r"_(\d+)(?:$|[/?#])", href)
        if not match:
            continue
        links[match.group(1)] = urljoin(page_url, href)
    return links


def _enrich_sale_from_detail(client: PoliteHttpClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not source_url.startswith(BASE_URL) or "#lot-" in source_url:
        return
    try:
        html = client.get(source_url)
    except Exception as exc:
        LOGGER.warning("Encheres-Publiques detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        return

    details = parse_encheres_publiques_detail_html(html, source_url)
    for key, value in details.items():
        if key == "source_sale_schedule":
            # The detail page supersedes the list, including an incomplete interval.
            sale[key] = value
            continue
        if value in (None, "", []):
            continue
        if key == "source_blocks" and isinstance(value, dict):
            existing_blocks = sale.get("source_blocks") if isinstance(sale.get("source_blocks"), dict) else {}
            sale[key] = {**existing_blocks, **{item_key: item_value for item_key, item_value in value.items() if item_value}}
            continue
        if key == "raw_text" and sale.get("raw_text"):
            sale[key] = _join_unique_lines(str(sale["raw_text"]), str(value))
        elif key == "visit_dates" and isinstance(value, list):
            sale[key] = _unique_strings([*(sale.get(key) or []), *value])
        elif key == "documents":
            sale[key] = []
        elif key in DETAIL_OVERRIDE_FIELDS or not sale.get(key):
            sale[key] = value


def _resolve_ref(state: dict[str, Any], value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    ref = value.get("__ref")
    resolved = state.get(ref) if isinstance(ref, str) else None
    return resolved if isinstance(resolved, dict) else {}


def _first_relevant_lot(state: dict[str, Any]) -> dict[str, Any]:
    for key, lot in state.items():
        if key.startswith("Lot:") and isinstance(lot, dict) and lot.get("categorie") == "immobilier":
            return lot
    return {}


def _lot_id_from_url(source_url: str) -> str | None:
    match = re.search(r"_(\d+)(?:$|[/?#])", source_url)
    return match.group(1) if match else None


def _resolve_address(state: dict[str, Any], lot: dict[str, Any]) -> dict[str, Any]:
    for key in ("adresse_physique", "adresse_defaut", "adresse"):
        address = _resolve_ref(state, lot.get(key))
        if address:
            return address
    return {}


def _resolve_profile(state: dict[str, Any], lot: dict[str, Any]) -> dict[str, Any]:
    organizer = _resolve_ref(state, lot.get("organisateur"))
    if organizer:
        return organizer
    for item in lot.get("all_contacts") or lot.get("contacts") or []:
        contact = _resolve_ref(state, item)
        profile = _resolve_ref(state, contact.get("profil")) or _resolve_ref(state, contact.get("profile"))
        if profile:
            return profile
    return {}


def _sale_status(adjudication_price: object | None, ended: object | None) -> str:
    if _has_adjudication_price(adjudication_price):
        return "adjudicated"
    return "past" if ended else "upcoming"


def _has_adjudication_price(value: object | None) -> bool:
    return value not in (None, "")


def _configured_places(value: str) -> tuple[str, ...]:
    return tuple(clean_text(part) or "" for part in value.split(",") if clean_text(part))


def _department_from_slug(slug: str) -> str | None:
    match = re.search(r"-([0-9]{2,3}|2[ab])$", slug, re.I)
    return match.group(1).upper() if match else None


def _city_from_slug(slug: str) -> str | None:
    department = _department_from_slug(slug)
    if not department:
        return None
    return slug[: -(len(department) + 1)].replace("-", " ").title()


def _department_from_address(address: dict[str, Any]) -> str | None:
    postal_code = _postal_code(_address_text(address))
    return extract_department(postal_code)


def _address_text(address: dict[str, Any]) -> str | None:
    for key in ("text", "adresse", "address", "formatted_address"):
        value = _plain_text(address.get(key))
        if value:
            return value
    parts = [
        _plain_text(address.get("rue") or address.get("street")),
        _plain_text(address.get("code_postal") or address.get("postal_code")),
        _plain_text(address.get("ville")),
        _plain_text(address.get("pays") or address.get("country")),
    ]
    return clean_text(" ".join(part for part in parts if part))


def _postal_code(value: object) -> str | None:
    text = _plain_text(value)
    if not text:
        return None
    match = re.search(r"\b(\d{5})\b", text)
    return match.group(1) if match else None


def _coordinates(address: dict[str, Any]) -> tuple[str | None, str | None]:
    coords = address.get("coords") or address.get("coordinates")
    if isinstance(coords, (list, tuple)) and len(coords) >= 2:
        longitude, latitude = coords[:2]
        return str(latitude), str(longitude)
    latitude = address.get("latitude") or address.get("lat")
    longitude = address.get("longitude") or address.get("lon") or address.get("lng")
    return (str(latitude) if latitude is not None else None, str(longitude) if longitude is not None else None)


def _source_sale_schedule(lot: dict[str, Any], event: dict[str, Any]) -> dict[str, str] | None:
    # Never mix a lot opening with an event closing (different populations).
    has_lot_boundary = any(lot.get(key) is not None for key in ("ouverture_date", "fermeture_date"))
    schedule = lot if has_lot_boundary else event
    opens_at = _timestamp_to_iso(schedule.get("ouverture_date"))
    closes_at = _timestamp_to_iso(schedule.get("fermeture_date"))
    if not opens_at or not closes_at or datetime.fromisoformat(closes_at) <= datetime.fromisoformat(opens_at):
        return None
    return {"opens_at": opens_at, "closes_at": closes_at}


def _timestamp_to_iso(value: object) -> str | None:
    try:
        timestamp = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    try:
        return datetime.fromtimestamp(timestamp, UTC).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _timestamp_to_display(value: object) -> str | None:
    try:
        timestamp = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(timestamp, PARIS_TZ).strftime("%d/%m/%Y %H:%M")


def _extract_surface(*values: object) -> str | None:
    text = " ".join(str(value) for value in values if value)
    match = re.search(rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b", text, re.I)
    surface = parse_surface(match.group(1)) if match else None
    return str(surface) if surface is not None else None


def _resolve_built_surface(lot: dict[str, Any]) -> str | None:
    structured = parse_surface(lot.get("critere_surface_habitable"))
    title_surface = parse_surface(_extract_surface(lot.get("nom")))
    description_surface = parse_surface(_extract_surface(lot.get("description")))

    # Encheres-Publiques can expose a malformed criterion while the editorial
    # title and description both carry the correct built surface.
    if title_surface is not None and title_surface == description_surface:
        return str(title_surface)
    if structured is not None:
        return str(structured)
    fallback = title_surface or description_surface or parse_surface(_extract_surface(lot.get("criteres_resume")))
    return str(fallback) if fallback is not None else None


def _extract_visit_dates(state: dict[str, Any], lot: dict[str, Any]) -> list[str]:
    visits: list[str] = []
    for item in lot.get("visites") or []:
        visit = _resolve_ref(state, item)
        start = _timestamp_to_display(
            visit.get("ouverture_date") or visit.get("debut") or visit.get("date_debut") or visit.get("start")
        )
        end = _timestamp_to_display(
            visit.get("fermeture_date") or visit.get("fin") or visit.get("date_fin") or visit.get("end")
        )
        location = _plain_text(visit.get("lieu") or visit.get("adresse") or visit.get("observations"))
        if start and end and start[:10] == end[:10]:
            visits.append(clean_text(f"{start} - {end[-5:]} {location or ''}") or start)
        elif start and end:
            visits.append(clean_text(f"{start} - {end} {location or ''}") or start)
        elif start:
            visits.append(clean_text(f"{start} {location or ''}") or start)
    observations = _plain_text(lot.get("observations_visites"))
    if observations and not visits:
        visits.append(observations)
    return _unique_strings(visits)


def _extract_source_blocks(
    lot: dict[str, Any],
    organizer: dict[str, Any] | None = None,
) -> dict[str, str]:
    organizer = organizer or {}
    mapping = {
        "resume": lot.get("criteres_resume"),
        "description": lot.get("description"),
        "visites": lot.get("observations_visites"),
        "conditions_de_vente": lot.get("infos_conditions_de_vente"),
        "frais_de_vente": lot.get("infos_frais_de_vente"),
        "modalite_de_paiement": lot.get("infos_modalite_de_paiement"),
        "mentions_legales": lot.get("infos_mentions_legales"),
        "renseignements_de_vente": lot.get("infos_renseignements_de_vente"),
        "diagnostic_date": lot.get("critere_diagnostic_date"),
        "dpe": lot.get("critere_consommation_energetique"),
        "ges": lot.get("critere_emissions_de_gaz"),
        "occupation": lot.get("critere_occupation_du_bien"),
        "organisateur": organizer.get("nom"),
        "organisateur_categorie": organizer.get("categorie"),
    }
    return {key: value for key, raw in mapping.items() if (value := _plain_text(raw))}


def _extract_listing_source_blocks(
    lot: dict[str, Any],
    address: dict[str, Any],
    organizer: dict[str, Any],
    event: dict[str, Any],
) -> dict[str, str]:
    mapping = {
        "titre": lot.get("nom"),
        "resume": lot.get("criteres_resume"),
        "adresse": _address_text(address),
        "ville": address.get("ville"),
        "mise_a_prix": lot.get("mise_a_prix"),
        "date_vente": _timestamp_to_display(lot.get("ouverture_date") or event.get("ouverture_date")),
        "tribunal": _tribunal_name(organizer, event),
        "organisateur": organizer.get("nom"),
        "organisateur_categorie": organizer.get("categorie"),
        "surface": _extract_surface(lot.get("criteres_resume"), lot.get("nom")),
        "page_text": _build_raw_text(lot, address, organizer, event),
    }
    return {key: value for key, raw in mapping.items() if (value := _plain_text(raw))}


def _extract_source_images(state: dict[str, Any], lot: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for item in lot.get("photos") or lot.get("images") or []:
        photo = _resolve_ref(state, item) if isinstance(item, dict) else {}
        if not photo and isinstance(item, dict):
            photo = item
        for key in ("url", "src", "path", "photo", "thumb"):
            value = _plain_text(photo.get(key))
            if not value:
                continue
            urls.append(_absolute_url(value))
            break
    return _unique_strings(urls)


def _absolute_url(value: str) -> str:
    if value.startswith("//"):
        return f"https:{value}"
    return urljoin(BASE_URL, value)


def _mentions_feature(feature: str, *values: object) -> bool | None:
    text = " ".join(_plain_text(value) or "" for value in values)
    if not text:
        return None
    return bool(re.search(rf"\b{re.escape(feature)}s?\b", text, re.I))


def _mentions_carrez(*values: object) -> bool:
    text = " ".join(_plain_text(value) or "" for value in values)
    return bool(re.search(r"\bcarrez\b", text, re.I))


def _parking_count(lot: dict[str, Any], description: object) -> int | None:
    value = lot.get("critere_nombre_de_parkings") or lot.get("nombre_de_parkings")
    try:
        count = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        count = 0
    if count > 0:
        return count
    parking_kind = _plain_text(lot.get("critere_type_de_parking"))
    text = " ".join(part for part in (parking_kind, _plain_text(description)) if part)
    if re.search(r"\b(?:parking|stationnement|garage|place de parking)\b", text, re.I):
        return 1
    return None


def _normalize_occupancy_status(value: object | None) -> str | None:
    text = _plain_text(value)
    if not text:
        return None
    lowered = text.lower()
    if re.search(r"sans\s+droit\s+ni\s+titre|squat", lowered):
        return "squatted"
    if re.search(r"propri[ée]taire\s+occupant|occup[ée]\s+par\s+le\s+propri[ée]taire", lowered):
        return "owner_occupied"
    if re.search(r"libre\s+de\s+toute\s+occupation|bien\s+libre|inoccup[ée]|vacant", lowered):
        return "vacant"
    if no_lease_status := no_lease_occupancy_status(lowered):
        return no_lease_status
    if has_rented_occupancy_signal(lowered):
        return "rented"
    if re.search(r"occup[ée]", lowered):
        return "occupied"
    if re.search(r"inconnu|non\s+renseign[ée]", lowered):
        return "unknown"
    return None


def _plain_text(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value)
    if "<" in text and ">" in text:
        text = BeautifulSoup(text, "html.parser").get_text(" ", strip=True)
    return clean_text(text)


def _build_detail_raw_text(
    lot: dict[str, Any],
    address: dict[str, Any],
    organizer: dict[str, Any],
    event: dict[str, Any],
    visit_dates: list[str],
    source_blocks: dict[str, str],
) -> str:
    diagnostic_parts = [
        f"DPE {source_blocks['dpe']}" if source_blocks.get("dpe") else None,
        f"GES {source_blocks['ges']}" if source_blocks.get("ges") else None,
        f"diagnostic du {source_blocks['diagnostic_date']}" if source_blocks.get("diagnostic_date") else None,
    ]
    parts = [
        _plain_text(lot.get("nom")),
        f"Adresse: {_address_text(address)}" if _address_text(address) else None,
        _plain_text(lot.get("criteres_resume")),
        _sale_type_text(lot),
        f"Mise a prix: {_price_for_text(lot.get('mise_a_prix') or lot.get('prix_plancher'))}"
        if lot.get("mise_a_prix") is not None or lot.get("prix_plancher") is not None
        else None,
        f"Prix adjuge: {_price_for_text(lot.get('prix_adjuge'))}" if lot.get("prix_adjuge") is not None else None,
        source_blocks.get("description"),
        f"Diagnostic: {', '.join(part for part in diagnostic_parts if part)}" if any(diagnostic_parts) else None,
        f"Occupation: {source_blocks['occupation']}" if source_blocks.get("occupation") else None,
        f"Visites: {' | '.join(visit_dates)}" if visit_dates else source_blocks.get("visites"),
        f"Conditions de vente: {source_blocks['conditions_de_vente']}" if source_blocks.get("conditions_de_vente") else None,
        f"Frais de vente: {source_blocks['frais_de_vente']}" if source_blocks.get("frais_de_vente") else None,
        f"Paiement: {source_blocks['modalite_de_paiement']}" if source_blocks.get("modalite_de_paiement") else None,
        _plain_text(event.get("titre")),
        _plain_text(organizer.get("nom")),
        f"Contact: {_plain_text(organizer.get('telephone') or organizer.get('phone'))}"
        if _plain_text(organizer.get("telephone") or organizer.get("phone"))
        else None,
    ]
    # Keep broad platform/legal explanations in raw_payload only; they can mention
    # generic risks that do not necessarily concern the property itself.
    return "\n".join(part for part in parts if part)


def _sale_type_text(lot: dict[str, Any]) -> str | None:
    sale_type = _plain_text(lot.get("type"))
    sale_subtype = _plain_text(lot.get("type_de_vente"))
    if sale_type and sale_subtype:
        return f"Type de vente: {sale_type} - {sale_subtype}"
    if sale_type:
        return f"Type de vente: {sale_type}"
    return f"Type de vente: {sale_subtype}" if sale_subtype else None


def _join_unique_lines(*blocks: str) -> str:
    lines: list[str] = []
    seen: set[str] = set()
    for block in blocks:
        for raw_line in block.splitlines():
            line = clean_text(raw_line)
            if not line or line in seen:
                continue
            seen.add(line)
            lines.append(line)
    return "\n".join(lines)


def _unique_strings(values: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = clean_text(value)
        if not text or text in seen:
            continue
        seen.add(text)
        unique.append(text)
    return unique


def _lawyer_name(organizer: dict[str, Any]) -> str | None:
    category = str(organizer.get("categorie") or "").lower()
    name = clean_text(organizer.get("nom"))
    if not name or category == "tribunal":
        return None
    return name


def _tribunal_name(organizer: dict[str, Any], event: dict[str, Any]) -> str | None:
    name = clean_text(organizer.get("nom"))
    if name and "tribunal judiciaire" in name.lower():
        return name
    title = clean_text(event.get("titre"))
    match = re.search(r"Tribunal judiciaire de\s+(.+?)(?:\s+le\b|$)", title or "", re.I)
    if match:
        return f"Tribunal Judiciaire de {clean_text(match.group(1))}"
    return None


def _build_raw_text(
    lot: dict[str, Any],
    address: dict[str, Any],
    organizer: dict[str, Any],
    event: dict[str, Any],
) -> str:
    parts = [
        clean_text(lot.get("nom")),
        clean_text(lot.get("criteres_resume")),
        f"Mise a prix: {_price_for_text(lot.get('mise_a_prix'))}" if lot.get("mise_a_prix") is not None else None,
        f"Prix adjuge: {_price_for_text(lot.get('prix_adjuge'))}" if lot.get("prix_adjuge") is not None else None,
        f"Ville: {clean_text(address.get('ville'))}" if address else None,
        clean_text(event.get("titre")),
        clean_text(organizer.get("nom")),
    ]
    return "\n".join(part for part in parts if part)


def _price_for_text(value: object) -> str:
    try:
        amount = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return str(value)
    return f"{amount:,}".replace(",", " ")
