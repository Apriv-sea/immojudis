from datetime import UTC, datetime
from types import SimpleNamespace

import fitz
import pytest

from src import main, pdf_enrichment, pipeline_health, queued_runner
from src.enrichment import extract_structured as extraction
from src.models import AuctionSale


def test_backfill_commits_before_next_result_even_if_interrupted(monkeypatch):
    monkeypatch.delenv("GITHUB_ENV", raising=False)
    sales = [AuctionSale(source_name="avoventes", source_url=f'https://example.test/{i}', description='Maison à Bordeaux.', last_seen_at=datetime(2026, 1, 1, tzinfo=UTC)) for i in range(2)]
    stored = []
    monkeypatch.setattr(main, 'fetch_sales_needing_llm_descriptions', lambda **kw: sales)
    monkeypatch.setattr(main, 'create_run_in_supabase', lambda *a, **kw: 'run')
    monkeypatch.setattr(main, 'update_run_progress_in_supabase', lambda *a: None)
    monkeypatch.setattr(main, 'create_llm_client', lambda: object())
    monkeypatch.setattr(main, '_finalize_sale_for_app', lambda *a, **kw: None)
    monkeypatch.setattr(main, 'upsert_sales_to_supabase', lambda rows, **kw: stored.append((rows[0].source_url, kw, rows[0].last_seen_at)) or 1)
    def enrich(sale, **kw):
        sale.raw_payload.update(llm_display_description='Maison à Bordeaux.', llm_prompt_version=main.load_settings()['llm_prompt_version'])
        return main.LLMEnrichmentStats(analyzed=1, valid_json=1)
    monkeypatch.setattr(main, 'enrich_sale_with_llm', enrich)
    def interrupted(futures):
        yield next(iter(futures))
        raise KeyboardInterrupt()
    monkeypatch.setattr(main, 'as_completed', interrupted)
    with pytest.raises(KeyboardInterrupt):
        main.run_llm_description_backfill(main.PipelineOptions(llm_backfill=True))
    assert stored == [(sales[0].source_url, {'refresh_last_seen': False}, datetime(2026, 1, 1, tzinfo=UTC))]


@pytest.mark.parametrize('error_count,coverage,description', [(1, True, 'Résumé'), (0, False, 'Résumé'), (0, True, '')])
def test_worker_never_completes_partial_fact_job(monkeypatch, error_count, coverage, description):
    sale = AuctionSale(source_name="avoventes", source_url='https://example.test/a', description='Maison')
    finished = []
    monkeypatch.setattr(queued_runner, 'claim_auction_enrichment_jobs_from_supabase', lambda **kw: [{'id': 'job', 'source_url': sale.source_url, 'job_type': 'fact_extraction'}])
    monkeypatch.setattr(queued_runner, 'fetch_sale_for_data_refresh', lambda _: sale)
    monkeypatch.setattr(queued_runner, 'create_llm_client', lambda: object())
    def enrich(*a, **kw):
        sale.raw_payload.update(llm_display_description=description, llm_prompt_version=queued_runner.load_settings()['llm_prompt_version'], llm_fact_coverage={'complete': coverage})
        return SimpleNamespace(valid_json=1, errors=error_count, unavailable=False, error_messages=['partial'] if error_count else [])
    monkeypatch.setattr(queued_runner, 'enrich_sale_with_llm', enrich)
    monkeypatch.setattr(queued_runner, 'upsert_sales_to_supabase', lambda *a, **kw: pytest.fail('Partial data must not complete publication'))
    monkeypatch.setattr(queued_runner, 'finish_auction_enrichment_job_in_supabase', lambda job, **kw: finished.append(kw))
    queued_runner.run_enrichment_queue_batch(limit=1)
    assert finished[0]['succeeded'] is False


def test_failed_chunk_is_retried_without_paying_for_successful_chunk(tmp_path, monkeypatch):
    monkeypatch.setenv('LLM_ENABLED', 'true')
    monkeypatch.setenv('INCREMENTAL_ENRICHMENT', 'true')
    monkeypatch.setattr(extraction, 'load_llm_fact_context_chunks_for_sale', lambda *a, **kw: ['chunk-A', 'chunk-B'])
    monkeypatch.setattr(extraction, 'load_llm_context_for_sale', lambda *a, **kw: 'Maison')
    calls = []
    class Client:
        model = 'test'
        failing = True
        def is_available(self):
            return True
        def generate_json(self, system, prompt):
            calls.append(prompt)
            if 'chunk-B' in prompt and self.failing:
                raise ValueError('transient')
            return {'display_description': 'Maison décrite par les pièces.'}
    client = Client()
    sale = AuctionSale(source_name="avoventes", source_url='https://example.test/chunks', description='Maison')
    first = extraction.enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode='structured_then_display')
    assert first.errors == 1
    assert sale.raw_payload['llm_fact_coverage']['complete'] is False
    assert not list(tmp_path.glob('*.json'))
    client.failing = False
    second = extraction.enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode='structured_then_display')
    assert second.errors == 0
    assert sale.raw_payload['llm_fact_coverage']['complete'] is True
    assert sum('chunk-A' in prompt for prompt in calls) == 1
    assert sum('chunk-B' in prompt for prompt in calls) == 2


