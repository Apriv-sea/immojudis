"""PostgreSQL regression coverage for the single-pass retention deadline."""

import os
from datetime import timedelta
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb
from test_autonomy_postgres import migration, setup

from src.storage.supabase_client import _postgres_connect

FAIRNESS_MIGRATION = "20260913103118_pipeline_queue_source_fairness.sql"
REPO_ROOT = Path(__file__).resolve().parents[3]


def _prepare(db) -> None:
    setup(db)
    db.execute(migration("20260913081411_recurring_source_detail_jobs.sql"))
    db.execute(migration(FAIRNESS_MIGRATION))
    db.execute(
        "update auction_pipeline_control set enabled=true,source_details_enabled=true"
    )
    db.execute(
        "update auction_source_state set enabled=true,suspended_until=null "
        "where source_name='licitor'"
    )


def _insert_edge_fixture(db, family: str) -> list[tuple[str, str]]:
    now = db.execute("select now()").fetchone()[0]
    prefix = f"deadline-{family}"
    cases = (
        ("null", None, {"status": "upcoming"}),
        ("reported", now - timedelta(days=5), {"status": "reported"}),
        ("expired", now - timedelta(days=5), {"status": "past"}),
    )
    job_types = ("source_detail", "pdf") if family == "all" else (
        ("source_detail",) if family == "source_detail" else ("pdf",)
    )
    for suffix, sale_date, raw_payload in cases:
        source_url = f"{prefix}-{suffix}"
        db.execute(
            "insert into auction_sales(source_url,source_name,status,sale_date,raw_payload) "
            "values (%s,'licitor','past',%s,%s)",
            (source_url, sale_date, Jsonb(raw_payload)),
        )
        for job_type in job_types:
            if job_type == "source_detail":
                db.execute(
                    """insert into auction_enrichment_jobs
                       (source_url,job_type,input_hash,detail_source_name,detail_source_url)
                       values (%s,%s,%s,'licitor',%s)""",
                    (source_url, job_type, f"{source_url}-{job_type}", source_url),
                )
            else:
                db.execute(
                    "insert into auction_enrichment_jobs(source_url,job_type,input_hash) "
                    "values (%s,%s,%s)",
                    (source_url, job_type, f"{source_url}-{job_type}"),
                )
    return [
        (f"{prefix}-null", job_type)
        for job_type in job_types
    ] + [
        (f"{prefix}-reported", job_type)
        for job_type in job_types
    ]


