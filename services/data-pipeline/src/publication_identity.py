"""Resolve existing catalogue identity under the publication transaction lock."""
from __future__ import annotations

from datetime import datetime

from psycopg.types.json import Jsonb

from src.admission import quarantine_reason
from src.dedupe import _address_dedupe_keys, _merge_into, _same_property
from src.freshness import invalidate_analysis
from src.models import AuctionSale
from src.reviewed_aliases import (
    ReviewedAlias,
    ReviewedAliasRegistryError,
    load_reviewed_aliases,
)

_REVIEWED_ALIAS_RESOLVED_FLAGS = frozenset({'sale_procedure_conflict'})
_REVIEWED_ALIAS_IDENTITY_FLAGS = frozenset({
    'property_identity_conflict',
    'lot_identity_conflict',
    'source_identity_mismatch',
})


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


def _reviewed_alias_for_sale(registry, sale: AuctionSale) -> ReviewedAlias | None:
    """Return the direct reviewed mapping for an incoming source URL.

    ``source_urls`` may already contain reviewed aliases on a canonical row.
    Routing is therefore based on the incoming primary URL only; otherwise a
    normal canonical publication could accidentally be treated as a secondary
    publication.  The registry itself is loaded and validated once per batch.
    """
    return registry.for_url(sale.source_url)


def _alias_merge_input(existing: AuctionSale, incoming: AuctionSale) -> AuctionSale:
    """Keep source evidence while preventing secondary quarantine flags from
    contaminating the reviewed canonical row.

    ``merge_revision`` remains the single normal merge implementation.  The
    copy only removes publication-lifecycle flags which belong to the
    quarantined secondary row.  Date, price, surface and other factual fields
    remain untouched, so the usual conflict recording and source authority
    rules still apply.
    """
    candidate = incoming.model_copy(deep=True)
    candidate.status = existing.status
    candidate.quality_flags = [
        flag for flag in candidate.quality_flags
        if flag not in _REVIEWED_ALIAS_RESOLVED_FLAGS
    ]
    candidate.sale_verification_status = existing.sale_verification_status
    return candidate


def _replace_existing(existing: dict[str, AuctionSale], old: AuctionSale, new: AuctionSale) -> None:
    key = old.id or old.source_url
    existing[key] = new


def resolve_publication_identities(connection, sales: list[AuctionSale]) -> list[AuctionSale]:
    if not sales:
        return []
    # An unavailable registry is a publication failure, never an empty alias
    # set.  The migration exposes this RPC to both direct Postgres and service
    # role callers; loading once also keeps one batch internally consistent.
    registry = load_reviewed_aliases(connection)
    urls = sorted(set().union(*(_urls(sale) for sale in sales)))
    postal_codes = sorted({sale.postal_code for sale in sales if sale.postal_code})
    hashes = sorted({sale.content_hash for sale in sales if sale.content_hash})
    relevant_aliases = registry.aliases_for_urls(urls)
    canonical_ids = sorted({alias.canonical_sale_id for alias in relevant_aliases})
    rows = connection.execute("""select to_jsonb(s) from public.auction_sales s
        where source_url=any(%s) or source_urls ?| %s or postal_code=any(%s)
          or content_hash=any(%s) or s.id=any(%s::uuid[])
        order by source_url for update""", (urls, urls, postal_codes, hashes, canonical_ids)).fetchall()
    existing_rows = [_from_row(row[0]) for row in rows]
    existing_by_key: dict[str, AuctionSale] = {
        row.id or row.source_url: row for row in existing_rows
    }

    # The canonical row may not match source_url/source_urls in the initial
    # lookup (for example after a source URL was repaired).  The explicit ID
    # predicate above loads and locks it in the same transaction.  A reviewed
    # alias is ignored as a candidate only after both parents are present and
    # their immutable URLs agree with the registry.
    for alias in relevant_aliases:
        alias_row = next(
            (row for row in existing_by_key.values() if row.id == alias.alias_sale_id),
            None,
        )
        canonical_row = next(
            (row for row in existing_by_key.values() if row.id == alias.canonical_sale_id),
            None,
        )
        if alias_row is None or canonical_row is None:
            raise ReviewedAliasRegistryError(
                f"Reviewed alias {alias.alias_source_url} has no locked parent rows"
            )
        if alias_row.source_url != alias.alias_source_url:
            raise ReviewedAliasRegistryError(
                f"Reviewed alias source URL changed for {alias.alias_sale_id}"
            )
        if canonical_row.source_url != alias.canonical_source_url:
            raise ReviewedAliasRegistryError(
                f"Reviewed canonical source URL changed for {alias.canonical_sale_id}"
            )
        existing_by_key.pop(alias.alias_sale_id, None)

    resolved: dict[str, AuctionSale] = {}
    for sale in sales:
        reviewed_alias = _reviewed_alias_for_sale(registry, sale)
        if reviewed_alias is not None:
            canonical = next(
                (row for row in existing_by_key.values()
                 if row.id == reviewed_alias.canonical_sale_id),
                None,
            )
            if canonical is None:
                # This should already have been caught by the locked-parent
                # validation, but keep the branch fail-closed if the batch
                # contains a malformed row update.
                raise ReviewedAliasRegistryError(
                    f"Reviewed canonical row disappeared for {reviewed_alias.alias_source_url}"
                )
            if conflicting_identity(canonical, sale) or any(
                flag in sale.quality_flags
                for flag in _REVIEWED_ALIAS_IDENTITY_FLAGS
            ):
                hold_identity(connection, sale, [canonical], 'reviewed_alias_identity_conflict')
                resolved.pop(canonical.source_url, None)
                continue
            result = merge_revision(canonical, _alias_merge_input(canonical, sale))
            _replace_existing(existing_by_key, canonical, result)
            # Keep caller references coherent with the canonical journal URL.
            for key in AuctionSale.model_fields:
                setattr(sale, key, getattr(result, key))
            resolved[result.source_url] = result
            continue

        existing = list(existing_by_key.values())
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
            _replace_existing(existing_by_key, matches[0], result)
            resolved[result.source_url] = result
            continue
        existing_by_key[sale.id or sale.source_url] = sale
        resolved[sale.source_url] = sale
    return list(resolved.values())
