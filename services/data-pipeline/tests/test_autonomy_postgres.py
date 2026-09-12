import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from src.autonomous_runner import next_attempt
from src.storage.supabase_client import _postgres_connect

ROOT = Path(__file__).resolve().parents[3]


def migration(name):
    return (ROOT / 'supabase/migrations' / name).read_text().removeprefix('begin;').removesuffix('commit;\n')


def setup(db):
    db.execute('create schema if not exists app_private')
    for role in ('anon', 'authenticated', 'service_role'):
        db.execute(f"do $$ begin if not exists(select from pg_roles where rolname='{role}') then create role {role}; end if; end $$")
    db.execute("""create table auction_runs(id uuid primary key default gen_random_uuid(),source text,status text,
        use_llm boolean,summary jsonb default '{}',errors jsonb default '{}',created_at timestamptz default now(),
        updated_at timestamptz default now(),started_at timestamptz,finished_at timestamptz)""")
    db.execute("""create table auction_sales(source_url text primary key,status text default 'upcoming',
        updated_at timestamptz default now(),source_name text,sale_date timestamptz,sale_procedure jsonb default '{}',raw_payload jsonb default '{}',observations jsonb default '[]')""")
    original = migration('20260819105011_add_structured_surface_reasoning_queue.sql')
    db.execute(original[original.index('create table if not exists public.auction_enrichment_jobs'):original.index('create index if not exists auction_surface_measurements')])
    db.execute(migration('20260912110654_pipeline_autonomy_evidence.sql'))
    db.execute(migration('20260912112441_pipeline_scheduler_control.sql'))
    db.execute(migration('20260912113935_pipeline_queue_lifecycle.sql'))


def test_scheduler_is_disabled_by_default_and_reclaims_expired_execution():
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            setup(db)
            assert db.execute('select claim_autonomous_pipeline_run()').fetchone()[0] is None
            db.execute('update auction_pipeline_control set enabled=true')
            db.execute("update auction_source_state set enabled=true where source_name='licitor'")
            first = db.execute('select claim_autonomous_pipeline_run()').fetchone()[0]
            assert first['source'] == 'licitor'
            assert db.execute('select claim_autonomous_pipeline_run()').fetchone()[0] is None
            db.execute("update auction_runs set created_at=now()-interval '2 hours' where id=%s", (first['id'],))
            second = db.execute('select claim_autonomous_pipeline_run()').fetchone()[0]
            assert second['source'] == 'licitor' and second['id'] != first['id']
            assert db.execute('select status from auction_runs where id=%s', (first['id'],)).fetchone()[0] == 'failed'
            assert db.execute("select has_function_privilege('anon','claim_autonomous_pipeline_run()','execute')").fetchone()[0] is False
        finally:
            db.rollback()


def test_obsolete_and_exhausted_leases_are_not_replayed_and_postponed_sales_survive():
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            setup(db)
            db.execute("insert into auction_sales(source_url,sale_date,status) values ('postponed',now()-interval '5 days','postponed'),('expired',now()-interval '5 days','past'),('future',now()+interval '5 days','upcoming')")
            db.execute("insert into auction_enrichment_jobs(source_url,job_type,input_hash) values ('postponed','pdf','current'),('expired','pdf','current'),('future','pdf','new')")
            db.execute("insert into auction_enrichment_jobs(source_url,job_type,input_hash,status,attempt_count,locked_at,created_at) values ('future','pdf','old','running',1,now()-interval '40 minutes',now()-interval '2 days')")
            jobs = db.execute('select source_url,input_hash from claim_auction_enrichment_jobs(10)').fetchall()
            assert set(jobs) == {('postponed','current'),('future','new')}
            assert db.execute("select count(*) from auction_enrichment_jobs where status='cancelled'").fetchone()[0] == 2
            db.execute("update auction_enrichment_jobs set attempt_count=max_attempts,locked_at=now()-interval '40 minutes' where source_url='postponed'")
            db.execute('select * from claim_auction_enrichment_jobs(10)')
            assert db.execute("select status,locked_at from auction_enrichment_jobs where source_url='postponed'").fetchone() == ('failed',None)
            assert db.execute("select app_private.sale_retention_deadline(now()-interval '5 days','upcoming','{}','{\"status\":\"Vente reportée\"}')").fetchone()[0] is None
        finally:
            db.rollback()


def test_persistent_refusal_and_retry_after_delay_the_next_source_attempt():
    now = datetime(2026,9,12,tzinfo=UTC)
    assert next_attempt(failures=2,access_denied=True,retry_not_before=None,now=now) == now+timedelta(days=1)
    future = now+timedelta(days=2)
    assert next_attempt(failures=1,access_denied=False,retry_not_before=future.isoformat(),now=now) == future


