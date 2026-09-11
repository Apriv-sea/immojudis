from src.source_coverage_audit import page_evidence
from src.sources.common import PaginationCoverage, ScrapeResult


def test_empty_html_or_login_page_does_not_certify_inventory():
    p = PaginationCoverage()
    p.accept([{'source_url': 'https://example.test/a'}])
    p.accept([])
    assert p.metrics()['coverage_complete'] is False
    assert p.metrics()['stop_reason'] == 'empty_page_unverified'


def test_announced_total_must_match_distinct_listings():
    p = PaginationCoverage()
    p.accept([{'source_url': 'a'}], terminal=True, expected_total=2)
    assert not p.exhausted
    p.accept([{'source_url': 'b'}], terminal=True, expected_total=2)
    assert p.exhausted


def test_changing_totals_cannot_certify_snapshot():
    p = PaginationCoverage()
    p.accept([{'source_url': 'a'}], expected_total=1)
    p.accept([{'source_url': 'b'}], terminal=True, expected_total=2)
    assert not p.exhausted and p.total_changed


def test_failed_page_overrides_exhaustion_claim():
    result = ScrapeResult([], ['page 2 failed'], {'coverage_complete': True})
    assert result.coverage['coverage_complete'] is False
    assert result.coverage['stop_reason'] == 'source_errors'


def test_audit_records_provider_totals_and_public_next_links():
    evidence = page_evidence('{"nbTotalAnnonces":48,"nbPages":2,"page":1,"annonceResumeDto":[{}]}', 'https://example.test/api')
    assert evidence['advertised_total'] == 48 and evidence['raw_rows'] == 1
    evidence = page_evidence('<a rel="next" href="?page=2">Suivant</a>', 'https://example.test/list')
    assert evidence['pagination_links'] == ['https://example.test/list?page=2']
