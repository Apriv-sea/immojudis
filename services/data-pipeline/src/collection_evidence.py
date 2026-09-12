"""Durable per-announcement decisions; independent of catalogue admission."""
from __future__ import annotations

import hashlib
import json
import logging
from contextlib import nullcontext
from datetime import UTC, datetime

from src.config import load_settings

LOGGER = logging.getLogger(__name__)


def identity(raw: dict) -> str:
    # A shared URL is not sufficient to distinguish publicly numbered lots.
    return hashlib.sha256(json.dumps([raw.get('source_url'), raw.get('external_id'),
        raw.get('lot_number'), raw.get('source_lots')], sort_keys=True, default=str).encode()).hexdigest()


def record_items(run_id: str | None, raws: list[dict], *, decision: str = 'discovered',
                 reason: str | None = None, canonical_url: str | None = None, connection=None) -> None:
    if not run_id or not raws:
        return
    settings = load_settings()
    if connection is None and not settings.get('supabase_db_url'):
        return
    from psycopg.types.json import Jsonb

    from src.storage.supabase_client import _postgres_connect
    now = datetime.now(UTC).isoformat()
    rows = []
    for raw in raws:
        evidence = {key: raw.get(key) for key in ('external_id','lot_number','source_lots',
            'sale_date','status','sale_procedure','source_sale_schedule','starting_price_eur',
            'surface_m2','habitable_surface_m2','carrez_surface_m2','land_surface_m2')}
        rows.append({'run_id': run_id, 'source_name': raw.get('source_name') or 'unknown',
            'source_url': raw.get('source_url') or '', 'identity_hash': identity(raw),
            'canonical_source_url': canonical_url or raw.get('source_url'),
            'decision': decision, 'reason': reason, 'evidence': json.loads(json.dumps(evidence, default=str)),
            'discovered_at': raw.get('_discovered_at') or now, 'updated_at': now, 'published_at': now if decision == 'published' else None})
    with nullcontext(connection) if connection is not None else _postgres_connect(str(settings['supabase_db_url'])) as db:
        db.execute("""insert into public.auction_collection_items
            (run_id,source_name,source_url,identity_hash,canonical_source_url,decision,reason,evidence,discovered_at,updated_at,published_at)
            select run_id,source_name,source_url,identity_hash,canonical_source_url,decision,reason,evidence,discovered_at,updated_at,published_at
            from jsonb_populate_recordset(null::public.auction_collection_items,%s)
            on conflict(run_id,source_name,identity_hash) do update set
              canonical_source_url=excluded.canonical_source_url, decision=excluded.decision,
              reason=excluded.reason,evidence=excluded.evidence,updated_at=excluded.updated_at,
              published_at=coalesce(auction_collection_items.published_at,excluded.published_at)
            where auction_collection_items.decision <> 'published' or excluded.decision='published'
            """, (Jsonb(rows),))


def record_sale_decisions(run_id: str | None, sales: list, *, decision: str, reason: str | None = None, connection=None) -> None:
    rows = []
    for sale in sales:
        LOGGER.info('Collection decision source=%s url=%s decision=%s reason=%s',
                    sale.source_name, sale.source_url, decision, reason)
        for url in set([sale.source_url, *(sale.source_urls or [])]):
            rows.append({'source_url': url, 'canonical_source_url': sale.source_url,
                         'reason': reason or ('merged_alias' if url != sale.source_url else None)})
    if not run_id or not rows:
        return
    settings = load_settings()
    if connection is None and not settings.get('supabase_db_url'):
        return
    from psycopg.types.json import Jsonb

    from src.storage.supabase_client import _postgres_connect
    with nullcontext(connection) if connection is not None else _postgres_connect(str(settings['supabase_db_url'])) as db:
        db.execute("""update public.auction_collection_items i set
            canonical_source_url=r.canonical_source_url, decision=%s,
            reason=r.reason,updated_at=now(),
            published_at=case when %s='published' then coalesce(i.published_at,now()) else i.published_at end
            from jsonb_to_recordset(%s) as r(source_url text,canonical_source_url text,reason text)
            where i.run_id=%s and i.source_url=r.source_url
              and (i.decision<>'published' or %s in ('published','quarantined'))
            """, (decision, decision, Jsonb(rows), run_id, decision))