def test_observation_emits_one_incident_and_one_recovery():
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            setup(db)
            old = migration('20260714182305_phase_4_5_safety_net_and_operations.sql')
            db.execute(old[old.index('create table if not exists public.operational_alerts'):old.index('create or replace function public.evaluate_operational_health')])
            old = migration('20260727185139_phase_3_data_operations.sql')
            db.execute(old[old.index('alter table public.operational_alerts'):old.index('create or replace function app_private.sync_operational_alert')])
            db.execute(migration('20260912114957_pipeline_observation.sql'))
            db.execute("update auction_pipeline_control set enabled=true,observation_started_at=now()-interval '2 days'")
            db.execute("update auction_source_state set enabled=true where source_name='licitor'")
            db.execute('select observe_autonomous_pipeline()')
            key = 'pipeline.source.licitor.missed'
            assert db.execute('select status,notification_version from operational_alerts where alert_key=%s', (key,)).fetchone() == ('open',1)
            db.execute("update operational_alerts set notification_status='delivered',notified_at=now()-interval '1 day' where alert_key=%s", (key,))
            db.execute('select observe_autonomous_pipeline()')
            assert db.execute('select notification_status,notification_version from operational_alerts where alert_key=%s', (key,)).fetchone() == ('delivered',1)
            db.execute("update auction_source_state set last_inventory_complete_at=now() where source_name='licitor'")
            db.execute('select observe_autonomous_pipeline()')
            assert db.execute('select status,notification_event,notification_version from operational_alerts where alert_key=%s', (key,)).fetchone() == ('resolved','resolved',2)
        finally:
            db.rollback()


def test_interrupted_detail_collection_reuses_only_matching_checkpoint(monkeypatch):
    from src import source_checkpoint
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    # All SQL remains in the disposable test transaction, including checkpoint writes.
    from contextlib import nullcontext

    from src.storage import supabase_client
    with _postgres_connect(url) as db:
        try:
            setup(db)
            old = str(db.execute("insert into auction_runs(source,status) values('licitor','running') returning id").fetchone()[0])
            monkeypatch.setenv('PIPELINE_AUTONOMOUS_RUN_ID',old)
            monkeypatch.setattr(source_checkpoint,'load_settings',lambda: {'supabase_db_url':url})
            monkeypatch.setattr(supabase_client,'_postgres_connect',lambda _: nullcontext(db))
            source_checkpoint._context.cache_clear()
            listing = {'source_url':'https://example.test/1','source_name':'licitor','starting_price_eur':10000}
            raw = dict(listing)
            assert source_checkpoint.restore_detail(raw) is False
            raw['raw_text'] = 'Completed detail with source evidence'
            source_checkpoint.CheckpointSales().append(raw)
            checked_at = raw['_checkpoint_checked_at']
            db.execute("update auction_runs set status='failed' where id=%s",(old,))
            new = str(db.execute("insert into auction_runs(source,status) values('licitor','running') returning id").fetchone()[0])
            monkeypatch.setenv('PIPELINE_AUTONOMOUS_RUN_ID',new)
            source_checkpoint._context.cache_clear()
            resumed = dict(listing)
            assert source_checkpoint.restore_detail(resumed) is True
            assert resumed['raw_text'] == raw['raw_text']
            assert datetime.fromisoformat(resumed['_checkpoint_checked_at']) == datetime.fromisoformat(checked_at)
            changed = {**listing,'starting_price_eur':11000}
            assert source_checkpoint.restore_detail(changed) is False
        finally:
            source_checkpoint._context.cache_clear()
            db.rollback()


def test_paid_predictions_are_reserved_before_use_and_budget_deferral_preserves_retries(monkeypatch):
    from contextlib import nullcontext

    import psycopg

    from src import pipeline_usage
    from src.storage import supabase_client
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            setup(db)
            db.execute(migration('20260912125514_pipeline_usage_budget.sql'))
            run = str(db.execute("insert into auction_runs(source,status,scheduler_owned) values('enrichment-queue','running',true) returning id").fetchone()[0])
            db.execute('update auction_pipeline_control set max_ai_predictions_per_run=1')
            first = db.execute('select reserve_pipeline_prediction(%s,%s)',(run,pipeline_usage.PINNED_MODEL)).fetchone()[0]
            with pytest.raises(psycopg.errors.RaiseException,match='budget exhausted'):
                with db.transaction():
                    db.execute('select reserve_pipeline_prediction(%s,%s)',(run,pipeline_usage.PINNED_MODEL))
            monkeypatch.setenv('PIPELINE_AUTONOMOUS_RUN_ID',run)
            monkeypatch.setattr(pipeline_usage,'load_settings',lambda: {'supabase_db_url':url})
            monkeypatch.setattr(supabase_client,'_postgres_connect',lambda _: nullcontext(db))
            pipeline_usage.record_prediction({'id':'prediction-1','status':'succeeded','metrics':{'predict_time':10,'input_token_count':123}},reservation=str(first))
            summary = db.execute('select pipeline_usage_summary()').fetchone()[0]
            assert float(summary['ai_estimated_usd']) == pytest.approx(0.00975)
            assert summary['ai_unpriced_requests'] == 0
            db.execute("insert into auction_sales(source_url,sale_date) values('future',now()+interval '5 days')")
            job = db.execute("insert into auction_enrichment_jobs(source_url,job_type,input_hash,status,attempt_count) values('future','pdf','one','running',1) returning id,attempt_count").fetchone()
            pipeline_usage.defer_budget_jobs([{'id':str(job[0]),'attempt_count':job[1]}],pipeline_usage.PipelineBudgetExhausted('Daily AI budget exhausted'))
            assert db.execute('select status,attempt_count,locked_at from auction_enrichment_jobs where id=%s',(job[0],)).fetchone() == ('queued',0,None)
        finally:
            db.rollback()


