"""PostgreSQL coverage for idempotent queue claim receipts."""

import os
import uuid
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta

import pytest
from test_autonomy_postgres import migration, setup

from src.storage import supabase_client
from src.storage.supabase_client import _postgres_connect

FAIRNESS_MIGRATION = "20260913103118_pipeline_queue_source_fairness.sql"
IDEMPOTENCY_MIGRATION = "20260913105127_pipeline_queue_claim_idempotency.sql"


def _prepare(db) -> None:
    setup(db)
    db.execute(migration("20260913081411_recurring_source_detail_jobs.sql"))
    db.execute(migration(FAIRNESS_MIGRATION))
    # Keep the disposable queue fixture small while exercising the existing
    # daily retention hook.  The queue migration must not replace the broader
    # run_data_retention wrapper owned by the information-agent migrations.
    db.execute(
        """create or replace function app_private.purge_expired_operational_data(
             p_now timestamptz default statement_timestamp()
           ) returns jsonb language sql security definer set search_path='' as $$
             select '{}'::jsonb
           $$"""
    )
    db.execute("create schema cron")
    db.execute(
        "create table cron.job(jobid bigint primary key,jobname text not null,command text not null)"
    )
    db.execute(
        """create or replace function cron.alter_job(
             p_jobid bigint, command text default null
           ) returns void language sql as $$
             update cron.job set command=$2 where jobid=$1
           $$"""
    )
    db.execute(
        "insert into cron.job(jobid,jobname,command) values "
        "(1,'immojudis-operational-history-retention','delete from cron.job_run_details;')"
    )
    db.execute(migration(IDEMPOTENCY_MIGRATION))
    assert "purge_auction_enrichment_claim_receipts" in db.execute(
        "select command from cron.job where jobid=1"
    ).fetchone()[0]
    db.execute("update auction_pipeline_control set enabled=true,source_details_enabled=true")
    db.execute(
        "update auction_source_state set enabled=true,suspended_until=null "
        "where source_name in ('licitor','vench')"
    )


def _insert_detail(db, source_url: str, source_name: str = "licitor") -> None:
    db.execute(
        "insert into auction_sales(source_url,source_name,status,sale_date) "
        "values (%s,%s,'upcoming',now()+interval '2 days')",
        (source_url, source_name),
    )
    db.execute(
        """insert into auction_enrichment_jobs
           (source_url,job_type,input_hash,detail_source_name,detail_source_url)
           values (%s,'source_detail',%s,%s,%s)""",
        (source_url, f"{source_url}-v1", source_name, source_url),
    )


def _claim(db, request_id: uuid.UUID, family: str = "source_detail", limit: int = 1):
    return db.execute(
        "select id,status,attempt_count,locked_at "
        "from claim_auction_enrichment_jobs_request(%s,%s,%s)",
        (request_id, family, limit),
    ).fetchall()


def _db_url() -> str | None:
    return os.getenv("PIPELINE_TEST_DB_URL")


def test_committed_claim_replays_exact_leases_without_claiming_next_slot():
    url = _db_url()
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            _insert_detail(db, "idempotent-first", "licitor")
            _insert_detail(db, "idempotent-second", "vench")
            request_id = uuid.UUID("00000000-0000-0000-0000-000000000101")

            first = _claim(db, request_id)
            replay = _claim(db, request_id)

            assert len(first) == 1
            assert replay == first
            assert db.execute(
                "select status,attempt_count from auction_enrichment_jobs "
                "where source_url='idempotent-second'"
            ).fetchone() == ("queued", 0)
            assert db.execute(
                "select count(*) from app_private.auction_enrichment_claim_receipts "
                "where request_id=%s",
                (request_id,),
            ).fetchone() == (1,)
            assert db.execute(
                "select has_function_privilege('anon', "
                "'public.claim_auction_enrichment_jobs_request(uuid,text,integer)', 'execute')"
            ).fetchone() == (False,)
            assert db.execute(
                "select has_function_privilege('service_role', "
                "'public.claim_auction_enrichment_jobs_request(uuid,text,integer)', 'execute')"
            ).fetchone() == (True,)
        finally:
            db.rollback()


def test_rollback_before_receipt_allows_same_request_to_claim_once():
    url = _db_url()
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            _insert_detail(db, "rollback-then-retry")
            request_id = uuid.UUID("00000000-0000-0000-0000-000000000102")

            with pytest.raises(RuntimeError, match="force rollback"):
                with db.transaction():
                    assert _claim(db, request_id)
                    raise RuntimeError("force rollback")

            assert db.execute(
                "select count(*) from app_private.auction_enrichment_claim_receipts "
                "where request_id=%s",
                (request_id,),
            ).fetchone() == (0,)
            assert db.execute(
                "select status,attempt_count from auction_enrichment_jobs "
                "where source_url='rollback-then-retry'"
            ).fetchone() == ("queued", 0)
            assert len(_claim(db, request_id)) == 1
        finally:
            db.rollback()


