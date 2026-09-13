from decimal import Decimal

import pytest

from src.admission import has_price_or_surface
from src.models import AuctionSale
from src.storage import supabase_client


@pytest.mark.parametrize('field', ['starting_price_eur', 'surface_m2', 'habitable_surface_m2', 'carrez_surface_m2', 'land_surface_m2', 'app_surface_m2'])
@pytest.mark.parametrize('value,accepted', [(None, False), (Decimal('0'), False), (Decimal('-1'), False), (Decimal('0.5'), True)])
def test_admission_accepts_either_price_or_any_positive_surface(field, value, accepted):
    sale = AuctionSale(source_name='licitor', source_url='https://example.org/sale')
    setattr(sale, field, value)
    assert has_price_or_surface(sale) is accepted


@pytest.mark.parametrize('writer', ['upsert_sales_to_supabase', 'upsert_observations_to_supabase', 'upsert_documents_to_supabase', 'upsert_extractions_to_supabase'])
def test_rejected_sale_never_reaches_database(monkeypatch, writer):
    def unexpected_settings():
        pytest.fail('Rejected listing reached database configuration')
    monkeypatch.setattr(supabase_client, 'load_settings', unexpected_settings)
    sale = AuctionSale(source_name='licitor', source_url='https://example.org/sale', address='1 rue Test')
    assert getattr(supabase_client, writer)([sale]) == 0


def test_enrichment_can_make_previously_rejected_sale_admissible():
    sale = AuctionSale(source_name="licitor", source_url="https://example.org/sale")
    assert not has_price_or_surface(sale)
    sale.carrez_surface_m2 = Decimal("42")
    assert has_price_or_surface(sale)


@pytest.mark.parametrize('date,status,raw,expected', [
    ('2026-09-10T12:00:00+00:00', 'upcoming', {}, '2026-09-11T12:00:00+00:00'),
    ('2026-09-10T00:00:00+00:00', 'upcoming', {'sale_date': '10/09/2026'}, '2026-09-11T22:00:00+00:00'),
    ('2026-03-29T00:00:00+00:00', 'upcoming', {'sale_date': '2026-03-29'}, '2026-03-30T22:00:00+00:00'),
    ('2026-10-25T00:00:00+00:00', 'upcoming', {'sale_date': '2026-10-25'}, '2026-10-26T23:00:00+00:00'),
    ('2026-09-10T12:00:00+00:00', 'postponed', {}, None),
    (None, 'upcoming', {}, None),
    ('2026-09-10T12:00:00+00:00', 'past', {'status': 'Vente reportée'}, None),
])
def test_retention_deadline_matches_database(date, status, raw, expected):
    from src.admission import retention_deadline
    sale = AuctionSale(source_name='test', source_url='https://example.org/sale', sale_date=date, status=status, raw_payload=raw)
    deadline = retention_deadline(sale)
    assert (deadline.isoformat() if deadline else None) == expected


def test_date_only_sale_is_retained_after_a_sale_at_14h_until_civil_day_plus_24h():
    from datetime import UTC, datetime

    from src.admission import is_expired, retention_deadline

    sale = AuctionSale(
        source_name='test',
        source_url='https://example.org/date-only',
        sale_date='2026-09-10T00:00:00+00:00',
        raw_payload={'sale_date': '10/09/2026'},
    )
    deadline = retention_deadline(sale)
    assert deadline == datetime(2026, 9, 11, 22, tzinfo=UTC)
    assert not is_expired(sale, datetime(2026, 9, 11, 14, tzinfo=UTC))
    assert is_expired(sale, deadline)


def test_date_precision_marker_protects_legacy_midnight_normalization():
    from datetime import UTC, datetime

    from src.admission import retention_deadline

    sale = AuctionSale(
        source_name='test',
        source_url='https://example.org/date-precision',
        sale_date='2026-09-10T00:00:00+00:00',
        raw_payload={
            'sale_date': '2026-09-10T00:00:00Z',
            'date_precision': '  ',
            'sale_date_precision': ' day ',
        },
    )
    assert retention_deadline(sale) == datetime(2026, 9, 11, 22, tzinfo=UTC)


