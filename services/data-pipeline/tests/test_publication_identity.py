import os

import pytest

from src.normalize import normalize_sale
from src.publication_identity import merge_revision, resolve_publication_identities
from src.reviewed_aliases import registry_from_rows
from src.storage.supabase_client import _postgres_connect


@pytest.fixture(autouse=True)
def isolate_reviewed_alias_registry(monkeypatch):
    monkeypatch.setattr("src.publication_identity.load_reviewed_aliases", lambda _connection: registry_from_rows([]))


def sale(url, price=100000, checked='2026-09-12T10:00:00+00:00'):
    result = normalize_sale({'source_name': 'licitor', 'source_url': url,
        'address': '12 rue Victor Hugo', 'postal_code': '33000', 'city': 'Bordeaux',
        'starting_price_eur': price, 'sale_date': '2026-10-01T10:00:00+00:00'})
    result.raw_payload['source_checks'] = {url: {'checked_at': checked}}
    return result


def test_old_checkpoint_cannot_regress_newer_source_price():
    current = sale('https://example.test/a', 200000, '2026-09-12T12:00:00Z')
    old = sale('https://example.test/a', 100000, '2026-09-12T11:00:00+00:00')
    result = merge_revision(current, old)
    assert result.starting_price_eur == 200000
    assert result.raw_payload['source_checks'] == current.raw_payload['source_checks']


def test_targeted_alias_publication_reuses_existing_identity_under_lock():
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            db.execute("""create table auction_sales(id uuid default gen_random_uuid(),source_url text primary key,
                source_urls jsonb,source_name text,postal_code text,content_hash text,
                address text,city text,starting_price_eur numeric,raw_payload jsonb default '{}')""")
            original_id = db.execute("""insert into auction_sales(source_url,source_urls,source_name,postal_code,address,city,starting_price_eur)
                values ('https://example.test/canonical','["https://example.test/alias"]','avoventes','33000',
                '12 rue Victor Hugo','Bordeaux',100000) returning id""").fetchone()[0]
            alias = sale('https://example.test/alias', 120000)
            result = resolve_publication_identities(db, [alias])
            assert len(result) == 1
            assert result[0].source_url == 'https://example.test/canonical'
            assert result[0].id == str(original_id)
            assert result[0].starting_price_eur == 120000
            assert result[0].raw_payload['source_conflicts'][0]['selected_source'] == 'https://example.test/alias'
            # A newly discovered URL for the same precise property uses that row too.
            fresh = sale('https://example.test/new-alias')
            assert resolve_publication_identities(db, [fresh])[0].source_url == 'https://example.test/canonical'
        finally:
            db.rollback()


def test_checkpoint_stream_publishes_first_batch_before_source_finishes(monkeypatch):
    from src import source_checkpoint

    monkeypatch.setattr(source_checkpoint, '_context', lambda: None)
    published = []
    source_checkpoint.configure_publisher(lambda rows: published.append(rows))
    try:
        rows = source_checkpoint.CheckpointSales()
        for index in range(25):
            rows.append({'source_url': f'https://example.test/{index}'})
        assert len(published) == 1 and len(published[0]) == 25
        rows.append({'source_url': 'https://example.test/last'})
        assert len(published) == 1
        source_checkpoint.flush_publications()
        assert [len(batch) for batch in published] == [25, 1]
    finally:
        source_checkpoint.configure_publisher()


def test_alias_does_not_replace_primary_source_external_identity():
    primary = sale('https://example.test/primary')
    primary.external_id = 'primary-123'
    alias = sale('https://example.test/alias')
    alias.external_id = 'alias-456'
    result = merge_revision(primary, alias)
    assert result.external_id == 'primary-123'
    assert 'https://example.test/alias' in result.source_urls


def test_ambiguous_alias_is_held_without_blocking_unrelated_publication():
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with _postgres_connect(url) as db:
        try:
            db.execute("""create table auction_sales(id uuid default gen_random_uuid(),source_url text primary key,
                source_urls jsonb,source_name text,postal_code text,content_hash text,
                address text,city text,starting_price_eur numeric,raw_payload jsonb default '{}',
                status text default 'active',quality_flags jsonb default '[]',updated_at timestamptz)""")
            db.execute("""insert into auction_sales(source_url,source_urls,source_name,postal_code,address,city)
                values ('https://example.test/a','["https://example.test/alias"]','licitor','33000',
                        '12 rue Victor Hugo','Bordeaux'),
                       ('https://example.test/b','["https://example.test/alias"]','avoventes','33000',
                        '12 rue Victor Hugo','Bordeaux')""")
            incoming = sale('https://example.test/alias')
            unrelated = sale('https://example.test/unrelated')
            unrelated.address = '42 rue Pasteur'
            result = resolve_publication_identities(db, [incoming, unrelated])
            assert [row.source_url for row in result] == [unrelated.source_url]
            assert incoming.status == 'quarantined'
            assert db.execute("select count(*) from auction_sales where status='quarantined'").fetchone()[0] == 2
            assert db.execute("select count(*) from auction_sales").fetchone()[0] == 2
        finally:
            db.rollback()


