"""Recurring verification uses the existing queue and each provider's own clock."""
import os
from datetime import timedelta

import pytest
from psycopg.types.json import Jsonb
from test_autonomy_postgres import migration, setup

from src.storage.supabase_client import _postgres_connect


def test_recurring_details_include_aliases_respect_pause_and_do_not_duplicate_jobs():
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            setup(db)
            db.execute(migration('20260913081411_recurring_source_detail_jobs.sql'))
            now = db.execute('select now()').fetchone()[0]
            checks = {
                'canonical': {'source_name':'licitor','checked_at':now.isoformat()},
                'alias': {'source_name':'vench','checked_at':(now-timedelta(hours=7)).isoformat()},
            }
            db.execute("insert into auction_sales(source_url,source_name,sale_date,raw_payload) values('canonical','licitor',%s,%s)",
                       (now+timedelta(days=3),Jsonb({'source_checks':checks})))
            db.execute("update auction_source_state set enabled=true,next_inventory_at=now()+interval '2 hours' where source_name in ('licitor','vench')")
            assert db.execute('select enqueue_due_source_details()').fetchone()[0] == 0
            db.execute('update auction_pipeline_control set enabled=true,source_details_enabled=true')
            assert db.execute('select enqueue_due_source_details()').fetchone()[0] == 1
            assert db.execute('select enqueue_due_source_details()').fetchone()[0] == 0
            row = db.execute('select source_url,detail_source_name,detail_source_url from auction_enrichment_jobs').fetchone()
            assert row == ('canonical','vench','alias')
            db.execute("update auction_source_state set suspended_until=now()+interval '1 day' where source_name='vench'")
            assert db.execute('select count(*) from claim_auction_enrichment_jobs(10)').fetchone()[0] == 0
            db.execute("update auction_source_state set suspended_until=null where source_name='vench'")
            claimed = db.execute('select id,attempt_count from claim_auction_enrichment_jobs(10)').fetchall()
            assert len(claimed) == 1 and claimed[0][1] == 1
            db.execute("update auction_enrichment_jobs set status='completed',locked_at=null")
            assert db.execute('select enqueue_due_source_details()').fetchone()[0] == 0
            assert db.execute("select has_function_privilege('anon','enqueue_due_source_details(timestamptz,integer)','execute')").fetchone()[0] is False
        finally:
            db.rollback()


def test_alias_jobs_coexist_and_scheduler_enqueues_without_an_extra_trigger():
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            setup(db)
            db.execute(migration('20260913081411_recurring_source_detail_jobs.sql'))
            db.execute('update auction_pipeline_control set enabled=true,source_details_enabled=true')
            db.execute("update auction_source_state set enabled=true,next_inventory_at=now()+interval '2 hours' where source_name in ('licitor','vench')")
            db.execute("""insert into auction_sales(source_url,source_name,sale_date,observations) values
              ('both','licitor',now()+interval '3 days','[{"source_name":"vench","source_url":"alias"}]'),
              ('expired','licitor',now()-interval '5 days','[]'),
              ('disabled','notaires',null,'[]')""")
            run = db.execute('select claim_autonomous_pipeline_run()').fetchone()[0]
            assert run['mode'] == 'enrichment'
            jobs = db.execute('select detail_source_url from claim_auction_enrichment_jobs(10)').fetchall()
            assert {job[0] for job in jobs} == {'both','alias'}
            assert db.execute("select count(*) from auction_enrichment_jobs where status='cancelled'").fetchone()[0] == 0
            # A damaged or future timestamp must not count as a successful check.
            assert db.execute("select app_private.pipeline_checked_at('bad date',now()),app_private.pipeline_checked_at((now()+interval '1 day')::text,now())").fetchone() == (None,None)
        finally:
            db.rollback()
