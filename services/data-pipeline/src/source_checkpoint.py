"""Short-lived, source-scoped detail checkpoints for interrupted collection runs."""
from __future__ import annotations

import atexit
import copy
import hashlib
import json
import os
from datetime import UTC, datetime
from functools import lru_cache

from psycopg.types.json import Jsonb

from src.config import load_settings


@lru_cache(maxsize=1)
def _context():
    run_id = os.getenv('PIPELINE_AUTONOMOUS_RUN_ID')
    db_url = load_settings().get('supabase_db_url') if run_id else None
    if not run_id or not db_url:
        return None
    from src.storage.supabase_client import _postgres_connect
    with _postgres_connect(str(db_url)) as db:
        rows = db.execute("""select distinct on(c.source_url) c.source_url,c.signature,c.payload,c.observed_at
          from public.auction_collection_checkpoints c join public.auction_runs r on r.id=c.run_id
          where r.status='failed' and c.observed_at>now()-interval '6 hours'
            and r.source=(select source from public.auction_runs where id=%s)
          order by c.source_url,c.observed_at desc""", (run_id,)).fetchall()
    return str(db_url),run_id,{url:(signature,payload,observed) for url,signature,payload,observed in rows}


def restore_detail(sale: dict) -> bool:
    context = _context()
    if not context:
        sale.setdefault('_discovered_at', datetime.now(UTC).isoformat())
        return False
    # Compare the whole new public list card, not just a price/date pair.
    signature = hashlib.sha256(json.dumps({key:value for key,value in sale.items() if not key.startswith('_')}, sort_keys=True, default=str).encode()).hexdigest()
    sale.setdefault('_discovered_at', datetime.now(UTC).isoformat())
    sale['_checkpoint_signature'] = signature
    cached = context[2].get(str(sale.get('source_url') or ''))
    if cached is None or cached[0] != signature:
        return False
    sale.update(cached[1])
    sale['_checkpoint_checked_at'] = cached[2].isoformat()
    sale['_checkpoint_restored'] = True
    return True


_publisher = None
_pending = []
_connections = []


def configure_publisher(callback=None):
    global _publisher
    _publisher = callback
    _pending.clear()


def flush_publications():
    if _publisher and _pending:
        batch = list(_pending)
        _pending.clear()
        _publisher(batch)


def close_checkpoint_connections():
    while _connections:
        context = _connections.pop()
        context.__exit__(None, None, None)


atexit.register(close_checkpoint_connections)


class CheckpointSales(list):
    def __init__(self):
        super().__init__()
        self._db = None

    def append(self, sale):
        context = _context()
        if context and sale.get('_checkpoint_signature') and not (sale.get('_detail_fetch_failed') or sale.get('_known_unchanged') or sale.get('operator_detail_status') == 'failed'):
            from src.storage.supabase_client import _postgres_connect
            observed = sale.setdefault('_checkpoint_checked_at', datetime.now(UTC).isoformat())
            payload = json.loads(json.dumps(sale, default=str))
            if self._db is None:
                connection_context = _postgres_connect(context[0])
                self._db = connection_context.__enter__()
                _connections.append(connection_context)
            with self._db.transaction():
                db = self._db
                db.execute("""insert into public.auction_collection_checkpoints(run_id,source_url,signature,payload,observed_at)
                  values(%s,%s,%s,%s,%s) on conflict(run_id,source_url) do update set
                    signature=excluded.signature,payload=excluded.payload,observed_at=excluded.observed_at""",
                  (context[1],sale['source_url'],sale['_checkpoint_signature'],Jsonb(payload),observed))
                from src.collection_evidence import record_items
                record_items(context[1], [sale], connection=db)
        super().append(sale)
        if _publisher:
            _pending.append(copy.deepcopy(sale))
            if len(_pending) >= 25:
                flush_publications()