def test_date_only_marker_uses_the_paris_civil_date_for_an_aware_midnight():
    from datetime import UTC, datetime

    from src.admission import retention_deadline

    sale = AuctionSale(
        source_name='test',
        source_url='https://example.org/aware-date-only',
        sale_date='2026-10-25T00:00:00+02:00',
        raw_payload={'sale_date': '2026-10-25T00:00:00+02:00', 'date_precision': 'day'},
    )
    assert retention_deadline(sale) == datetime(2026, 10, 26, 23, tzinfo=UTC)


def test_midnight_sale_date_without_date_only_evidence_keeps_timestamp_semantics():
    from datetime import UTC, datetime

    from src.admission import retention_deadline

    sale = AuctionSale(
        source_name='test',
        source_url='https://example.org/source-date',
        sale_date='2026-09-10T00:00:00+00:00',
        raw_payload={'source_date': '2026-09-10'},
    )
    assert retention_deadline(sale) == datetime(2026, 9, 11, tzinfo=UTC)


def test_explicit_sale_hour_still_uses_sale_timestamp_plus_24h():
    from datetime import UTC, datetime

    from src.admission import retention_deadline

    sale = AuctionSale(
        source_name='test',
        source_url='https://example.org/explicit-hour',
        sale_date='2026-09-10T12:00:00+00:00',
        raw_payload={'sale_date': '10/09/2026 à 14h'},
    )
    assert retention_deadline(sale) == datetime(2026, 9, 11, 12, tzinfo=UTC)


def test_checkpoint_waits_for_usable_enrichment(monkeypatch):
    from src import main
    sale = AuctionSale(source_name='test', source_url='https://example.org/sale')
    monkeypatch.setattr(main, 'upsert_sales_to_supabase', lambda *a, **k: pytest.fail('inadmissible checkpoint'))
    assert main._checkpoint_enrichment(sale) is False


def test_expired_enrichment_cannot_recreate_a_deleted_sale(monkeypatch):
    from datetime import UTC, datetime
    sale = AuctionSale(source_name='test', source_url='https://example.org/sale', starting_price_eur=1000, sale_date=datetime(2000,1,1,tzinfo=UTC))
    monkeypatch.setattr(supabase_client, 'load_settings', lambda: pytest.fail('expired write reached database'))
    assert supabase_client.upsert_sales_to_supabase([sale]) == 0


@pytest.mark.parametrize('value,expected', [('Vente reportée','postponed'), ('Vente annulée','cancelled'), ('Retirée','withdrawn'), ('adjudicated','adjudicated')])
def test_explicit_procedure_event_is_not_replaced_by_elapsed_date(value, expected):
    from datetime import UTC, datetime

    from src.normalize import normalize_status
    assert normalize_status(value, datetime(2020,1,1,tzinfo=UTC)) == expected


def test_missing_secondary_data_does_not_quarantine_but_procedure_conflict_does():
    from src.admission import quarantine_reason
    sale = AuctionSale(source_name='licitor', source_url='https://example.org/sale', starting_price_eur=10000)
    assert quarantine_reason(sale) is None
    sale.sale_verification_status = 'conflict'
    assert quarantine_reason(sale) == 'conflicting_sale_procedure'


def test_explicit_no_auction_conflicts_with_catalogue_scope():
    from src.admission import quarantine_reason
    sale = AuctionSale(source_name='notaires',source_url='https://example.org/sale',
        raw_payload={'description':'VENTE AU PRIX – PAS D’ENCHERES SUR CE BIEN'})
    assert quarantine_reason(sale) == 'fixed_price_sale_conflicts_with_auction_scope'
    sale.raw_payload={'description':'Vente avec un pas d’enchères de 5 000 euros.'}
    assert quarantine_reason(sale) is None
