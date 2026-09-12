"""Execute one SQL-scheduled unit with a hard process budget and durable status."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from uuid import UUID

from psycopg.types.json import Jsonb

from src.config import load_settings
from src.run_finalizer import register_run
from src.storage.supabase_client import _postgres_connect


def next_attempt(*, failures: int, access_denied: bool, retry_not_before: str | None,
                 now: datetime) -> datetime:
    delay = timedelta(hours=24) if access_denied and failures >= 2 else timedelta(minutes=min(360, 15 * 2 ** min(failures, 5)))
    deadline = now + delay
    if retry_not_before:
        try:
            other = datetime.fromisoformat(retry_not_before.replace('Z', '+00:00'))
            if other.tzinfo:
                deadline = max(deadline, other)
        except ValueError:
            pass
    return deadline


def finish_source(db_url: str, run_id: str) -> None:
    with _postgres_connect(db_url) as db:
        row = db.execute('select source,status,summary,errors from public.auction_runs where id=%s', (run_id,)).fetchone()
        source, status, summary, errors = row
        if source == 'enrichment-queue':
            return
        summary, errors = summary or {}, errors or {}
        coverage = (summary.get('scrape_coverage') or {}).get(source) or {}
        problems = errors.get(source) or []
        previous = db.execute('select consecutive_failures from public.auction_source_state where source_name=%s for update', (source,)).fetchone()
        failures = previous[0] + 1 if problems or status == 'failed' else 0
        denied = bool(coverage.get('access_denials')) or any('403' in str(e) or '401' in str(e) for e in problems)
        availability = 'access_denied' if denied else 'unavailable' if (problems or status == 'failed') and not coverage.get('listings_emitted') else 'partial' if coverage.get('coverage_complete') is not True else 'available'
        pending = db.execute("select count(*) from public.auction_collection_items where run_id=%s and decision in ('discovered','normalized','admitted','publication_failed','normalization_failed')", (run_id,)).fetchone()[0]
        complete = coverage.get('coverage_complete') is True
        publication_complete = complete and not pending and status == 'succeeded'
        now = datetime.now(UTC)
        deadline = next_attempt(failures=failures, access_denied=denied,
            retry_not_before=coverage.get('retry_not_before'), now=now) if failures else now + timedelta(hours=6)
        record_source_presence(db, run_id, source, availability, complete)
        db.execute("""update public.auction_source_state set
            availability=%s,coverage=%s,last_error=%s,consecutive_failures=%s,
            next_inventory_at=%s,suspended_until=%s,
            last_inventory_complete_at=case when %s then now() else last_inventory_complete_at end,
            last_publication_complete_at=case when %s then now() else last_publication_complete_at end,
            updated_at=now() where source_name=%s and last_run_id=%s""",
            (availability,Jsonb(coverage),json.dumps(problems or errors,ensure_ascii=False)[:2000] if failures else None,
             failures,deadline,deadline if denied or coverage.get('retry_not_before') else None,
             complete,publication_complete,source,run_id))


def record_source_presence(db, run_id: str, source: str, availability: str, complete: bool) -> None:
    # Only a certified full inventory can establish absence. No deletion follows it.
    db.execute("""update public.auction_sales s set raw_payload=jsonb_set(
        coalesce(s.raw_payload,'{}'),'{source_presence}',
        coalesce(s.raw_payload->'source_presence','{}') || jsonb_build_object(%s::text,
          coalesce(s.raw_payload->'source_presence'->%s::text,'{}') || jsonb_build_object(
            'availability',%s::text,'attempted_at',now(),'run_id',%s::text)
          || case when %s then jsonb_build_object(
            'state',case when exists(select 1 from public.auction_collection_items i
              where i.run_id=%s and (i.source_url=s.source_url or i.canonical_source_url=s.source_url))
              then 'present' else 'absent' end,'checked_at',now()) else '{}'::jsonb end))
        where s.source_name=%s or exists(select 1 from public.auction_collection_items i
          where i.run_id=%s and i.canonical_source_url=s.source_url)""",
        (source,source,availability,run_id,complete,run_id,source,run_id))


def execute(run_id: str) -> int:
    run_id = str(UUID(run_id))
    settings = load_settings()
    db_url = str(settings.get('supabase_db_url') or '')
    if not db_url:
        raise RuntimeError('Automatic execution requires transactional PostgreSQL')
    # Claim once even when GitHub dispatch was retried after an uncertain response.
    with _postgres_connect(db_url) as db:
        row = db.execute("""update public.auction_runs set status='running',started_at=now(),updated_at=now()
            where id=%s and scheduler_owned and status='queued' returning source""", (run_id,)).fetchone()
    if not row:
        print('Scheduled run already claimed, finished or invalid; nothing to execute')
        return 0
    source = row[0]
    register_run(run_id)
    env = {**os.environ, 'PIPELINE_AUTONOMOUS_RUN_ID':run_id, 'PIPELINE_ENRICHMENT_BUDGET_SECONDS':'1200', 'PIPELINE_ENRICHMENT_MAX_JOBS':'40', 'REPLICATE_CANCEL_AFTER':'5m',
           'CADASTRE_ENRICH_ENABLED':'false', 'DPE_ENRICH_ENABLED':'false'}
    if source == 'enrichment-queue':
        command = [sys.executable,'-m','src.queued_runner','--enrichment-only']
        budget = 25 * 60
    else:
        from src.main import SOURCE_NAMES
        if source not in SOURCE_NAMES:
            raise ValueError('Unknown scheduled source')
        command = [sys.executable,'-m','src.main','--source',source,'--run-id',run_id,'--no-llm','--no-heavy-enrichment']
        budget = 35 * 60
    failure = None
    execution_started = datetime.now(UTC)
    try:
        result = subprocess.run(command, env=env, timeout=budget, check=False)
        code = result.returncode
    except subprocess.TimeoutExpired:
        code, failure = 1, 'Execution budget exceeded; committed checkpoints preserved'
    except Exception as exc:
        code, failure = 1, str(exc)[:1000]
    with _postgres_connect(db_url) as db:
        summary = {"scheduler_budget_seconds":budget,"execution_seconds":(datetime.now(UTC)-execution_started).total_seconds()}
        if source == 'enrichment-queue':
            counts = dict(db.execute("select status,count(*) from public.auction_enrichment_jobs where updated_at>=%s group by status", (execution_started,)).fetchall())
            summary['enrichment_jobs'] = counts
            if counts.get('failed'):
                code, failure = 1, 'One or more enrichment jobs failed; retained for bounded retry'
        summary['completion_status'] = 'interrupted' if code else 'complete'
        db.execute("""update public.auction_runs set status=%s,finished_at=now(),updated_at=now(),
            errors=coalesce(errors,'{}') || %s,
            summary=coalesce(summary,'{}') || %s
            where id=%s and status in ('queued','running')""",
            ('failed' if code else 'succeeded', Jsonb({'runner':[failure or 'Worker failed']} if code else {}),
             Jsonb(summary),run_id))
        db.execute("update public.auction_runs set summary=coalesce(summary,'{}') || %s where id=%s", (Jsonb(summary),run_id))
    finish_source(db_url, run_id)
    return code


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    raise SystemExit(execute(parser.parse_args().run_id))
