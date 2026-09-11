from src import revalidate_displays as module
from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION
from src.models import AuctionSale


def test_revalidation_persists_quality_only_changes_without_refreshing_source_age(monkeypatch):
    sale = AuctionSale(source_name='test', source_url='https://example.test/sale', starting_price_eur=1000,
                       raw_payload={'llm_extraction': {}, 'llm_display_description': 'Existing text ' * 8})
    monkeypatch.setattr(module, 'load_settings', lambda: {'llm_prompt_version': 'test'})
    monkeypatch.setattr(module, 'fetch_sales_needing_llm_descriptions', lambda **kw: [sale])
    def revalidate(sale, **kw):
        sale.raw_payload.update(llm_display_quality_version=DISPLAY_QUALITY_VERSION, llm_display_status='accepted', llm_prompt_version='test')
        return False  # Text identical; validation metadata still changed.
    monkeypatch.setattr(module, 'apply_cached_llm_extraction_to_sale', revalidate)
    writes = []
    monkeypatch.setattr(module, 'upsert_sales_to_supabase', lambda rows, **kw: writes.append(kw) or 1)
    report = module.revalidate_cached_displays()
    assert report['revalidated'] == report['persisted'] == 1
    assert writes == [{'refresh_last_seen': False}]
