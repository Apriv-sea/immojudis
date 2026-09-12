import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from src.dedupe import merge_duplicate_sales
from src.freshness import detail_is_fresh, document_fingerprint, documents_are_current, record_source_checks
from src.normalize import normalize_sale
from src.pdf_enrichment import download_documents
from src.sources.common import PaginationCoverage
from src.storage import supabase_client as storage


def test_source_check_expires_and_content_change_invalidates_enrichment():
    raw = {"source_url": "https://example.test/sale", "source_name": "avoventes", "raw_text": "Libre"}
    record_source_checks([raw], {})
    known = {raw["source_url"]: {"raw_payload": dict(raw)}}
    assert detail_is_fresh(known[raw["source_url"]], raw["source_url"])
    changed = {**raw, "raw_text": "Occupé", "llm_prompt_version": "old", "document_facts_version": "old",
               "llm_display_description": "Ancienne analyse : bien libre"}
    record_source_checks([changed], known)
    assert "llm_prompt_version" not in changed
    assert "document_facts_version" not in changed
    assert 'llm_display_description' not in changed
    assert changed['llm_display_status'] == 'pending'
    assert changed['superseded_analysis']['description'] == 'Ancienne analyse : bien libre'
    known[raw["source_url"]]["raw_payload"]["source_checks"][raw["source_url"]]["checked_at"] = (datetime.now(UTC) - timedelta(days=2)).isoformat()
    assert not detail_is_fresh(known[raw["source_url"]], raw["source_url"])


def test_document_identity_and_failures_invalidate_analysis():
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://example.test/sale", "documents": [{"url": "https://example.test/a.pdf"}]})
    sale.raw_payload["document_analysis"] = {"checked_at": datetime.now(UTC).isoformat(), "input_fingerprint": document_fingerprint(sale.documents)}
    assert documents_are_current(sale)
    sale.documents.append({"url": "https://example.test/b.pdf"})
    assert not documents_are_current(sale)
    sale.documents.pop()
    sale.raw_payload["document_analysis"]["failed_documents"] = 1
    assert not documents_are_current(sale)


def test_pdf_revalidation_archives_replacement_and_handles_304(tmp_path, monkeypatch):
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://example.test/sale", "documents": [{"url": "https://example.test/pv.pdf", "label": "PV descriptif"}]})
    bodies = [b"%PDF-1.4\nold\n%%EOF", b"%PDF-1.4\nnew\n%%EOF"]
    requests = []
    def fetch(url, *, headers, **kwargs):
        requests.append(headers)
        return httpx.Response(200 if bodies else 304, content=bodies.pop(0) if bodies else b"", headers={"etag": "v2"}, request=httpx.Request("GET", url))
    monkeypatch.setattr("src.pdf_enrichment._download_document_response", fetch)
    downloaded = download_documents(sale, output_root=tmp_path)
    file = Path(downloaded[0]["file_path"])
    metadata = file.with_suffix(file.suffix + ".http.json")
    def expire():
        data = json.loads(metadata.read_text())
        data["checked_at"] = "2020-01-01T00:00:00+00:00"
        metadata.write_text(json.dumps(data))
    expire()
    download_documents(sale, output_root=tmp_path)
    assert b"new" in file.read_bytes()
    assert b"old" in next((file.parent / "versions").iterdir()).read_bytes()
    assert requests[-1]["If-None-Match"] == "v2"
    assert sale.raw_payload["source_content_changed"]
    expire()
    download_documents(sale, output_root=tmp_path)
    assert b"new" in file.read_bytes()
    assert len(requests) == 3


def test_pagination_reports_limit_repeat_and_exhaustion():
    page = [{"source_url": "https://example.test/a"}]
    pagination = PaginationCoverage()
    assert pagination.accept(page)
    assert not pagination.metrics()["coverage_complete"]
    assert not pagination.accept(page)
    assert pagination.metrics()["stop_reason"] == "repeated_page"
    pagination = PaginationCoverage()
    pagination.accept(page)
    pagination.accept([])
    assert not pagination.metrics()["coverage_complete"]
    pagination.accept([], terminal=True, expected_total=1)
    assert pagination.metrics()["coverage_complete"]


def test_distinct_lots_at_same_address_are_not_merged():
    base = {"address": "12 rue Victor Hugo", "city": "Bordeaux", "sale_date": "2026-10-01", "starting_price_eur": 10000}
    a = normalize_sale({**base, "source_name": "avoventes", "source_url": "https://example.test/a", "lot_number": "1"})
    b = normalize_sale({**base, "source_name": "licitor", "source_url": "https://example.test/b", "lot_number": "2"})
    assert len(merge_duplicate_sales([a, b])) == 2


def test_publication_failure_rolls_back_without_rest_fallback(monkeypatch):
    monkeypatch.setattr("src.publication_identity.resolve_publication_identities", lambda connection, sales: sales)
    events = []
    class Connection:
        def __enter__(self):
            events.append("begin")
            return self
        def __exit__(self, kind, value, tb):
            events.append("rollback" if kind else "commit")
        def execute(self, *args):
            pass
    monkeypatch.setattr(storage, "load_settings", lambda: {"supabase_url": "https://example.test", "supabase_service_role_key": "test", "supabase_db_url": "test"})
    monkeypatch.setattr(storage, "_postgres_connect", lambda _: Connection())
    monkeypatch.setattr(storage, "tribunal_reference_rows", lambda _: [])
    monkeypatch.setattr(storage, "_transaction_write", lambda *args: events.append("write"))
    monkeypatch.setattr(storage, "_sync_normalized_sale_tables_with_rest", lambda *args, **kwargs: None)
    monkeypatch.setattr(storage, "_upsert_asset_tables_with_rest", lambda *args: (_ for _ in ()).throw(ValueError("broken child table")))
    monkeypatch.setattr(storage, "_upsert_with_rest", lambda *args: events.append("REST"))
    sale = normalize_sale({"source_name": "avoventes", "starting_price_eur": 10000, "source_url": "https://example.test/a"})
    with pytest.raises(ValueError, match="broken child"):
        storage.upsert_sales_to_supabase([sale])
    assert events == ["begin", "write", "rollback"]
    assert storage._PUBLICATION_CONNECTION.get() is None


