import pytest

from src import source_detail

SETTINGS = {'user_agent': 'Immojudis source verification'}


@pytest.mark.parametrize('scenario', ['current', 'reclaimed', 'expired_lease', 'newer_revision', 'deleted', 'write_failure'])
def test_source_publication_checks_lease_version_and_atomicity(monkeypatch, scenario):
    import os
    from contextlib import contextmanager
    from datetime import timedelta

    from src.models import AuctionSale
    from src.storage import supabase_client as storage

    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with storage._postgres_connect(url) as db:
        try:
            db.execute('create table auction_sales(source_url text primary key,updated_at timestamptz default now(),status text)')
            db.execute('''create table auction_enrichment_jobs(id text primary key,source_url text,job_type text,
              status text,attempt_count int,locked_at timestamptz,last_error text,completed_at timestamptz,updated_at timestamptz)''')
            version = db.execute("insert into auction_sales values('existing',now(),'upcoming') returning updated_at").fetchone()[0]
            db.execute("insert into auction_enrichment_jobs(id,source_url,job_type,status,attempt_count,locked_at) values('job','existing','source_detail','running',1,now())")
            sale = AuctionSale.model_construct(source_url='existing',updated_at=version,status='past')
            if scenario == 'reclaimed':
                db.execute("update auction_enrichment_jobs set attempt_count=2")
            elif scenario == 'expired_lease':
                db.execute("update auction_enrichment_jobs set locked_at=now()-interval '31 minutes'")
            elif scenario == 'newer_revision':
                sale.updated_at = version - timedelta(seconds=1)
            elif scenario == 'deleted':
                db.execute('delete from auction_sales')

            @contextmanager
            def connect(_):
                with db.transaction():
                    yield db

            writes = []

            def write(sales, settings, *, refresh_last_seen):
                assert refresh_last_seen is False
                assert storage._PUBLICATION_CONNECTION.get() is db
                writes.append(sales[0].source_url)
                db.execute("update auction_sales set status='past'")
                if scenario == 'write_failure':
                    raise RuntimeError('child table failed')
                return 1

            monkeypatch.setattr(storage, '_postgres_connect', connect)
            monkeypatch.setattr(storage, '_write_sale_revisions', write)
            if scenario == 'write_failure':
                with pytest.raises(RuntimeError, match='child table failed'):
                    source_detail.publish_source_revision(sale, {'id':'job','attempt_count':1}, {'supabase_db_url':url})
                assert db.execute('select status from auction_sales').fetchone()[0] == 'upcoming'
                assert db.execute('select status from auction_enrichment_jobs').fetchone()[0] == 'running'
            else:
                assert source_detail.publish_source_revision(sale, {'id':'job','attempt_count':1}, {'supabase_db_url':url}) is (scenario == 'current')
                assert writes == (['existing'] if scenario == 'current' else [])
                expected = 'completed' if scenario == 'current' else 'cancelled' if scenario in {'newer_revision','deleted'} else 'running'
                assert db.execute('select status from auction_enrichment_jobs').fetchone()[0] == expected
            assert storage._PUBLICATION_CONNECTION.get() is None
        finally:
            db.rollback()


def test_detail_uses_existing_licitor_parser_after_robots_check(monkeypatch):
    requests = []

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url):
            requests.append(url)
            if url.endswith('/robots.txt'):
                return 'User-agent: *\nAllow: /'
            return '<h1>Une maison</h1><p>jeudi 10 septembre 2026 à 14h</p><p>Vente non requise</p>'

    monkeypatch.setattr(source_detail, 'PoliteHttpClient', Client)
    url = 'https://www.licitor.com/annonce/109001.html'
    endpoint, body, raw = source_detail.fetch_public_detail('licitor', url, SETTINGS, {})
    assert requests == ['https://www.licitor.com/robots.txt', url]
    assert endpoint == raw['source_url'] == url
    assert raw['status'] == 'withdrawn'
    assert 'Vente non requise' in body


def test_detail_rejects_other_origin_before_any_request(monkeypatch):
    monkeypatch.setattr(source_detail, 'PoliteHttpClient', lambda **kwargs: pytest.fail('Unexpected HTTP client'))
    with pytest.raises(ValueError, match='Unsupported source endpoint'):
        source_detail.fetch_public_detail('licitor', 'https://example.test/annonce/1', SETTINGS, {})


