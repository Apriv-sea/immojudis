"""Use only the explicitly supplied disposable PIPELINE_TEST_DB_URL."""
import os
from pathlib import Path

import pytest

from src.storage.supabase_client import _postgres_connect


def test_queue_migration_on_real_postgres():
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    root = Path(__file__).resolve().parents[3]
    original = (root / 'supabase/migrations/20260819105011_add_structured_surface_reasoning_queue.sql').read_text()
    table = original[original.index('create table if not exists public.auction_enrichment_jobs'):original.index('create index if not exists auction_surface_measurements')]
    migration = (root / 'supabase/migrations/20260911090103_reliable_enrichment_queue.sql').read_text().removeprefix('begin;').removesuffix('commit;\n')
    with _postgres_connect(url) as db:
        try:
            db.execute('create schema if not exists app_private')
            for role in ('anon', 'authenticated', 'service_role'):
                db.execute(f"do $$ begin if not exists(select from pg_roles where rolname='{role}') then create role {role}; end if; end $$")
            db.execute("create table public.auction_sales(source_url text primary key, status text default 'active', sale_date timestamptz, content_hash text, documents jsonb default '[]')")
            db.execute(table)
            db.execute(migration)
            db.execute("create trigger auction_sales_enqueue_surface_enrichment after insert or update of content_hash,documents on public.auction_sales for each row execute function app_private.enqueue_auction_surface_enrichment()")
            db.execute("select set_config('app.pipeline_queue_owner','python',true)")
            db.execute("insert into public.auction_sales(source_url,sale_date) values ('future',now()+interval '2 days'),('past',now()-interval '2 days'),('other',now()+interval '3 days')")
            assert db.execute('select count(*) from public.auction_enrichment_jobs').fetchone()[0] == 0
            db.execute("insert into public.auction_enrichment_jobs(source_url,job_type,input_hash,created_at) values ('future','display_description','old',now()-interval '2 days'),('future','display_description','pipeline_v2:new',now()),('past','pdf','old',now()),('other','pdf','pipeline_v2:other',now())")
            jobs = db.execute('select source_url,input_hash from public.claim_auction_enrichment_jobs(1)').fetchall()
            assert jobs == [('other','pipeline_v2:other')]
            assert db.execute("select count(*) from public.auction_enrichment_jobs where status='cancelled'").fetchone()[0] == 2
            jobs = db.execute('select source_url,input_hash from public.claim_auction_enrichment_jobs(5)').fetchall()
            assert jobs == [('future','pipeline_v2:new')]
            assert db.execute('select count(*) from public.claim_auction_enrichment_jobs(5)').fetchone()[0] == 0
            db.execute("select set_config('app.pipeline_queue_owner','',true)")
            db.execute("insert into public.auction_sales(source_url,sale_date) values ('external',now()+interval '2 days')")
            assert db.execute("select count(*) from public.auction_enrichment_jobs where source_url='external'").fetchone()[0] == 1
        finally:
            db.rollback()


def test_finalizer_preserves_progress_and_only_closes_its_own_run(monkeypatch):
    from src import run_finalizer
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    first = '11111111-1111-4111-8111-111111111111'
    other = '22222222-2222-4222-8222-222222222222'
    monkeypatch.setenv('PIPELINE_CURRENT_RUN_ID', first)
    monkeypatch.setattr(run_finalizer, 'load_settings', lambda: {'supabase_db_url': url})
    with _postgres_connect(url) as db:
        db.execute("create table public.auction_runs(id uuid primary key, status text, finished_at timestamptz, updated_at timestamptz, summary jsonb, errors jsonb)")
        db.execute("insert into public.auction_runs(id,status,summary) values (%s,'running','{\"persisted\":3}'),(%s,'running','{}')", (first, other))
    try:
        run_finalizer.main()
        with _postgres_connect(url) as db:
            assert db.execute('select status,summary from public.auction_runs where id=%s', (first,)).fetchone() == ('failed', {'persisted': 3, 'completion_status': 'interrupted'})
            assert db.execute('select status from public.auction_runs where id=%s', (other,)).fetchone()[0] == 'running'
    finally:
        with _postgres_connect(url) as db:
            db.execute('drop table public.auction_runs')
