"""PostgreSQL lifecycle tests for the autonomous GitHub dispatch lease."""
import os

import pytest
from test_autonomy_postgres import migration, setup

from src.storage.supabase_client import _postgres_connect

DISPATCH_MIGRATION = "20260913091558_pipeline_dispatch_retries.sql"


def prepare(db):
    setup(db)
    db.execute(migration("20260913081411_recurring_source_detail_jobs.sql"))
    db.execute(migration(DISPATCH_MIGRATION))
    db.execute("update auction_pipeline_control set enabled=true, source_details_enabled=false")
    db.execute("update auction_source_state set enabled=true where source_name='licitor'")


def due(db, run_id):
    db.execute(
        """update auction_runs
           set summary=jsonb_set(summary,'{github_dispatch,next_attempt_at}',
             to_jsonb((now()-interval '1 second')::text))
         where id=%s""",
        (run_id,),
    )


def test_dispatch_retries_same_run_four_times_then_waits_for_lease():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            prepare(db)
            first = db.execute("select claim_autonomous_pipeline_run()").fetchone()[0]
            assert first["attempt"] == 1
            run_id = first["id"]

            for attempt in range(1, 4):
                result = db.execute(
                    "select record_autonomous_pipeline_dispatch(%s,%s,'rejected',500,NULL,true,'HTTP 500')",
                    (run_id, attempt),
                ).fetchone()[0]
                assert result["updated"] is True
                due(db, run_id)
                retry = db.execute("select claim_autonomous_pipeline_run()").fetchone()[0]
                assert retry["id"] == run_id
                assert retry["attempt"] == attempt + 1

            result = db.execute(
                "select record_autonomous_pipeline_dispatch(%s,4,'rejected',500,NULL,true,'HTTP 500')",
                (run_id,),
            ).fetchone()[0]
            assert result["state"] == "terminal"
            assert db.execute("select claim_autonomous_pipeline_run()").fetchone()[0] is None
            db.execute(
                """update auction_runs
                   set summary=jsonb_set(summary,'{github_dispatch,lease_until}',
                     to_jsonb((now()-interval '1 second')::text))
                 where id=%s""",
                (run_id,),
            )
            replacement = db.execute("select claim_autonomous_pipeline_run()").fetchone()[0]
            assert replacement["id"] != run_id
            assert db.execute("select status from auction_runs where id=%s", (run_id,)).fetchone()[0] == "failed"
        finally:
            db.rollback()


def test_worker_started_before_result_cannot_be_failed_or_redispatched():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            prepare(db)
            first = db.execute("select claim_autonomous_pipeline_run()").fetchone()[0]
            run_id = first["id"]
            db.execute("update auction_runs set status='running',started_at=now() where id=%s", (run_id,))
            result = db.execute(
                "select record_autonomous_pipeline_dispatch(%s,1,'rejected',500,NULL,true,'late response')",
                (run_id,),
            ).fetchone()[0]
            assert result["updated"] is False
            assert result["reason"] == "worker_or_terminal_state"
            assert db.execute("select claim_autonomous_pipeline_run()").fetchone()[0] is None
            assert db.execute("select count(*) from auction_runs").fetchone()[0] == 1
        finally:
            db.rollback()


def test_retry_after_extends_dispatch_lease_and_legacy_queued_run_is_reused():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            prepare(db)
            first = db.execute("select claim_autonomous_pipeline_run()").fetchone()[0]
            run_id = first["id"]
            db.execute(
                "select record_autonomous_pipeline_dispatch(%s,1,'rejected',429,now()+interval '2 hours',true,'rate limited')",
                (run_id,),
            )
            metadata = db.execute(
                "select summary->'github_dispatch' from auction_runs where id=%s", (run_id,)
            ).fetchone()[0]
            assert metadata["state"] == "retry_wait"
            assert metadata["next_attempt_at"] >= metadata["retry_after_at"]
            assert db.execute("select claim_autonomous_pipeline_run()").fetchone()[0] is None
            due(db, run_id)
            retry = db.execute("select claim_autonomous_pipeline_run()").fetchone()[0]
            assert retry["id"] == run_id
            assert retry["attempt"] == 2

            db.execute("update auction_runs set status='failed',finished_at=now() where id=%s", (run_id,))
            # A pre-migration queued automatic run has no dispatch metadata.
            legacy = db.execute(
                """insert into auction_runs(source,status,scheduler_owned,summary)
                   values ('licitor','queued',true,'{"trigger":"autonomous","mode":"collect"}')
                   returning id"""
            ).fetchone()[0]
            db.execute("update auction_runs set created_at=now()-interval '16 minutes' where id=%s", (legacy,))
            reclaimed = db.execute("select claim_autonomous_pipeline_run()").fetchone()[0]
            assert reclaimed["id"] == str(legacy)
            assert reclaimed["attempt"] == 2
        finally:
            db.rollback()


def test_dispatch_result_is_idempotent_after_known_result():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            prepare(db)
            first = db.execute("select claim_autonomous_pipeline_run()").fetchone()[0]
            run_id = first["id"]
            accepted = db.execute(
                "select record_autonomous_pipeline_dispatch(%s,1,'accepted',204,NULL,false,'accepted')",
                (run_id,),
            ).fetchone()[0]
            assert accepted["state"] == "accepted"
            late_accepted = db.execute(
                "select record_autonomous_pipeline_dispatch(%s,1,'unknown',NULL,NULL,true,'late timeout')",
                (run_id,),
            ).fetchone()[0]
            assert late_accepted["updated"] is False
            assert late_accepted["reason"] == "result_already_recorded"
            accepted_metadata = db.execute(
                "select summary->'github_dispatch' from auction_runs where id=%s", (run_id,)
            ).fetchone()[0]
            assert accepted_metadata["state"] == "accepted"
            assert accepted_metadata["last_status"] == 204

            db.execute("update auction_runs set status='failed',finished_at=now() where id=%s", (run_id,))
            retry_id = db.execute(
                """insert into auction_runs(source,status,scheduler_owned,summary)
                   values ('licitor','queued',true,jsonb_build_object(
                     'github_dispatch',jsonb_build_object(
                       'version',1,'attempt',1,'max_attempts',4,'state','in_flight',
                       'next_attempt_at',now(),'lease_until',now()+interval '60 minutes')))
                   returning id"""
            ).fetchone()[0]
            retry_result = db.execute(
                "select record_autonomous_pipeline_dispatch(%s,1,'rejected',429,now()+interval '2 hours',true,'rate limited')",
                (retry_id,),
            ).fetchone()[0]
            assert retry_result["state"] == "retry_wait"
            before_late = db.execute(
                "select summary->'github_dispatch' from auction_runs where id=%s", (retry_id,)
            ).fetchone()[0]
            late_retry = db.execute(
                "select record_autonomous_pipeline_dispatch(%s,1,'unknown',NULL,NULL,true,'late timeout')",
                (retry_id,),
            ).fetchone()[0]
            assert late_retry["updated"] is False
            assert late_retry["reason"] == "result_already_recorded"
            after_late = db.execute(
                "select summary->'github_dispatch' from auction_runs where id=%s", (retry_id,)
            ).fetchone()[0]
            assert after_late == before_late
            assert after_late["state"] == "retry_wait"
            assert after_late["last_status"] == 429
        finally:
            db.rollback()
