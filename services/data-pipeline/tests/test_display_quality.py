from decimal import Decimal

import pytest

from src import main
from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION, has_current_display, preserve_source_constraints
from src.enrichment.extract_structured import apply_cached_llm_extraction_to_sale
from src.models import AuctionSale


@pytest.mark.parametrize('status', ['accepted', 'fallback'])
def test_legacy_display_needs_quality_revalidation(status):
    payload = {'llm_display_description': 'Maison de 120 m².', 'llm_prompt_version': 'v1', 'llm_display_status': status}
    assert not has_current_display(payload, 'v1')
    payload['llm_display_quality_version'] = DISPLAY_QUALITY_VERSION
    assert has_current_display(payload, 'v1')
    assert not has_current_display(payload, 'v2')
    payload['llm_display_status'] = 'rejected'
    assert not has_current_display(payload, 'v1')


def test_source_constraints_preserve_negation_and_uncertainty():
    source = 'Maison avec jardin. Aucune servitude connue à ce jour. Certaines parcelles seraient non constructibles.'
    text, quotes = preserve_source_constraints('Maison avec jardin.', source, max_chars=850, max_words=115)
    assert quotes == ['Aucune servitude connue à ce jour.', 'Certaines parcelles seraient non constructibles.']
    assert all(f'« {quote} »' in text for quote in quotes)


def test_critical_source_sentence_has_priority_over_narrative():
    source = 'Plusieurs parcelles sont non constructibles et frappées d’un emplacement réservé par la commune.'
    text, quotes = preserve_source_constraints('Maison rénovée. ' * 80, source, max_chars=200, max_words=40)
    assert source in text
    assert len(text) <= 200 and len(text.split()) <= 40
    assert text.endswith(f'« {quotes[0]} »')


def test_over_budget_source_constraints_are_not_silently_truncated():
    text, quotes = preserve_source_constraints('Maison.', 'Servitude ' + 'précisions ' * 200, max_chars=850, max_words=115)
    assert text is None
    assert len(quotes) == 1


def test_cached_extraction_revalidates_and_keeps_source_caveat_without_ai():
    source = 'Maison de 140 m². Plusieurs parcelles sont non constructibles et frappées d’un emplacement réservé par la commune.'
    sale = AuctionSale(source_name='agrasc', source_url='https://example.test/evry', description=source,
                       raw_payload={'description': source, 'llm_display_description': 'Maison de 140 m².',
                                    'llm_prompt_version': 'v1', 'llm_extraction': {'display_description': 'Maison de 140 m².'}})
    assert main._needs_llm_display_description_refresh(sale, prompt_version='v1')
    assert apply_cached_llm_extraction_to_sale(sale, prompt_version='v1')
    assert 'emplacement réservé' in sale.raw_payload['llm_display_description']
    assert has_current_display(sale.raw_payload, 'v1')
    assert not main._needs_llm_display_description_refresh(sale, prompt_version='v1')


def test_cached_fallback_repairs_scientific_notation_without_ai():
    sale = AuctionSale(source_name='agrasc', source_url='https://example.test/revel', property_type='house',
                       city='Revel', surface_m2=Decimal('120'), description='Maison de 120 m².',
                       raw_payload={'llm_display_description': 'Maison de 1,2E+2 m².', 'llm_extraction': {}})
    assert apply_cached_llm_extraction_to_sale(sale, prompt_version='v1')
    assert '120 m²' in sale.raw_payload['llm_display_description']
    assert 'E+' not in sale.raw_payload['llm_display_description']
    assert sale.raw_payload['llm_display_status'] == 'fallback'


def test_source_section_boundary_keeps_constraint_before_room_inventory():
    clause = "Sur plusieurs parcelles formant un terrain de 1 623 m², dont plusieurs parcelles sont toutefois non constructibles et frappées d'un emplacement réservé par la commune"
    source = "Office notarial - - - - " + clause + ", comprenant : " + "Un garage et un atelier. " * 80
    text, quotes = preserve_source_constraints('Maison à Évry.', source, max_chars=850, max_words=115)
    assert quotes == [clause]
    assert clause in text
    assert 'Office notarial' not in text


def test_rejected_constraint_budget_removes_old_display_and_current_marker():
    source = 'Servitude ' + 'précisions ' * 200
    sale = AuctionSale(source_name='agrasc', source_url='https://example.test/budget', description=source,
                       raw_payload={'description': source, 'llm_display_description': 'Ancien texte.',
                                    'llm_display_quality_version': DISPLAY_QUALITY_VERSION,
                                    'llm_extraction': {'display_description': 'Maison.'}})
    assert not apply_cached_llm_extraction_to_sale(sale, prompt_version='v1')
    assert 'llm_display_description' not in sale.raw_payload
    assert not has_current_display(sale.raw_payload, 'v1')
    assert sale.raw_payload['llm_display_source_constraints'] == [source.strip()]


def test_source_land_conflict_cannot_be_published_as_confident_generated_surface():
    source = 'Surface terrain : 92 m². Références cadastrales : YD 59 (1 742m²) et YD 60 (91 m²).'
    sale = AuctionSale(source_name='agrasc', source_url='https://example.test/land-conflict',
                       property_type='house', surface_m2=Decimal('120'), description=source,
                       raw_payload={'description': source, 'operator_land_surface_conflict': True,
                                    'source_display_constraints': ['Surface terrain : 92 m².', 'Références cadastrales : YD 59 (1 742m²) et YD 60 (91 m²).'],
                                    'llm_extraction': {'display_description': 'Maison sur un terrain de 92 m².'}})
    assert apply_cached_llm_extraction_to_sale(sale, prompt_version='v1')
    text = sale.raw_payload['llm_display_description']
    assert 'sur un terrain de 92' not in text
    assert '120 m²' in text and '1 742m²' in text
    assert sale.raw_payload['llm_display_status'] == 'fallback'
    assert 'à clarifier' in text


def test_stale_extra_quote_is_not_reintroduced_into_new_source():
    text, quotes = preserve_source_constraints('Maison.', 'Maison.', max_chars=850, max_words=115,
                                              extra_quotes=['Ancienne servitude.'])
    assert text == 'Maison.' and quotes == []