def test_long_digital_pdf_and_resumable_ocr(tmp_path, monkeypatch):
    monkeypatch.setattr(pdf_enrichment, 'PDF_DOCUMENT_TEXTS_DIR', tmp_path / 'cache')
    monkeypatch.setenv('PDF_MAX_EXTRACT_PAGES', '2')
    monkeypatch.setenv('PDF_OCR_ENABLED', 'true')
    path = tmp_path / 'large.pdf'
    with fitz.open() as document:
        for _ in range(5):
            document.new_page()
        document.save(path)
    processed = []
    monkeypatch.setattr(pdf_enrichment, '_extract_page_text_with_ocr_result', lambda page, **kw: processed.append(page.number) or {'text': 'Texte OCR', 'method': 'ocr_test', 'confidence': .8})
    for _ in range(2):
        with pytest.raises(ValueError, match='retry resumes'):
            pdf_enrichment.extract_pdf_pages(path)
    pages = pdf_enrichment.extract_pdf_pages(path)
    assert len(pages) == 5
    assert processed == list(range(5))
    monkeypatch.setenv('PDF_OCR_ENABLED', 'false')
    assert len(pdf_enrichment.extract_pdf_pages(path)) == 5


def test_health_fails_for_old_queue_stalled_runs_and_stale_sources():
    base = {'queue': [], 'sources': [], 'latest_collection': {}}
    assert not pipeline_health.health_failed(base)
    assert pipeline_health.health_failed({**base, 'queue': [{'exhausted': 0, 'overdue': 1790}]})
    assert pipeline_health.health_failed({**base, 'stalled_runs': 1})
    assert pipeline_health.health_failed({**base, 'sources': [{'stale': 1}]})


def test_stream_download_stops_at_limit():
    import httpx
    class Stream(httpx.SyncByteStream):
        consumed = 0
        def __iter__(self):
            for _ in range(100):
                self.consumed += 1
                yield b'x' * 65536
    stream = Stream()
    response = httpx.Response(200, stream=stream)
    with pytest.raises(ValueError, match='download limit'):
        pdf_enrichment._read_document_stream(response, 65536)
    assert stream.consumed == 2


def test_cessions_tls_retains_root_and_hostname_validation():
    import hashlib
    import ssl
    from pathlib import Path

    from src.sources import cessions_etat
    ctx = cessions_etat.cessions_tls_context()
    assert ctx.check_hostname
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert not ctx.verify_flags & ssl.VERIFY_X509_PARTIAL_CHAIN
    pem = (Path(cessions_etat.__file__).with_name('certificates') / 'sectigo-public-ov-r36.pem').read_text()
    assert hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest() == '6542d176bed50f193c0ce297ae44ecd8a0a86bec2ede682769344059b4e78530'


def test_source_retries_transient_errors_but_not_forbidden(monkeypatch):
    import httpx

    from src.sources.common import PoliteHttpClient
    client = object.__new__(PoliteHttpClient)
    client.delay_seconds = 0
    responses = [503, 200]
    calls = []
    def request(*a, **kw):
        calls.append(a)
        return httpx.Response(responses.pop(0))
    client._client = SimpleNamespace(request=request)
    monkeypatch.setattr('src.sources.common.time.sleep', lambda _: None)
    assert client._request_with_retries('GET', 'https://example.test').status_code == 200
    assert len(calls) == 2
    responses[:] = [403, 200]
    assert client._request_with_retries('GET', 'https://example.test').status_code == 403
    assert responses == [200]


def test_truncated_fact_context_cannot_be_cached_as_complete(tmp_path, monkeypatch):
    monkeypatch.setenv('LLM_ENABLED', 'true')
    sale = AuctionSale(source_name='avoventes', source_url='https://example.test/truncated', description='Maison')
    def contexts(*a, **kw):
        sale.raw_payload['llm_fact_context_coverage'] = {'complete': False}
        return ['Only the first page']
    monkeypatch.setattr(extraction, 'load_llm_fact_context_chunks_for_sale', contexts)
    monkeypatch.setattr(extraction, 'load_llm_context_for_sale', lambda *a, **kw: 'Maison')
    client = SimpleNamespace(model='test', is_available=lambda: True, generate_json=lambda *a: {'display_description': 'Maison décrite.'})
    stats = extraction.enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode='structured_then_display')
    assert stats.errors > 0
    assert not sale.raw_payload['llm_fact_coverage']['complete']
    assert not list(tmp_path.glob('*.json'))


def test_expired_attempt_cannot_finish_new_claim(monkeypatch):
    from src.storage import supabase_client as storage
    captured = []
    monkeypatch.setattr(storage, 'load_settings', lambda: {'supabase_url': 'https://example.test', 'supabase_service_role_key': 'test'})
    monkeypatch.setattr(storage.httpx, 'patch', lambda *a, **kw: captured.append(kw) or SimpleNamespace(is_error=False))
    storage.finish_auction_enrichment_job_in_supabase('job', succeeded=True, attempt_count=2)
    assert captured[0]['params'] == {'id': 'eq.job', 'status': 'eq.running', 'attempt_count': 'eq.2'}


def test_register_run_exports_only_valid_uuid(tmp_path, monkeypatch):
    from src.run_finalizer import register_run
    target = tmp_path / "github-env"
    monkeypatch.setenv("GITHUB_ENV", str(target))
    register_run("11111111-1111-4111-8111-111111111111")
    assert target.read_text() == "PIPELINE_CURRENT_RUN_ID=11111111-1111-4111-8111-111111111111\n"
    with pytest.raises(ValueError):
        register_run("bad\nINJECTED=value")
