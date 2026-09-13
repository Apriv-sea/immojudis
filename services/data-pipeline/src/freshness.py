"""Freshness is independent of a sale's identity and enrichment versions."""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any

SOURCE_EXTRACTION_VERSION = "source_extraction_20260913_v3"

SOURCE_FACT_FIELDS = (
    "raw_text", "documents", "visit_dates", "occupancy_status", "sale_date", "starting_price_eur",
    "status", "adjudication_price_eur", "source_sale_schedule", "source_blocks", "source_conflicts",
    "source_name", "source_url", "external_id", "lot_number", "address", "city", "postal_code",
    "department", "property_type", "title", "description", "tribunal", "lawyer_name", "lawyer_contact",
    "surface_m2", "habitable_surface_m2", "carrez_surface_m2", "land_surface_m2", "app_surface_m2",
    "app_surface_kind", "surface_scope", "surface_source", "surface_evidence", "rooms_count",
    "bedrooms_count", "bathrooms_count", "parking_count", "has_garden", "has_terrace", "has_garage",
    "has_pool", "has_air_conditioning", "has_double_glazing", "risk_notes", "latitude", "longitude",
)


def timestamp_is_fresh(value: object, *, hours: float = 24, now: datetime | None = None) -> bool:
    try:
        checked = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if checked.tzinfo is None:
            return False
        age = (now or datetime.now(UTC)) - checked
        return timedelta(0) <= age < timedelta(hours=hours)
    except (ValueError, TypeError):
        return False


def detail_is_fresh(row: dict[str, Any], source_url: str) -> bool:
    payload = row.get("raw_payload") or {}
    checks = payload.get("source_checks") or {}
    check = checks.get(source_url) or {}
    if check.get("extractor_version") != SOURCE_EXTRACTION_VERSION:
        return False
    hours = 24
    try:
        sale_date = datetime.fromisoformat(str(row.get("sale_date")).replace("Z", "+00:00"))
        if sale_date.tzinfo and timedelta(0) <= sale_date - datetime.now(UTC) <= timedelta(days=7):
            hours = 6
    except (ValueError, TypeError):
        pass
    return timestamp_is_fresh(check.get("checked_at"), hours=hours)


def document_fingerprint(documents: list) -> str:
    identities = sorted((str(d.get("url") or ""), str(d.get("label") or "")) for d in documents if isinstance(d, dict))
    return hashlib.sha256(json.dumps(identities).encode()).hexdigest()


def record_source_checks(raw_sales: list, known: dict) -> None:
    for sale in raw_sales:
        url = str(sale.get("source_url") or "")
        previous = (known.get(url, {}).get("raw_payload") or {}).get("source_checks") or {}
        payload = sale
        payload["source_checks"] = dict(previous)
        if sale.get("_known_unchanged") or sale.get("_detail_fetch_failed"):
            continue
        snapshot = sale.get('source_factual_snapshot') or {}
        content = {key: snapshot[key] if key in snapshot else sale.get(key) for key in SOURCE_FACT_FIELDS}
        fingerprint = hashlib.sha256(json.dumps(content, sort_keys=True, default=str).encode()).hexdigest()
        old = previous.get(url) or {}
        payload["source_checks"][url] = {"checked_at": sale.get("_checkpoint_checked_at") or datetime.now(UTC).isoformat(), "source_name": sale.get("source_name"), "fingerprint": fingerprint, "extractor_version": SOURCE_EXTRACTION_VERSION}
        if old.get("fingerprint") != fingerprint:
            invalidate_analysis(payload, "source_content_changed")


def documents_are_current(sale: Any) -> bool:
    analysis = sale.raw_payload.get("document_analysis") or {}
    return (
        analysis.get("input_fingerprint") == document_fingerprint(sale.documents)
        and timestamp_is_fresh(analysis.get("checked_at"))
        and not analysis.get("failed_documents")
    )


def invalidate_analysis(payload: dict, reason: str) -> None:
    """Retain dated evidence, never publish the superseded synthesis as current."""
    payload["source_content_changed"] = True
    if payload.get("llm_display_description"):
        payload["superseded_analysis"] = {
            "description": payload.pop("llm_display_description"),
            "prompt_version": payload.get("llm_prompt_version"),
            "superseded_at": datetime.now(UTC).isoformat(),
            "reason": reason,
        }
    payload["llm_display_status"] = "pending"
    for key in ("document_facts_version", "llm_prompt_version", "llm_fact_prompt_version",
                "llm_fact_extraction", "llm_extraction", "llm_due_diligence", "investment_analysis"):
        payload.pop(key, None)