def test_legacy_alias_cannot_merge_different_numbered_addresses():
    from src.publication_identity import conflicting_identity

    original = sale('https://example.test/a')
    alias = sale('https://example.test/b')
    alias.address = '42 rue Pasteur'
    assert conflicting_identity(original, alias)
    alias.address = original.address
    assert not conflicting_identity(original, alias)
    alias.raw_payload['lot_number'] = '2'
    original.raw_payload['lot_number'] = '1'
    assert conflicting_identity(original, alias)


@pytest.mark.parametrize('address', ['94250 Gentilly', '10 000 €', None])
def test_same_city_date_price_without_precise_address_is_not_identity(address):
    from src.dedupe import merge_duplicate_sales

    first = sale('https://example.test/lot-1')
    second = sale('https://example.test/lot-2')
    first.address = second.address = address
    first.city = second.city = 'Gentilly'
    first.postal_code = second.postal_code = '94250'
    second.source_name = 'vench'
    assert len(merge_duplicate_sales([first, second])) == 2


def test_monetary_address_is_reserved_without_rejecting_the_listing():
    result = normalize_sale({'source_name': 'encheres_immobilieres', 'source_url': 'https://example.test/asset',
        'address': '10 000 €', 'city': 'Nice', 'starting_price_eur': 10000})
    assert result.address is None
    assert result.city == 'Nice'
    assert 'address_unverified' in result.quality_flags
    assert result.raw_payload['invalid_address_evidence']['value'] == '10 000 €'


def test_hectares_are_not_lost_when_reading_cadastral_area():
    from src.asset_normalization import normalize_asset_features
    result = normalize_sale({'source_name':'vench','source_url':'https://example.test/land',
        'property_type':'land','description':'Propriété cadastrée BE 429 pour une surface de 01 ha 00 a 30 ca.'})
    normalize_asset_features(result)
    assert result.land_surface_m2 == 10030


def test_several_parcel_areas_do_not_become_one_uncertain_total():
    from src.asset_normalization import normalize_asset_features
    result = normalize_sale({'source_name':'licitor','source_url':'https://example.test/land',
        'property_type':'land','description':'Section AO 91 pour 5a 71ca ; AO 95 pour 10a 5ca ; jardin AO 88 pour 5a 62ca.'})
    normalize_asset_features(result)
    assert result.land_surface_m2 is None
    assert 'parcel_surface_scope_unverified' in result.quality_flags


def test_different_sale_lots_are_explicitly_reserved():
    result = normalize_sale({'source_name':'avoventes','source_url':'https://example.test/lots',
        'title':'Appartement / local commercial (vente en 2 lots)',
        'description':'PREMIER LOT DE VENTE : surface loi Carrez totale de 51,82 m². SECOND LOT DE VENTE : superficie loi Carrez de 42,90 m².'})
    assert 'multi_lot_sale' in result.quality_flags
    assert str(result.carrez_surface_m2) == '51.82'


def test_notarial_opening_is_not_an_expiration_deadline():
    import json
    from datetime import UTC, datetime

    from src.admission import is_expired, retention_deadline
    from src.sources.notaires import parse_notaires_json

    payload = {'annonceResumeDto':[{'annonceId':1,'typeTransaction':'VNI',
        'urlDetailAnnonceFr':'https://example.test/1','dateDebutEncheres':'2026-09-10T10:00:00Z',
        'dateFinEncheres':'2026-09-15T10:00:00Z'}]}
    raw = parse_notaires_json(json.dumps(payload))[0]
    sale = normalize_sale(raw)
    assert sale.sale_date == datetime(2026,9,15,10,tzinfo=UTC)
    assert not is_expired(sale,datetime(2026,9,12,12,tzinfo=UTC))
    assert is_expired(sale,datetime(2026,9,16,11,tzinfo=UTC))
    payload['annonceResumeDto'][0].pop('dateFinEncheres')
    incomplete = normalize_sale(parse_notaires_json(json.dumps(payload))[0])
    assert retention_deadline(incomplete) is None


def test_verified_closing_clears_only_its_temporary_reservation():
    before = sale('https://example.test/online')
    before.raw_payload['source_conflicts'] = [
        {'code':'closing_time_unverified','field':'sale_date','selected_source':before.source_url},
        {'field':'carrez_surface_m2','selected_source':before.source_url}]
    incoming = sale(before.source_url,checked='2026-09-12T12:00:00Z')
    incoming.raw_payload['source_sale_schedule'] = {'opens_at':'2026-09-14T10:00:00Z','closes_at':'2026-09-15T10:00:00Z'}
    result = merge_revision(before,incoming)
    assert result.raw_payload['source_conflicts'] == [{'field':'carrez_surface_m2','selected_source':before.source_url}]
