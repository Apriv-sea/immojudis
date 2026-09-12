"""Resolve existing catalogue identity under the publication transaction lock."""
from __future__ import annotations

from datetime import datetime

from psycopg.types.json import Jsonb

from src.admission import quarantine_reason
from src.dedupe import _address_dedupe_keys, _merge_into, _same_property
from src.freshness import invalidate_analysis
from src.models import AuctionSale


def _from_row(row: dict) -> AuctionSale:
    return AuctionSale.model_validate({key: value for key, value in row.items()
                                      if key in AuctionSale.model_fields and value is not None})


def _urls(sale: AuctionSale) -> set[str]:
    return {url for url in [sale.source_url, *sale.source_urls] if url}


def conflicting_identity(existing: AuctionSale, incoming: AuctionSale) -> bool:
    """Legacy aliases are claims, not proof that two properties are identical."""
    for key in ('lot_number', 'lot_id'):
        before, after = existing.raw_payload.get(key), incoming.raw_payload.get(key)
        if before and after and str(before) != str(after):
            return True
    before = set(_address_dedupe_keys(existing))
    after = set(_address_dedupe_keys(incoming))
    return bool(before and after and not before.intersection(after))


def hold_identity(connection, incoming: AuctionSale, matches: list[AuctionSale], reason: str) -> None:
    from src.collection_evidence import record_sale_decisions

    evidence = {'source_url': incoming.source_url, 'reason': reason,
                'candidate_urls': [row.source_url for row in matches]}
    for row in [incoming, *matches]:
        row.quality_flags = sorted(set(row.quality_flags) | {'property_identity_conflict'})
        row.status = 'quarantined'
        row.raw_payload['publication_identity_conflict'] = evidence
    # Retain the existing rows and their evidence, but hide uncertain identities.
    connection.execute("""update public.auction_sales set status='quarantined',updated_at=now(),
        quality_flags=case when coalesce(quality_flags,'[]'::jsonb) ? 'property_identity_conflict'
          then quality_flags else coalesce(quality_flags,'[]'::jsonb)||'["property_identity_conflict"]'::jsonb end,
        raw_payload=coalesce(raw_payload,'{}'::jsonb)||jsonb_build_object('publication_identity_conflict',%s::jsonb)
        where source_url=any(%s)""", (Jsonb(evidence), [row.source_url for row in matches]))
    record_sale_decisions(incoming.last_run_id, [incoming], decision='quarantined',
                          reason=reason, connection=connection)


def merge_revision(existing: AuctionSale, incoming: AuctionSale) -> AuctionSale:
    incoming_url = incoming.source_url
    previous_checks = existing.raw_payload.get('source_checks') or {}
    new_checks = incoming.raw_payload.get('source_checks') or {}
    old_time = str((previous_checks.get(incoming_url) or {}).get('checked_at') or '')
    new_time = str((new_checks.get(incoming_url) or {}).get('checked_at') or '')
    # A resumed old checkpoint must not replace a newer source observation.
    if old_time and new_time:
        old_checked = datetime.fromisoformat(old_time.replace('Z', '+00:00'))
        new_checked = datetime.fromisoformat(new_time.replace('Z', '+00:00'))
        if old_checked > new_checked:
            return existing.model_copy(deep=True, update={'last_run_id': incoming.last_run_id})
    if existing.source_url == incoming_url:
        result = incoming
        result.source_urls = sorted(_urls(existing) | _urls(incoming))
        result.raw_payload['source_checks'] = {**previous_checks, **new_checks}
        for key in ('source_presence', 'source_conflicts'):
            if existing.raw_payload.get(key) and not result.raw_payload.get(key):
                result.raw_payload[key] = existing.raw_payload[key]
        if set(_address_dedupe_keys(existing)) & set(_address_dedupe_keys(incoming)):
            for field in ('latitude', 'longitude'):
                if getattr(result, field) is None:
                    setattr(result, field, getattr(existing, field))
    else:
        result = _merge_into(existing.model_copy(deep=True), incoming, confidence='persisted_identity')
        # The catalogue URL and id stay stable even if another source is richer.
        result.source_url = existing.source_url
        result.source_name = existing.source_name
        if incoming.raw_payload.get('source_content_changed'):
            invalidate_analysis(result.raw_payload, 'source_revision_changed')
    reason = quarantine_reason(incoming)
    if reason:
        result.raw_payload['source_identity_mismatch'] = True
        result.raw_payload['publication_conflict_evidence'] = {
            'source_url': incoming_url, 'reason': reason, 'sale_procedure': incoming.sale_procedure,
        }
    result.id = existing.id
    result.first_seen_at = existing.first_seen_at
    result.created_at = existing.created_at
    result.last_run_id = incoming.last_run_id
    if existing.raw_payload.get('publication_identity_conflict'):
        result.raw_payload['publication_identity_conflict'] = existing.raw_payload['publication_identity_conflict']
        result.quality_flags = sorted(set(result.quality_flags) | {'property_identity_conflict'})
    if result.source_url == incoming_url:
        schedule = incoming.raw_payload.get('source_sale_schedule') or {}
        try:
            start = datetime.fromisoformat(schedule['opens_at'])
            end = datetime.fromisoformat(schedule['closes_at'])
            if start.tzinfo is not None and end.tzinfo is not None and end > start:
                result.raw_payload['source_conflicts'] = [c for c in result.raw_payload.get('source_conflicts', [])
                    if not (c.get('code') == 'closing_time_unverified' and c.get('selected_source') == incoming_url)]
        except (KeyError, TypeError, ValueError):
            pass
    return result


def resolve_publication_identities(connection, sales: list[AuctionSale]) -> list[AuctionSale]:
    urls = sorted(set().union(*(_urls(sale) for sale in sales)))
    postal_codes = sorted({sale.postal_code for sale in sales if sale.postal_code})
    hashes = sorted({sale.content_hash for sale in sales if sale.content_hash})
    rows = connection.execute("""select to_jsonb(s) from public.auction_sales s
        where source_url=any(%s) or source_urls ?| %s or postal_code=any(%s)
          or content_hash=any(%s)
        order by source_url for update""", (urls, urls, postal_codes, hashes)).fetchall()
    existing = [_from_row(row[0]) for row in rows]
    resolved: dict[str, AuctionSale] = {}
    for sale in sales:
        exact = [row for row in existing if _urls(row) & _urls(sale)]
        matches = exact or [row for row in existing
            if set(_address_dedupe_keys(row)) & set(_address_dedupe_keys(sale)) and _same_property(row, sale)]
        if len(matches) > 1 or any(conflicting_identity(row, sale) for row in matches):
            hold_identity(connection, sale, matches, 'ambiguous_persisted_identity')
            for row in matches:
                resolved.pop(row.source_url, None)
            continue
        if matches:
            result = merge_revision(matches[0], sale)
            # Keep caller references coherent with the canonical journal URL.
            for key in AuctionSale.model_fields:
                setattr(sale, key, getattr(result, key))
            existing.remove(matches[0])
        existing.append(sale)
        resolved[sale.source_url] = sale
    return list(resolved.values())