def test_robots_refusal_prevents_detail_request(monkeypatch):
    requests = []

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url):
            requests.append(url)
            assert url.endswith('/robots.txt')
            return 'User-agent: *\nDisallow: /annonce/'

    monkeypatch.setattr(source_detail, 'PoliteHttpClient', Client)
    with pytest.raises(ValueError, match='Robots access refused'):
        source_detail.fetch_public_detail('licitor', 'https://www.licitor.com/annonce/1', SETTINGS, {})
    assert len(requests) == 1


def test_changed_detail_invalidates_analysis_and_preserves_catalogue_identity(monkeypatch):
    from datetime import UTC, datetime

    from src import main
    from src.normalize import normalize_sale

    monkeypatch.setattr(main, '_finalize_sale_for_app', lambda sale, **kwargs: None)
    existing = normalize_sale({'source_name': 'licitor', 'source_url': 'https://www.licitor.com/annonce/1',
                               'sale_date': '2099-01-01', 'starting_price_eur': 10000})
    existing.updated_at = datetime(2026, 9, 12, tzinfo=UTC)
    existing.raw_payload['qualification_previous_review'] = {'reason': 'retained proof'}
    existing.raw_payload['llm_display_description'] = 'Old analysis'
    revised = source_detail.prepare_source_revision(existing, {
        'source_name': 'licitor', 'source_url': existing.source_url, 'sale_date': '2099-01-01',
        'starting_price_eur': 20000, 'raw_text': 'New source facts'})
    assert revised.id == existing.id
    assert revised.updated_at == existing.updated_at
    assert revised.raw_payload['source_checks'][existing.source_url]['checked_at']
    assert not revised.raw_payload.get('llm_display_description')
    assert revised.raw_payload['source_content_changed'] is True
    assert revised.raw_payload['qualification_previous_review'] == {'reason': 'retained proof'}


def test_failed_detail_does_not_advance_freshness():
    from src.normalize import normalize_sale

    existing = normalize_sale({'source_name': 'licitor', 'source_url': 'https://www.licitor.com/annonce/1'})
    with pytest.raises(ValueError, match='not verified'):
        source_detail.prepare_source_revision(existing, {'source_url': existing.source_url, '_detail_fetch_failed': True})
    assert 'source_checks' not in existing.raw_payload


def test_unchanged_source_preserves_later_documentary_qualification(monkeypatch):
    from copy import deepcopy
    from decimal import Decimal

    from src import main
    from src.freshness import record_source_checks
    from src.normalize import normalize_sale

    monkeypatch.setattr(main, '_finalize_sale_for_app', lambda sale, **kwargs: None)
    raw = {'source_name':'licitor','source_url':'https://www.licitor.com/annonce/1',
           'raw_text':'Appartement 50 m²','starting_price_eur':10000,'habitable_surface_m2':50}
    first = deepcopy(raw)
    record_source_checks([first], {})
    existing = normalize_sale(first)
    existing.habitable_surface_m2 = None
    existing.carrez_surface_m2 = Decimal('48')
    existing.quality_flags = ['surface_type_unverified']
    existing.raw_payload['qualification_surface'] = {'document':'PV','page':3,'carrez':48}
    revised = source_detail.prepare_source_revision(existing, deepcopy(raw))
    assert revised.habitable_surface_m2 is None
    assert revised.carrez_surface_m2 == 48
    assert revised.quality_flags == ['surface_type_unverified']
    assert revised.raw_payload['qualification_surface']['page'] == 3
    assert revised.raw_payload['source_checks'][existing.source_url]['checked_at'] >= first['source_checks'][existing.source_url]['checked_at']


def test_reused_url_for_different_lot_holds_existing_identity(monkeypatch):
    from src import main
    from src.normalize import normalize_sale

    monkeypatch.setattr(main, '_finalize_sale_for_app', lambda sale, **kwargs: None)
    existing = normalize_sale({'source_name': 'licitor', 'source_url': 'https://www.licitor.com/annonce/1',
                               'lot_number': '1', 'starting_price_eur': 10000})
    revised = source_detail.prepare_source_revision(existing, {
        'source_name': 'licitor', 'source_url': existing.source_url,
        'lot_number': '2', 'starting_price_eur': 80000})
    assert revised.status == 'quarantined'
    assert revised.starting_price_eur == existing.starting_price_eur
    assert revised.raw_payload['lot_number'] == '1'
    assert revised.raw_payload['publication_identity_conflict']['incoming_lot'] == '2'
