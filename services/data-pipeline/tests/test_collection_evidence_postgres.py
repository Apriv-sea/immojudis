import os
from contextlib import nullcontext
from pathlib import Path

import pytest

from src import collection_evidence as evidence
from src.normalize import normalize_sale
from src.storage import supabase_client as storage


def test_decisions_survive_relaunch_without_losing_publication_proof(monkeypatch):
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    migration = (Path(__file__).resolve().parents[3] / 'supabase/migrations/20260912110654_pipeline_autonomy_evidence.sql').read_text()
    migration = migration.removeprefix('begin;').removesuffix('commit;\n')
    run = '11111111-1111-4111-8111-111111111111'
    raw = dict(source_name='licitor', source_url='https://example.test/a', external_id='a', starting_price_eur=10000)
    with storage._postgres_connect(url) as db:
        try:
            for role in ('anon','authenticated','service_role'):
                db.execute(f"do $$ begin if not exists(select from pg_roles where rolname='{role}') then create role {role}; end if; end $$")
            db.execute('create table public.auction_runs(id uuid primary key)')
            db.execute('insert into public.auction_runs values (%s)',(run,))
            db.execute(migration)
            monkeypatch.setattr(evidence,'load_settings',lambda: {'supabase_db_url':url})
            monkeypatch.setattr(storage,'_postgres_connect',lambda _: nullcontext(db))
            evidence.record_items(run,[raw])
            evidence.record_items(run,[raw])
            assert db.execute('select count(*) from auction_collection_items').fetchone()[0] == 1
            sale = normalize_sale(raw)
            db.execute('savepoint publish')
            evidence.record_sale_decisions(run,[sale],decision='published',connection=db)
            db.execute('rollback to savepoint publish')
            assert db.execute('select decision,published_at from auction_collection_items').fetchone() == ('discovered',None)
            evidence.record_sale_decisions(run,[sale],decision='published',connection=db)
            evidence.record_items(run,[raw])
            assert db.execute('select decision,published_at is not null from auction_collection_items').fetchone() == ('published',True)
            assert db.execute("select has_table_privilege('anon','auction_collection_items','select')").fetchone()[0] is False
            assert db.execute('select count(*) from auction_source_state').fetchone()[0] == 10
        finally:
            db.rollback()


def test_identity_distinguishes_lots():
    raw = {'source_url':'https://example.test/a','external_id':'a'}
    assert evidence.identity({**raw,'lot_number':'1'}) != evidence.identity({**raw,'lot_number':'2'})


def test_enrichment_cannot_overwrite_a_new_revision_or_recreate_a_deleted_sale():
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with storage._postgres_connect(url) as db:
        try:
            db.execute('create table public.auction_sales(source_url text primary key,updated_at timestamptz)')
            original = db.execute("insert into auction_sales values ('https://example.test/a',now()) returning updated_at").fetchone()[0]
            sale = normalize_sale(dict(source_name='licitor', source_url='https://example.test/a',starting_price_eur=10000))
            sale.updated_at = original
            assert storage._guard_enrichment_revision(db,[sale]) == [sale]
            db.execute("update auction_sales set updated_at=updated_at+interval '1 second'")
            assert storage._guard_enrichment_revision(db,[sale]) == []
            db.execute('delete from auction_sales')
            assert storage._guard_enrichment_revision(db,[sale]) == []
        finally:
            db.rollback()


def test_enrichment_fetches_every_field_that_it_writes():
    assert set(storage.UPSERT_COLUMNS) <= set(storage.DATA_REFRESH_SALE_SELECT.split(','))
    assert 'updated_at' in storage.DATA_REFRESH_SALE_SELECT.split(',')
