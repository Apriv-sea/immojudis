"""PostgreSQL coverage for explicit queue-family claims and lease safety."""
import os
from datetime import timedelta

import pytest
from test_autonomy_postgres import migration, setup

from src.storage.supabase_client import _postgres_connect

FAIR_CAPACITY_MIGRATION = "20260913091614_pipeline_queue_fair_capacity.sql"


def _prepare(db) -> None:
    setup(db)
    db.execute(migration("20260913081411_recurring_source_detail_jobs.sql"))
    db.execute(migration(FAIR_CAPACITY_MIGRATION))
    db.execute("update auction_pipeline_control set enabled=true, source_details_enabled=true")
    db.execute(
        "update auction_source_state set enabled=true, suspended_until=null "
        "where source_name in ('licitor','vench')"
    )


def test_family_claims_partition_work_and_prioritizes_near_sales():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            now = db.execute("select now()").fetchone()[0]
            db.execute(
                """insert into auction_sales(source_url, source_name, status, sale_date)
                   values ('detail-near','licitor','upcoming',%s),
                          ('detail-far','licitor','upcoming',%s),
                          ('general-near','licitor','upcoming',%s),
                          ('general-far','licitor','upcoming',%s)""",
                (
                    now + timedelta(days=2),
                    now + timedelta(days=30),
                    now + timedelta(days=2),
                    now + timedelta(days=30),
                ),
            )
            db.execute(
                """insert into auction_enrichment_jobs
                   (source_url, job_type, input_hash, detail_source_name, detail_source_url, priority)
                   values ('detail-near','source_detail','detail-near-v1','licitor','detail-near',0),
                          ('detail-far','source_detail','detail-far-v1','licitor','detail-far',0)"""
            )
            db.execute(
                """insert into auction_enrichment_jobs(source_url, job_type, input_hash, priority)
                   values ('general-near','pdf','general-near-v1',0),
                          ('general-far','pdf','general-far-v1',0)"""
            )

            detail_rows = db.execute(
                "select source_url,job_type from claim_auction_enrichment_jobs_family(%s,%s)",
                ("source_detail", 10),
            ).fetchall()
            assert [row[0] for row in detail_rows] == ["detail-near", "detail-far"]
            assert {row[1] for row in detail_rows} == {"source_detail"}

            general_rows = db.execute(
                "select source_url,job_type from claim_auction_enrichment_jobs_family(%s,%s)",
                ("enrichment", 10),
            ).fetchall()
            assert [row[0] for row in general_rows] == ["general-near", "general-far"]
            assert {row[1] for row in general_rows} == {"pdf"}

            db.execute(
                "insert into auction_sales(source_url,source_name,status,sale_date) "
                "values ('legacy-wrapper','licitor','upcoming',%s)",
                (now + timedelta(days=2),),
            )
            db.execute(
                "insert into auction_enrichment_jobs(source_url,job_type,input_hash) "
                "values ('legacy-wrapper','pdf','legacy-v1')"
            )
            assert db.execute(
                "select source_url from claim_auction_enrichment_jobs(10)"
            ).fetchall() == [("legacy-wrapper",)]
        finally:
            db.rollback()


def test_paused_detail_source_is_not_claimed():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            db.execute("update auction_source_state set suspended_until=now()+interval '1 day' where source_name='vench'")
            db.execute(
                "insert into auction_sales(source_url,source_name,status,sale_date) "
                "values ('paused-detail','licitor','upcoming',now()+interval '2 days')"
            )
            db.execute(
                """insert into auction_enrichment_jobs
                   (source_url,job_type,input_hash,detail_source_name,detail_source_url)
                   values ('paused-detail','source_detail','paused-v1','vench','paused-detail')"""
            )

            assert db.execute(
                "select count(*) from claim_auction_enrichment_jobs_family(%s,%s)",
                ("source_detail", 1),
            ).fetchone()[0] == 0
            assert db.execute(
                "select status,attempt_count from auction_enrichment_jobs where source_url='paused-detail'"
            ).fetchone() == ("queued", 0)
        finally:
            db.rollback()


def test_family_claim_reclaims_expired_lease_and_fails_exhausted_lease():
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

            rows = db.execute(
                "select source_url,attempt_count from claim_auction_enrichment_jobs_family(%s,%s)",
                ("enrichment", 10),
            ).fetchall()
            assert rows == [("lease-retry", 2)]
            assert db.execute(
                "select status,locked_at from auction_enrichment_jobs where source_url='lease-exhausted'"
            ).fetchone() == ("failed", None)
        finally:
            db.rollback()
