"""Freshness is independent of a sale's identity and enrichment versions."""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any


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
        if sale.get("_known_unchanged"):
            continue
        content = {key: sale.get(key) for key in ("raw_text", "documents", "visit_dates", "occupancy_status", "sale_date", "starting_price_eur")}
        fingerprint = hashlib.sha256(json.dumps(content, sort_keys=True, default=str).encode()).hexdigest()
        old = previous.get(url) or {}
        payload["source_checks"][url] = {"checked_at": datetime.now(UTC).isoformat(), "fingerprint": fingerprint}
        if old.get("fingerprint") != fingerprint:
            payload["source_content_changed"] = True
            for key in ("document_facts_version", "llm_prompt_version"):
                payload.pop(key, None)


def documents_are_current(sale: Any) -> bool:
    analysis = sale.raw_payload.get("document_analysis") or {}
    return (
        analysis.get("input_fingerprint") == document_fingerprint(sale.documents)
        and timestamp_is_fresh(analysis.get("checked_at"))
        and not analysis.get("failed_documents")
    )