def test_empty_claim_is_receipted_and_does_not_claim_later_work():
    url = _db_url()
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            request_id = uuid.UUID("00000000-0000-0000-0000-000000000103")

            assert _claim(db, request_id) == []
            assert db.execute(
                "select snapshot from app_private.auction_enrichment_claim_receipts "
                "where request_id=%s",
                (request_id,),
            ).fetchone() == ([],)
            _insert_detail(db, "empty-then-added")
            assert _claim(db, request_id) == []
            assert db.execute(
                "select status,attempt_count from auction_enrichment_jobs "
                "where source_url='empty-then-added'"
            ).fetchone() == ("queued", 0)
        finally:
            db.rollback()


def test_persisted_backoff_blocks_distinct_requests_until_deadline():
    url = _db_url()
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            _insert_detail(db, "backoff-gated")
            first_request = uuid.UUID("00000000-0000-0000-0000-000000000108")
            second_request = uuid.UUID("00000000-0000-0000-0000-000000000109")
            third_request = uuid.UUID("00000000-0000-0000-0000-000000000110")

            db.execute(
                "update auction_pipeline_control "
                "set queue_claim_not_before=now()+interval '1 hour'"
            )
            assert _claim(db, first_request) == []
            assert _claim(db, second_request) == []
            assert db.execute(
                "select status,attempt_count from auction_enrichment_jobs "
                "where source_url='backoff-gated'"
            ).fetchone() == ("queued", 0)

            db.execute(
                "update auction_pipeline_control "
                "set queue_claim_not_before=now()-interval '1 second'"
            )
            assert len(_claim(db, third_request)) == 1
        finally:
            db.rollback()


def test_backoff_storage_advances_scheduler_deadline_without_shortening_it(monkeypatch):
    url = _db_url()
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            deadline = datetime.now(UTC) + timedelta(hours=1)
            monkeypatch.setattr(
                supabase_client,
                "_postgres_connect",
                lambda _url: nullcontext(db),
            )

            persisted = supabase_client._persist_queue_claim_backoff(
                {"supabase_db_url": url}, deadline
            )
            stored = db.execute(
                "select queue_claim_not_before,next_enrichment_at "
                "from auction_pipeline_control where id"
            ).fetchone()
            assert persisted == stored[0]
            assert stored[0] >= deadline
            assert stored[1] >= deadline

            shorter = deadline - timedelta(minutes=30)
            supabase_client._persist_queue_claim_backoff(
                {"supabase_db_url": url}, shorter
            )
            retained = db.execute(
                "select queue_claim_not_before,next_enrichment_at "
                "from auction_pipeline_control where id"
            ).fetchone()
            assert retained[0] >= deadline
            assert retained[1] >= deadline
        finally:
            db.rollback()


def test_daily_retention_purges_old_receipts_and_keeps_recent_replay():
    url = _db_url()
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            _insert_detail(db, "retention-replay")
            request_id = uuid.UUID("00000000-0000-0000-0000-000000000106")
            claimed = _claim(db, request_id)
            assert len(claimed) == 1
            db.execute(
                "update app_private.auction_enrichment_claim_receipts "
                "set created_at=now()-interval '29 days' where request_id=%s",
                (request_id,),
            )
            old_id = uuid.UUID("00000000-0000-0000-0000-000000000107")
            db.execute(
                "insert into app_private.auction_enrichment_claim_receipts "
                "(request_id,family,claim_limit,created_at,snapshot) "
                "values (%s,'source_detail',1,now()-interval '31 days','[]'::jsonb)",
                (old_id,),
            )

            assert db.execute(
                "select app_private.purge_auction_enrichment_claim_receipts(now())"
            ).fetchone()[0] == 1
            assert db.execute(
                "select count(*) from app_private.auction_enrichment_claim_receipts "
                "where request_id=%s",
                (old_id,),
            ).fetchone() == (0,)
            assert _claim(db, request_id) == claimed
        finally:
            db.rollback()


def test_request_id_argument_mismatch_is_rejected_without_new_claim():
    url = _db_url()
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            _insert_detail(db, "mismatch-family")
            request_id = uuid.UUID("00000000-0000-0000-0000-000000000104")
            assert len(_claim(db, request_id)) == 1

            with pytest.raises(Exception, match="different family or limit"):
                with db.transaction():
                    _claim(db, request_id, family="enrichment")
            assert db.execute(
                "select count(*) from auction_enrichment_jobs "
                "where status='running' and source_url='mismatch-family'"
            ).fetchone() == (1,)
        finally:
            db.rollback()


def test_stale_receipt_replays_empty_and_cannot_claim_a_new_slot():
    url = _db_url()
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            _insert_detail(db, "stale-first")
            request_id = uuid.UUID("00000000-0000-0000-0000-000000000105")
            claimed = _claim(db, request_id)
            assert len(claimed) == 1
            db.execute(
                "update auction_enrichment_jobs set locked_at=now()-interval '31 minutes' "
                "where source_url='stale-first'"
            )
            _insert_detail(db, "stale-second", "vench")

            assert _claim(db, request_id) == []
            assert db.execute(
                "select status,attempt_count from auction_enrichment_jobs "
                "where source_url='stale-second'"
            ).fetchone() == ("queued", 0)
        finally:
            db.rollback()