def test_source_outage_never_establishes_absence_or_deletes_listing():
    from src.autonomous_runner import record_source_presence
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            setup(db)
            run_id = str(db.execute("insert into auction_runs(source,status) values ('licitor','succeeded') returning id").fetchone()[0])
            db.execute("insert into auction_sales(source_url,source_name) values ('kept','licitor')")
            record_source_presence(db,run_id,'licitor','unavailable',False)
            payload = db.execute("select raw_payload from auction_sales where source_url='kept'").fetchone()[0]
            assert 'state' not in payload['source_presence']['licitor']
            record_source_presence(db,run_id,'licitor','available',True)
            payload = db.execute("select raw_payload from auction_sales where source_url='kept'").fetchone()[0]
            assert payload['source_presence']['licitor']['state'] == 'absent'
            assert db.execute("select status from auction_sales where source_url='kept'").fetchone()[0] == 'upcoming'
            record_source_presence(db,run_id,'licitor','unavailable',False)
            payload = db.execute("select raw_payload from auction_sales where source_url='kept'").fetchone()[0]
            assert payload['source_presence']['licitor']['state'] == 'absent'
            assert payload['source_presence']['licitor']['availability'] == 'unavailable'
        finally:
            db.rollback()


def test_freshness_counts_merged_aliases_but_not_another_sources_checks():
    from psycopg.types.json import Jsonb
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            setup(db)
            db.execute(migration('20260912155824_pipeline_source_specific_freshness.sql'))
            db.execute(migration('20260912183031_pipeline_freshness_single_scan.sql'))
            db.execute("""insert into auction_sales(source_url,source_name,sale_date,observations,raw_payload)
                values ('canonical','avoventes','2026-09-15T12:00:00Z',%s,%s)""",
                (Jsonb([{'source_name':'licitor','source_url':'licitor-alias'}]),
                 Jsonb({'source_checks':{'canonical':{'checked_at':'2026-09-12T11:55:00Z'},
                       'licitor-alias':{'checked_at':'2026-09-11T12:00:00Z'}}})))
            assert db.execute("select * from auction_source_freshness('licitor','2026-09-12T12:00:00Z')").fetchone() == (1,0)
            assert db.execute("select * from auction_source_freshness('avoventes','2026-09-12T12:00:00Z')").fetchone() == (1,1)
            db.execute("""insert into auction_sales(source_url,source_name,sale_date,raw_payload)
                values ('licitor-direct','licitor','2026-10-01T12:00:00Z',%s)""",
                (Jsonb({'source_checks':{'licitor-direct':{'checked_at':'2026-09-12T08:00:00Z'},
                      'wrong-source':{'checked_at':'not-a-date'}}}),))
            assert db.execute("select * from auction_source_freshness('licitor','2026-09-12T12:00:00Z')").fetchone() == (2,1)
            run_id = str(db.execute("insert into auction_runs(source,status) values ('licitor','failed') returning id").fetchone()[0])
            from src.autonomous_runner import record_source_presence
            record_source_presence(db,run_id,'licitor','unavailable',False)
            payload = db.execute("select raw_payload from auction_sales where source_url='canonical'").fetchone()[0]
            assert payload['source_presence']['licitor']['availability'] == 'unavailable'
            assert 'state' not in payload['source_presence']['licitor']
        finally:
            db.rollback()


def test_unknown_listing_keeps_enrichment_but_expired_and_quarantined_do_not():
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            setup(db)
            db.execute("insert into auction_sales(source_url,status,sale_date) values ('unknown','unknown',null),('expired','unknown',now()-interval '3 days'),('quarantined','quarantined',null)")
            db.execute("insert into auction_enrichment_jobs(source_url,job_type,input_hash) values ('unknown','pdf','v1'),('expired','pdf','v1'),('quarantined','pdf','v1')")
            assert db.execute('select source_url from claim_auction_enrichment_jobs(10)').fetchall() == []
            db.execute(migration('20260912194309_enrich_unknown_active_listings.sql'))
            assert db.execute('select source_url from claim_auction_enrichment_jobs(10)').fetchall() == [('unknown',)]
            assert db.execute("select count(*) from auction_enrichment_jobs where status='cancelled'").fetchone()[0] == 2
        finally:
            db.rollback()
