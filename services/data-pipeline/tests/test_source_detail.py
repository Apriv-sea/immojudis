import pytest

from src import source_detail

SETTINGS = {'user_agent': 'Immojudis source verification'}


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
