"""Execute one SQL-scheduled unit with a hard process budget and durable status."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from src.config import load_settings
from src.run_finalizer import register_run
from src.storage.supabase_client import _postgres_connect

INVENTORY_CADENCE = timedelta(hours=6)
INVENTORY_DISPATCH_MARGIN = timedelta(minutes=45)
NEAR_SALE_HORIZON = timedelta(days=7)
ACTIVE_LISTING_STATUSES = frozenset({'active', 'upcoming', 'postponed', 'unknown'})


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


def _aware_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        candidate = value
    elif isinstance(value, str):
        try:
            candidate = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            return None
    else:
        return None
    if candidate.tzinfo is None or candidate.utcoffset() is None:
        return None
    return candidate.astimezone(UTC)


def _near_sale(row: dict[str, object], now: datetime) -> bool:
    evidence = row.get('evidence')
    evidence = evidence if isinstance(evidence, dict) else {}
    status = str(row.get('status') or evidence.get('status') or '').lower()
    if status not in ACTIVE_LISTING_STATUSES:
        return False
    sale_date = _aware_timestamp(row.get('sale_date')) or _aware_timestamp(evidence.get('sale_date'))
    return sale_date is not None and now <= sale_date <= now + NEAR_SALE_HORIZON


def _source_check_times(payload: object, *, source: str, source_url: str, now: datetime,
                        allow_checkpoint_checked_at: bool = False) -> list[datetime]:
    if not isinstance(payload, dict):
        return []
    result: list[datetime] = []
    if allow_checkpoint_checked_at:
        checkpoint_checked_at = _aware_timestamp(payload.get('_checkpoint_checked_at'))
        if checkpoint_checked_at is not None and checkpoint_checked_at <= now:
            result.append(checkpoint_checked_at)
    checks = payload.get('source_checks')
    if isinstance(checks, dict):
        check = checks.get(source_url)
        if isinstance(check, dict) and (not check.get('source_name') or check.get('source_name') == source):
            checked_at = _aware_timestamp(check.get('checked_at'))
            if checked_at is not None and checked_at <= now:
                result.append(checked_at)
    nested = payload.get('raw_payload')
    if isinstance(nested, dict):
        result.extend(_source_check_times(nested, source=source, source_url=source_url, now=now))
    return result


def _row_payloads(row: dict[str, object]) -> Iterable[tuple[object, bool]]:
    # A catalogue raw_payload can contain a stale private checkpoint marker
    # copied from another source. Only the SQL row selected for this run/URL
    # and a matching observation are allowed to carry that marker.
    yield row.get('raw_payload'), False
    yield row.get('checkpoint_payload'), True
    observations = row.get('observations')
    if isinstance(observations, list):
        for observation in observations:
            if not isinstance(observation, dict):
                continue
            if observation.get('source_url') == row.get('source_url'):
                yield observation.get('raw_payload') or observation, True


def next_inventory_deadline(*, now: datetime, started_at: object | None, source: str,
                            evidence_rows: Iterable[dict[str, object]]) -> datetime:
    """Return a bounded source deadline from verified rows in the real run.

    ``evidence_rows`` is deliberately supplied by the current run's collection
    items. A stale alias which was absent from this run cannot move the
    deadline backwards. A checkpoint timestamp is the time the detail was
    actually checked, while ``started_at`` is only a conservative fallback for
    a row observed by this run without a usable check timestamp.
    """
    current = _aware_timestamp(now)
    if current is None:
        raise ValueError('now must be timezone-aware')
    run_started = _aware_timestamp(started_at)
    anchors: list[datetime] = []
    for row in evidence_rows:
        if not _near_sale(row, current):
            continue
        source_url = str(row.get('source_url') or '')
        checks: list[datetime] = []
        if source_url:
            for payload, allow_checkpoint_checked_at in _row_payloads(row):
                checks.extend(_source_check_times(
                    payload, source=source, source_url=source_url, now=current,
                    allow_checkpoint_checked_at=allow_checkpoint_checked_at,
                ))
        if checks:
            # A stale checkpoint marker must not override a newer source check
            # for the same URL. The inventory cadence is based on the oldest
            # URL after each URL's strongest reusable evidence is selected.
            anchors.append(max(checks))
        elif run_started is not None and run_started <= current:
            anchors.append(run_started)
    if not anchors:
        # No close listing was evidenced by this run. Keep the ordinary six
        # hour cadence instead of inheriting an old alias/checkpoint forever.
        return current + INVENTORY_CADENCE
    return max(current, min(anchors) + INVENTORY_CADENCE - INVENTORY_DISPATCH_MARGIN)


def _schedule_evidence_rows(db: Any, run_id: str, source: str) -> list[dict[str, object]]:
    rows = db.execute("""select i.source_url,i.canonical_source_url,i.evidence,
            s.sale_date,s.status,s.raw_payload,s.observations,c.payload
        from public.auction_collection_items i
        left join public.auction_sales s
          on s.source_url=coalesce(i.canonical_source_url,i.source_url)
        left join public.auction_collection_checkpoints c
          on c.run_id=i.run_id and c.source_url=i.source_url
        where i.run_id=%s and i.source_name=%s""", (run_id, source)).fetchall()
    return [
        {
            'source_url': row[0],
            'canonical_source_url': row[1],
            'evidence': row[2],
            'sale_date': row[3],
            'status': row[4],
            'raw_payload': row[5],
            'observations': row[6],
            'checkpoint_payload': row[7],
        }
        for row in rows
    ]


def finish_source(db_url: str, run_id: str) -> None:
    with _postgres_connect(db_url) as db:
        row = db.execute('select source,status,summary,errors,started_at from public.auction_runs where id=%s', (run_id,)).fetchone()
        source, status, summary, errors, started_at = row
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
        if failures:
            # Retry-After and persistent access refusals retain their existing
            # bounded policy and must not be shortened by freshness cadence.
            deadline = next_attempt(failures=failures, access_denied=denied,
                retry_not_before=coverage.get('retry_not_before'), now=now)
        else:
            deadline = next_inventory_deadline(
                now=now,
                started_at=started_at,
                source=source,
                evidence_rows=_schedule_evidence_rows(db, run_id, source),
            )
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
        where s.source_name=%s or s.raw_payload->'source_presence' ? %s
          or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(s.observations)='array'
            then s.observations else '[]'::jsonb end) o where o.value->>'source_name'=%s)
          or exists(select 1 from public.auction_collection_items i
          where i.run_id=%s and i.canonical_source_url=s.source_url)""",
        (source,source,availability,run_id,complete,run_id,source,source,source,run_id))


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
