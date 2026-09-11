"""Read only public operator data, preserving AGRASC's catalogue identity."""
from __future__ import annotations

import json
import re
from html import unescape
from typing import Any
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

from src.sources.common import PoliteHttpClient, is_allowed_origin_url
from src.sources.notaires import API_URL, BASE_URL, parse_notaires_detail_json

IMMO_ORIGIN = "https://www.immo-interactif.fr"
AGORA_ORIGIN = "https://www.agorastore-immo.fr"


def enrich_agrasc_operator(
    sale: dict[str, Any], clients: dict[str, PoliteHttpClient], settings: dict, errors: list[str],
) -> None:
    url = str(sale.get("source_url") or "")
    origin = next((value for value in (IMMO_ORIGIN, AGORA_ORIGIN) if is_allowed_origin_url(url, (value,))), None)
    if not origin:
        sale["operator_detail_status"] = "unsupported"
        return
    sale["operator_source_url"] = url
    api = origin == IMMO_ORIGIN
    client_origin = BASE_URL if api else origin
    marker = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
    if api and not re.fullmatch(r"\d+", marker):
        sale["operator_detail_status"] = "unsupported"
        return
    if client_origin not in clients:
        clients[client_origin] = PoliteHttpClient(
            base_url=client_origin, user_agent=str(settings["user_agent"]),
            delay_seconds=float(settings["request_delay_seconds"]),
            timeout_seconds=float(settings["request_timeout_seconds"]),
            accept="application/json,text/plain,*/*" if api else "text/html,*/*",
        )
    endpoint = f"{API_URL}/{marker}" if api else url
    try:
        payload = clients[client_origin].get(endpoint)
        detail = parse_immo_operator_json(payload, marker) if api else parse_agora_operator_detail(payload, url)
        if api and not detail.get("description"):
            raise ValueError("missing operator description")
        if detail.get("description"):
            for key, value in detail.items():
                if value in (None, "", [], {}):
                    continue
                if key == "source_blocks":
                    sale[key] = {**(sale.get(key) or {}), **value}
                elif key == "raw_text":
                    sale[key] = f"{sale.get(key) or ''}\n{value}".strip()
                elif key not in {"source_name", "source_url", "external_id"}:
                    sale[key] = value
            sale["operator_detail_status"] = "complete"
            sale["source_detail_status"] = "complete"
        else:
            images = parse_agora_operator_images(payload, url)
            if images:
                sale["source_images"] = list(dict.fromkeys([*images, *(sale.get("source_images") or [])]))
                sale["raw_image_url"] = images[0]
            sale["operator_detail_status"] = "partial"
        sale.setdefault("source_blocks", {})["operator_endpoint"] = endpoint
    except Exception as exc:
        sale["operator_detail_status"] = "failed"
        sale["source_detail_status"] = "failed"
        sale["_detail_fetch_failed"] = True
        errors.append(f"operator detail {endpoint}: {exc}")


def parse_immo_operator_json(payload: str, expected_id: str) -> dict[str, Any]:
    data = json.loads(payload)
    if not isinstance(data, dict) or str(data.get("id")) != expected_id:
        raise ValueError("operator identity mismatch")
    detail = parse_notaires_detail_json(payload)
    transaction = data.get(str(data.get("typeTransaction") or "").lower()) or {}
    # AGRASC's date for an online sale denotes the closing date, not its opening.
    if transaction.get("dateFinEncheres"):
        detail["sale_date"] = transaction["dateFinEncheres"]
    detail.setdefault("source_blocks", {}).update({
        "operator_opening_date": transaction.get("dateDebutEncheres"),
        "operator_closing_date": transaction.get("dateFinEncheres"),
    })
    return detail


def parse_agora_operator_images(html: str, source_url: str) -> list[str]:
    marker = re.search(r"-(\d+)\.aspx$", urlsplit(source_url).path)
    if not marker:
        return []
    for node in BeautifulSoup(html, "html.parser").find_all("script", type="application/ld+json"):
        try:
            data = json.loads(node.get_text())
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict) or data.get("@type") != "Product" or str(data.get("productID")) != marker.group(1):
            continue
        values = data.get("image") or []
        values = values if isinstance(values, list) else [values]
        return [unescape(value) for value in values if isinstance(value, str)
                and is_allowed_origin_url(value, ("https://cdn.agorastore.fr",))]
    return []


def parse_agora_operator_detail(html: str, source_url: str) -> dict[str, Any]:
    """Decode public React props as JSON, never execute JavaScript."""
    marker = re.search(r"-(\d+)\.aspx$", urlsplit(source_url).path)
    if not marker:
        return {}
    prefix = "React.createElement(FicheProduitApp,"
    for script in BeautifulSoup(html, "html.parser").find_all("script"):
        text = script.get_text()
        if prefix not in text:
            continue
        props, _ = json.JSONDecoder().raw_decode(text.split(prefix, 1)[1].lstrip())
        page = props["ficheProduitModel"]
        model = page["productPageWrapper"]["productPageModel"]
        product = model["product"]
        if str(product.get("id")) != marker.group(1):
            raise ValueError("operator identity mismatch")
        fields = [(str(item.get("descriptifLibelle") or ""),
                   _operator_field_text(item.get("value")))
                  for group in model.get("descriptifs", []) for item in group.get("descriptifs", [])]
        description = "\n".join(f"{label} : {value}" for label, value in fields if value)
        if not description:
            return {}
        detail: dict[str, Any] = {
            "description": description, "raw_text": description,
            "documents": [{"label": item.get("fileName") or "Document opérateur", "url": item["url"]}
                          for item in model.get("documents", [])
                          if isinstance(item.get("url"), str)
                          and is_allowed_origin_url(item["url"], ("https://cdn.agorastore.fr",))
                          and urlsplit(item["url"]).path.lower().endswith(".pdf")],
            "source_images": [item["url"] for item in model.get("images", [])
                              if isinstance(item.get("url"), str)
                              and is_allowed_origin_url(item["url"], ("https://cdn.agorastore.fr",))],
            "source_blocks": {"description": description, "operator_fields": fields,
                              "operator_public_model": "FicheProduitApp"},
        }
        if detail["source_images"]:
            detail["raw_image_url"] = detail["source_images"][0]
        for label, value in fields:
            if label.casefold() == "adresse":
                detail["address"] = value
            if label.casefold() == "surface habitable":
                surface = re.match(r"\s*(\d+(?:[.,]\d+)?)\s*m[²2]\b", value)
                if surface:
                    detail["surface_m2"] = surface.group(1).replace(",", ".")
        state = page.get("saleState") or {}
        if str(state.get("productId")) == marker.group(1):
            detail["sale_date"] = state.get("endDate")
            detail["starting_price_eur"] = state.get("initialPrice")
            detail["source_blocks"].update({"operator_opening_date": state.get("startDate"),
                                             "operator_closing_date": state.get("endDate")})
        last_visit = (product.get("realEstateInformation") or {}).get("lastVisitDate")
        if last_visit:
            detail["visit_dates"] = [last_visit]
            detail["source_blocks"]["operator_visit_coverage"] = "last_visit_only"
        if re.search(r"libre de toute occupation", description, re.I):
            detail["occupancy_status"] = "vacant"
        return detail
    return {}


def _operator_field_text(value: Any) -> str:
    text = str(value or "")
    return BeautifulSoup(text, "html.parser").get_text(" ", strip=True) if "<" in text else unescape(text).strip()