def _parity_query(family: str) -> str:
    assert family in {"source_detail", "enrichment", "all"}
    if family == "source_detail":
        body = """
          select j.id,j.source_url,j.job_type
          from public.auction_enrichment_jobs j
          join public.auction_sales s on s.source_url=j.source_url
          join public.auction_source_state state
            on state.source_name=j.detail_source_name
          {lateral}
          where (
            j.status in ('queued','failed')
            or (j.status='running' and coalesce(j.locked_at,j.updated_at)<now()-interval '30 minutes')
          )
            and j.next_attempt_at<=now()
            and j.attempt_count<j.max_attempts
            and j.job_type='source_detail'
            and exists (
              select 1 from public.auction_pipeline_control c
              where c.id and c.enabled and c.source_details_enabled
            )
            and state.enabled
            and (state.suspended_until is null or state.suspended_until<=now())
            and s.status in ('active','unknown','upcoming','postponed','past')
            and {retention}
            and not exists (
              select 1 from public.auction_enrichment_jobs active
              where active.source_url=j.source_url
                and active.status='running'
                and coalesce(active.locked_at,active.updated_at)>=now()-interval '30 minutes'
            )
        """
        order = """
          order by source_url,job_type
          limit 10
        """
    else:
        body = """
          select j.id,j.source_url,j.job_type
          from public.auction_enrichment_jobs j
          join public.auction_sales s on s.source_url=j.source_url
          {lateral}
          where (
            j.status in ('queued','failed')
            or (j.status='running' and coalesce(j.locked_at,j.updated_at)<now()-interval '30 minutes')
          )
            and j.next_attempt_at<=now()
            and j.attempt_count<j.max_attempts
            and (
              '{family}'='all'
              or ('{family}'='source_detail' and j.job_type='source_detail')
              or ('{family}'='enrichment' and j.job_type<>'source_detail')
            )
            and (
              j.job_type<>'source_detail'
              or (
                exists (
                  select 1 from public.auction_pipeline_control c
                  where c.id and c.enabled and c.source_details_enabled
                )
                and exists (
                  select 1 from public.auction_source_state state
                  where state.source_name=j.detail_source_name
                    and state.enabled
                    and (state.suspended_until is null or state.suspended_until<=now())
                )
              )
            )
            and s.status in ('active','unknown','upcoming','postponed','past')
            and {retention}
            and not exists (
              select 1 from public.auction_enrichment_jobs active
              where active.source_url=j.source_url
                and active.status='running'
                and coalesce(active.locked_at,active.updated_at)>=now()-interval '30 minutes'
            )
        """
        order = """
          order by ('{family}'='all' and job_type='source_detail') desc,
                   source_url,job_type
          limit 10
        """

    def candidate(variant: str) -> str:
        assert variant in {"current", "optimized"}
        lateral = "" if variant == "current" else """
          cross join lateral (
            select app_private.sale_retention_deadline(
              s.sale_date,s.status,s.sale_procedure,s.raw_payload
            ) as retention_deadline
            offset 0
          ) retention
        """
        retention = (
            "(app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) is null "
            "or app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload)>now())"
            if variant == "current"
            else "(retention.retention_deadline is null or retention.retention_deadline>now())"
        )
        return "select * from (" + body.format(
            family=family, lateral=lateral, retention=retention
        ) + order.format(family=family) + ") candidate"

    return f"""
      with current_candidates as ({candidate('current')}),
           optimized_candidates as ({candidate('optimized')})
      select
        coalesce(
          array_agg(current_candidates.source_url || '|' || current_candidates.job_type
                    order by current_candidates.source_url,current_candidates.job_type),
          '{{}}'::text[]
        ) as current_ids,
        coalesce(
          array_agg(optimized_candidates.source_url || '|' || optimized_candidates.job_type
                    order by optimized_candidates.source_url,optimized_candidates.job_type),
          '{{}}'::text[]
        ) as optimized_ids
      from current_candidates
      full join optimized_candidates
        on optimized_candidates.id=current_candidates.id
    """


@pytest.mark.parametrize("family", ["source_detail", "enrichment", "all"])
def test_deadline_lateral_preserves_edge_eligibility_and_id_parity(family: str):
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            expected = _insert_edge_fixture(db, family)

            current_ids, optimized_ids = db.execute(_parity_query(family)).fetchone()
            assert current_ids == optimized_ids
            assert set(current_ids) == set(
                f"{source_url}|{job_type}" for source_url, job_type in expected
            )

            claimed = db.execute(
                "select source_url,job_type from claim_auction_enrichment_jobs_family(%s,%s)",
                (family, 10),
            ).fetchall()
            assert set(claimed) == set(expected)
            assert db.execute(
                "select status,count(*) from auction_enrichment_jobs "
                "where source_url=%s group by status",
                (f"deadline-{family}-expired",),
            ).fetchall() == [("cancelled", 1 if family != "all" else 2)]
        finally:
            db.rollback()


def test_fairness_migration_has_single_pass_deadline_in_both_candidate_paths():
    sql = (REPO_ROOT / "supabase/migrations" / FAIRNESS_MIGRATION).read_text()
    assert sql.count("cross join lateral") == 2
    assert sql.count("retention.retention_deadline is null") == 2
    # The global cleanup is intentionally unchanged; this assertion prevents a
    # future optimization from silently weakening its expiry audit behavior.
    assert sql.count("app_private.sale_retention_deadline(") == 4
