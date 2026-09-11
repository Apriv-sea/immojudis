from src.sources.info_encheres import _list_urls
from src.sources.linked_pages import LinkedPages


def test_info_does_not_skip_second_page():
    assert _list_urls(3)[1].endswith('snr=1')
    assert len(_list_urls(3)) == 3


def test_links_followed_across_empty_category_pages_without_leaving_source():
    pages = LinkedPages('https://example.test/list', 'page', 0, 10)
    bodies = {
        'https://example.test/list': '<a href="?page=0">1</a><a href="?page=1">2</a>',
        'https://example.test/list?page=1': '<a href="?page=2">3</a>'
            '<a href="https://evil.test/list?page=3">bad</a>'
            '<a href="/detail?page=4">detail</a>',
        'https://example.test/list?page=2': '<a href="?page=1">2</a>',
    }
    visited = []
    for url in pages:
        visited.append(url)
        pages.observe(bodies[url], url)
    assert len(visited) == 3
    assert pages.metrics()['linked_pages_complete'] is True
    assert pages.metrics()['coverage_complete'] is None


def test_cap_and_failed_fetch_are_not_complete():
    pages = LinkedPages('https://example.test/list', 'p', 1, 1)
    for url in pages:
        pages.observe('<a href="?p=2">next</a>', url)
    assert pages.metrics()['pending_pages'] == 1
    assert pages.metrics()['coverage_complete'] is False
    failed = LinkedPages('https://example.test/list', 'p', 1, 100)
    for _ in failed:
        break
    assert failed.metrics()['linked_pages_complete'] is False


def test_cessions_stops_after_first_failed_listing(monkeypatch):
    from src.sources import cessions_etat as source
    calls = []

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url):
            calls.append(url)
            raise RuntimeError('403 Forbidden')

    monkeypatch.setattr(source, 'PoliteHttpClient', Client)
    result = source.scrape_cessions_etat_aquitaine_result(max_pages=100)
    assert len(calls) == 1
    assert result.errors and result.coverage['coverage_complete'] is False


def test_notaires_missing_rows_cannot_certify_zero_inventory(monkeypatch):
    from src.sources import notaires as source

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url):
            return '{"nbTotalAnnonces":0,"nbPages":0}'

    monkeypatch.setattr(source, 'PoliteHttpClient', Client)
    monkeypatch.setattr(source, '_department_filters', lambda: (None,))
    result = source.scrape_notaires_aquitaine_result(max_pages=1)
    assert result.errors and result.coverage['coverage_complete'] is False


def test_numbered_path_pagination_excludes_results_and_other_origins():
    pages = LinkedPages('https://example.test/sales/', '', 1, 100,
                        path_pattern=r'/sales/list-p(\d+)\.html')
    iterator = iter(pages)
    url = next(iterator)
    pages.observe('<a href="/sales/list-p1.html">1</a><a href="/sales/list-p66.html?">66</a>'
                  '<a href="/sales/results-p2.html">results</a>'
                  '<a href="https://evil.test/sales/list-p3.html">bad</a>', url)
    assert next(iterator) == 'https://example.test/sales/list-p66.html'
    assert pages.pending == []
