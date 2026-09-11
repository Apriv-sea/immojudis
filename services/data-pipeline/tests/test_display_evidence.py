from datetime import UTC, datetime
from decimal import Decimal

import pytest

from src.enrichment.display_evidence import verify_display_claims
from src.enrichment.extract_structured import apply_cached_llm_extraction_to_sale
from src.models import AuctionSale


def codes(text, evidence='', **fields):
    return {issue['code'] for issue in verify_display_claims(text, evidence, fields)['issues']}


def test_price_is_not_evidence_for_a_surface():
    assert 'unsupported_area' in codes('Terrain de 150 m².', 'Prix : 150 euros.')
    assert not codes('Terrain de 150 m².', 'Terrain de 150 m².')


def test_french_decimal_and_thousands_separators():
    assert not codes('120 000 € ; 91,4 m².', 'Mise à prix : 120\u202f000 euros. Habitable : 91.4 m².')
    assert 'unsupported_money' in codes('120 000 €.', 'Prix : 12 000 €.')


def test_integer_area_rounding_has_a_small_bound():
    assert not codes('Appartement de 117 m².', surface_m2=Decimal('117.31'))
    assert 'unsupported_area' in codes('Appartement de 118 m².', surface_m2=Decimal('117.31'))


@pytest.mark.parametrize('text,known', [('Maison libre.', 'rented'), ('Maison louée.', 'vacant'), ('Appartement squatté.', 'vacant')])
def test_conflicting_occupation_is_flagged(text, known):
    assert 'occupancy_conflict' in codes(text, occupancy_status=known)


def test_negated_occupation_is_not_an_affirmative_claim():
    assert not codes('Appartement non loué.', occupancy_status='vacant')
    assert not codes('Appartement non libre.', occupancy_status='rented')


def test_source_dates_are_matched_across_formats():
    assert not codes('Vente le 22 octobre 2026.', 'Clôture : 2026-10-22T16:00:00+02:00')
    assert 'unsupported_date' in codes('Vente le 23 octobre 2026.', sale_date=datetime(2026, 10, 22, tzinfo=UTC))
    assert 'unsupported_date' in codes('Vente le 31/02/2026.')


def test_promotional_and_contradictory_works_claims():
    assert 'promotional_claim' in codes('Rentabilité garantie, situation exceptionnelle.')
    assert 'works_conflict' in codes('Aucun travaux.', 'Gros travaux de rénovation à prévoir.')


def test_cached_high_confidence_hallucination_is_not_accepted():
    sale = AuctionSale(source_name='agrasc', source_url='https://example.test/house', property_type='house',
                       surface_m2=Decimal('120'), description='Maison de 120 m².',
                       raw_payload={'llm_extraction': {'display_description': 'Maison de 500 m².',
                                                       'confidence': {'display_description': 1}}})
    apply_cached_llm_extraction_to_sale(sale, prompt_version='v1')
    assert sale.raw_payload['llm_display_status'] == 'fallback'
    assert '500' not in sale.raw_payload['llm_display_description']
    assert '120' in sale.raw_payload['llm_display_description']
    assert sale.raw_payload['llm_display_evidence_check']['issues'][0]['code'] == 'unsupported_area'


def test_written_rooms_and_exact_cadastral_units_are_supported():
    assert not codes('4 pièces sur un terrain de 1115 m².', 'Quatre pièces. Terrain de 11 a 15 ca.')
    assert 'unsupported_area' in codes('Terrain de 2900 m².', 'Contenance de 29 a et 31 ca.')


def test_scientific_surface_is_not_misread_as_the_exponent():
    result = codes('Surface de 2,2E+3 m².', 'Terrain de 22 a.')
    assert result == {'scientific_surface_notation'}
