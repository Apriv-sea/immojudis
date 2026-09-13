"""PostgreSQL coverage for source-detail claim fairness and lease safety."""

import os
from datetime import timedelta

import pytest
from test_autonomy_postgres import migration, setup

from src.storage.supabase_client import _postgres_connect

FAIRNESS_MIGRATION = "20260913103118_pipeline_queue_source_fairness.sql"


def _prepare(db) -> None:
    setup(db)
    db.execute(migration("20260913081411_recurring_source_detail_jobs.sql"))
    db.execute(migration(FAIRNESS_MIGRATION))
    db.execute("update auction_pipeline_control set enabled=true,source_details_enabled=true")
    db.execute(
        "update auction_source_state set enabled=true,suspended_until=null "
        "where source_name in ('licitor','vench')"
    )


def _insert_detail(db, source_url: str, source_name: str, *, sale_date, priority: int = 0) -> None:
    db.execute(
        "insert into auction_sales(source_url,source_name,status,sale_date) values (%s,%s,'upcoming',%s)",
        (source_url, source_name, sale_date),
    )
    db.execute(
        """insert into auction_enrichment_jobs
           (source_url,job_type,input_hash,detail_source_name,detail_source_url,priority)
           values (%s,'source_detail',%s,%s,%s,%s)""",
        (source_url, f"{source_url}-v1", source_name, source_url, priority),
    )


def test_source_detail_claims_round_robin_and_records_only_claimed_sources():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            now = db.execute("select now()").fetchone()[0]
            # Licitor has more work. A batch must still take the first rank
            # from each source before taking Licitor's second rank.
            _insert_detail(db, "licitor-near", "licitor", sale_date=now + timedelta(days=2))
            _insert_detail(db, "licitor-far", "licitor", sale_date=now + timedelta(days=20), priority=50)
            _insert_detail(db, "vench-near", "vench", sale_date=now + timedelta(days=2))
            _insert_detail(db, "vench-far", "vench", sale_date=now + timedelta(days=20), priority=50)

            claimed = db.execute(
                "select source_url from claim_auction_enrichment_jobs_family(%s,%s)",
                ("source_detail", 4),
            ).fetchall()
            assert [row[0] for row in claimed] == [
                "licitor-near",
                "vench-near",
                "licitor-far",
                "vench-far",
            ]
            assert db.execute(
                "select source_name from auction_source_state "
                "where source_name in ('licitor','vench') and last_detail_claim_at is not null "
                "order by source_name"
            ).fetchall() == [("licitor",), ("vench",)]

            # Move Licitor's source clock back. The next round's first rank
            # must prefer it, while an unclaimed Vench source is untouched.
            old_vench_claim = db.execute(
                "select last_detail_claim_at from auction_source_state where source_name='vench'"
            ).fetchone()[0]
            db.execute(
                "update auction_enrichment_jobs set status='completed',locked_at=null "
                "where source_url in ('licitor-near','licitor-far','vench-near','vench-far')"
            )
            db.execute(
                "update auction_source_state set last_detail_claim_at=now()-interval '1 hour' "
                "where source_name='licitor'"
            )
            _insert_detail(db, "licitor-next", "licitor", sale_date=now + timedelta(days=3))
            _insert_detail(db, "vench-next", "vench", sale_date=now + timedelta(days=3))
            assert db.execute(
                "select source_url from claim_auction_enrichment_jobs_family(%s,%s)",
                ("source_detail", 1),
            ).fetchall() == [("licitor-next",)]
            assert db.execute(
                "select last_detail_claim_at from auction_source_state where source_name='vench'"
            ).fetchone()[0] == old_vench_claim
        finally:
            db.rollback()


def test_paused_detail_source_stays_queued_and_enrichment_family_remains_separate():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            now = db.execute("select now()").fetchone()[0]
            db.execute("update auction_source_state set suspended_until=now()+interval '1 day' where source_name='vench'")
            _insert_detail(db, "paused-detail", "vench", sale_date=now + timedelta(days=2))
            _insert_detail(db, "active-detail", "licitor", sale_date=now + timedelta(days=2))
            db.execute(
                "insert into auction_sales(source_url,source_name,status,sale_date) "
                "values ('general-work','licitor','upcoming',now()+interval '2 days')"
            )
            db.execute(
                "insert into auction_enrichment_jobs(source_url,job_type,input_hash) "
                "values ('general-work','pdf','general-v1')"
            )

            assert db.execute(
                "select source_url from claim_auction_enrichment_jobs_family(%s,%s)",
                ("source_detail", 10),
            ).fetchall() == [("active-detail",)]
            assert db.execute(
                "select status,attempt_count from auction_enrichment_jobs where source_url='paused-detail'"
            ).fetchone() == ("queued", 0)
            assert db.execute(
                "select last_detail_claim_at from auction_source_state where source_name='vench'"
            ).fetchone()[0] is None

            assert db.execute(
                "select source_url,job_type from claim_auction_enrichment_jobs_family(%s,%s)",
                ("enrichment", 10),
            ).fetchall() == [("general-work", "pdf")]
        finally:
            db.rollback()


def test_dated_near_sale_precedes_undated_high_priority_job_within_source():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            now = db.execute("select now()").fetchone()[0]
            _insert_detail(db, "dated-near", "licitor", sale_date=now + timedelta(days=2))
            _insert_detail(db, "undated-high-priority", "licitor", sale_date=None, priority=1000)

            assert db.execute(
                "select source_url from claim_auction_enrichment_jobs_family(%s,%s)",
                ("source_detail", 2),
            ).fetchall() == [("dated-near",), ("undated-high-priority",)]
        finally:
            db.rollback()


def test_expired_lease_is_reclaimed_and_exhausted_lease_is_failed():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            db.execute(
                """insert into auction_sales(source_url,source_name,status,sale_date)
                   values ('lease-retry','licitor','upcoming',now()+interval '2 days'),
                          ('lease-exhausted','licitor','upcoming',now()+interval '2 days')"""
            )
            db.execute(
                """insert into auction_enrichment_jobs
                   (source_url,job_type,input_hash,status,attempt_count,locked_at)
                   values ('lease-retry','pdf','lease-retry-v1','running',1,now()-interval '40 minutes'),
                          ('lease-exhausted','pdf','lease-exhausted-v1','running',4,now()-interval '40 minutes')"""
            )
            assert db.execute(
                "select source_url,attempt_count from claim_auction_enrichment_jobs_family(%s,%s)",
                ("enrichment", 10),
            ).fetchall() == [("lease-retry", 2)]
            assert db.execute(
                "select status,locked_at from auction_enrichment_jobs where source_url='lease-exhausted'"
            ).fetchone() == ("failed", None)
        finally:
            db.rollback()