def test_missing_surface_queues_fact_extraction_after_documents(monkeypatch):
    rows = []
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda url, key, table, payload, conflict: rows.extend(payload))
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://example.test/a", "sale_date": "2099-01-01"})
    sale.raw_payload["document_analysis"] = {"documents_extracted": 1}
    storage._enqueue_due_enrichment([sale], "url", "key")
    assert {row["job_type"] for row in rows} == {"fact_extraction", "display_description"}


def test_failed_pdf_retains_same_retry_identity_across_scans(monkeypatch):
    rows = []
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda url, key, table, payload, conflict: rows.extend(payload))
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://example.test/retry", "sale_date": "2099-01-01", "documents": [{"url": "https://example.test/pv.pdf"}]})
    sale.raw_payload["document_analysis"] = {"failed_documents": 1, "checked_at": "2026-09-01T00:00:00+00:00"}
    storage._enqueue_due_enrichment([sale], "url", "key")
    first = next(row["input_hash"] for row in rows if row["job_type"] == "pdf")
    rows.clear()
    sale.raw_payload["document_analysis"]["checked_at"] = "2026-09-02T00:00:00+00:00"
    storage._enqueue_due_enrichment([sale], "url", "key")
    assert next(row["input_hash"] for row in rows if row["job_type"] == "pdf") == first


def test_replaced_document_creates_new_fact_job_even_at_same_url(monkeypatch):
    rows = []
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda url, key, table, payload, conflict: rows.extend(payload))
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://example.test/replaced", "sale_date": "2099-01-01"})
    sale.raw_payload["document_analysis"] = {"documents_extracted": 1, "profiles": [{"url": "https://example.test/pv.pdf", "sha256": "old"}]}
    storage._enqueue_due_enrichment([sale], "url", "key")
    old = next(row["input_hash"] for row in rows if row["job_type"] == "fact_extraction")
    rows.clear()
    sale.raw_payload["document_analysis"]["profiles"][0]["sha256"] = "new"
    storage._enqueue_due_enrichment([sale], "url", "key")
    assert next(row["input_hash"] for row in rows if row["job_type"] == "fact_extraction") != old


def test_new_document_url_does_not_inherit_old_pdf_price_or_surface():
    from src.main import _preserve_known_enrichment_payloads
    raw = {"source_name": "licitor", "source_url": "https://example.test/newdoc",
           "documents": [{"url": "https://example.test/new.pdf"}], "starting_price_eur": 100000}
    known = {raw["source_url"]: {"surface_m2": 90, "surface_source": "pdf", "starting_price_eur": 200000,
             "documents": [{"url": "https://example.test/old.pdf"}],
             "raw_payload": {"llm_display_description": "Ancien document", "surface_extraction": {"source": "pdf"}}}}
    _preserve_known_enrichment_payloads([raw], known)
    assert raw["starting_price_eur"] == 100000
    assert not raw.get("surface_m2")
    assert not raw.get("llm_display_description")
    assert raw["source_factual_snapshot"]["starting_price_eur"] == 100000


def test_changed_bytes_without_local_cache_invalidate_facts_before_ocr():
    from decimal import Decimal

    from src.pdf_enrichment import _invalidate_replaced_document_facts
    sale = normalize_sale({"source_name": "licitor", "source_url": "https://example.test/sale",
                           "surface_m2": 90, "surface_source": "pdf", "starting_price_eur": 200000})
    sale.raw_payload.update({"document_analysis": {"profiles": [{"url": "https://example.test/pv.pdf", "sha256": "old"}]},
                             "llm_display_description": "Ancienne analyse certaine", "starting_price_extraction": {"source": "pdf"},
                             "source_factual_snapshot": {"source_name": "licitor", "source_url": sale.source_url,
                                                         "starting_price_eur": 100000}})
    _invalidate_replaced_document_facts(sale, [{"url": "https://example.test/pv.pdf", "sha256": "old"}])
    assert sale.raw_payload.get("llm_display_description")
    _invalidate_replaced_document_facts(sale, [{"url": "https://example.test/pv.pdf", "sha256": "new"}])
    assert not sale.raw_payload.get("llm_display_description")
    assert sale.raw_payload["superseded_analysis"]["reason"] == "document_bytes_changed"
    assert sale.surface_m2 is None
    assert sale.starting_price_eur == Decimal(100000)


def test_unknown_date_still_queues_document_enrichment(monkeypatch):
    rows = []
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda url, key, table, payload, conflict: rows.extend(payload))
    sale = normalize_sale({"source_name": "licitor", "source_url": "https://example.test/no-date",
                           "documents": [{"url": "https://example.test/pv.pdf"}]})
    sale.status = "unknown"
    storage._enqueue_due_enrichment([sale], "url", "key")
    assert {row["job_type"] for row in rows} == {"pdf", "display_description"}
