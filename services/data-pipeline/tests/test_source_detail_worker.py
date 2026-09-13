from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest

from src import source_detail_worker as worker
from src.models import AuctionSale


def _job(**overrides):
    value = {
        "id": "job-1",
        "source_url": "https://catalogue.example/sale-1",
        "job_type": "source_detail",
        "detail_source_name": "licitor",
        "detail_source_url": "https://www.licitor.com/annonce/alias-1",
        "attempt_count": 2,
    }
    value.update(overrides)
    return value


def _sale():
    return AuctionSale(
        source_name="licitor",
        source_url="https://catalogue.example/sale-1",
        city="Bordeaux",
        starting_price_eur=100_000,
    )


def _settings():
    return {"user_agent": "test", "supabase_db_url": None}


def test_source_detail_gate_fails_closed_without_database():
    assert worker.source_detail_source_enabled("licitor", _settings()) is False


def test_alias_is_fetched_but_canonical_sale_is_reloaded(monkeypatch):
    sale = _sale()
    fetched = []
    published = []

    monkeypatch.setattr(worker, "source_detail_source_enabled", lambda source, settings: True)
    monkeypatch.setattr(
        worker,
        "fetch_sale_for_data_refresh",
        lambda source_url: fetched.append(source_url) or sale,
    )
    monkeypatch.setattr(
        worker,
        "fetch_public_detail",
        lambda source, url, settings, clients: (
            "https://www.licitor.com/annonce/alias-1",
            "body",
            {"source_name": source, "source_url": url, "starting_price_eur": 120_000},
        ),
    )
    monkeypatch.setattr(worker, "prepare_source_revision", lambda existing, raw: (existing, raw))
    monkeypatch.setattr(
        worker,
        "publish_source_revision",
        lambda revision, job, settings: published.append(revision) or True,
    )

    assert worker.process_source_detail_job(_job(), settings=_settings()) is True
    assert fetched == ["https://catalogue.example/sale-1"]
    assert published[0][1]["source_url"] == "https://www.licitor.com/annonce/alias-1"


def test_verified_detail_publishes_without_pdf_llm_or_geocode(monkeypatch):
    sale = _sale()
    calls = []
    monkeypatch.setattr(worker, "source_detail_source_enabled", lambda source, settings: True)
    monkeypatch.setattr(worker, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(
        worker,
        "fetch_public_detail",
        lambda *args: (args[1], "body", {"source_url": args[1], "source_name": "licitor"}),
    )
    monkeypatch.setattr(worker, "prepare_source_revision", lambda existing, raw: calls.append("prepare") or existing)
    monkeypatch.setattr(
        worker,
        "publish_source_revision",
        lambda revision, job, settings: calls.append("publish") or True,
    )

    assert worker.process_source_detail_job(_job(), settings=_settings()) is True
    assert calls == ["prepare", "publish"]


def test_outdated_lease_does_not_finish_or_publish(monkeypatch):
    sale = _sale()
    finished = []
    published = []
    monkeypatch.setattr(worker, "source_detail_source_enabled", lambda source, settings: True)
    monkeypatch.setattr(worker, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(
        worker,
        "fetch_public_detail",
        lambda *args: (args[1], "body", {"source_url": args[1], "source_name": "licitor"}),
    )
    monkeypatch.setattr(worker, "prepare_source_revision", lambda existing, raw: existing)
    monkeypatch.setattr(
        worker,
        "publish_source_revision",
        lambda revision, job, settings: published.append(job["id"]) or False,
    )
    monkeypatch.setattr(
        worker,
        "finish_auction_enrichment_job_in_supabase",
        lambda *args, **kwargs: finished.append((args, kwargs)),
    )

    assert worker.process_source_detail_job(_job(), settings=_settings()) is False
    assert published == ["job-1"]
    assert finished == []


def test_404_failure_does_not_publish_or_change_source_state(monkeypatch):
    sale = _sale()
    finished = []
    refusals = []
    request = httpx.Request("GET", "https://www.licitor.com/annonce/alias-1")
    response = httpx.Response(404, request=request)
    error = httpx.HTTPStatusError("not found", request=request, response=response)
    monkeypatch.setattr(worker, "source_detail_source_enabled", lambda source, settings: True)
    monkeypatch.setattr(worker, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(worker, "fetch_public_detail", lambda *args: (_ for _ in ()).throw(error))
    monkeypatch.setattr(worker, "prepare_source_revision", lambda *args: (_ for _ in ()).throw(AssertionError()))
    monkeypatch.setattr(worker, "publish_source_revision", lambda *args: (_ for _ in ()).throw(AssertionError()))
    monkeypatch.setattr(worker, "report_source_detail_refusal", lambda *args, **kwargs: refusals.append(args))
    monkeypatch.setattr(
        worker,
        "finish_auction_enrichment_job_in_supabase",
        lambda *args, **kwargs: finished.append((args, kwargs)),
    )

    assert worker.process_source_detail_job(_job(), settings=_settings()) is False
    assert len(finished) == 1
    assert finished[0][1]["succeeded"] is False
    assert refusals == []


def test_empty_detail_parse_does_not_publish(monkeypatch):
    sale = _sale()
    finished = []
    monkeypatch.setattr(worker, "source_detail_source_enabled", lambda source, settings: True)
    monkeypatch.setattr(worker, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(worker, "fetch_public_detail", lambda *args: (args[1], "body", {}))
    monkeypatch.setattr(worker, "publish_source_revision", lambda *args: (_ for _ in ()).throw(AssertionError()))
    monkeypatch.setattr(
        worker,
        "finish_auction_enrichment_job_in_supabase",
        lambda *args, **kwargs: finished.append(kwargs),
    )

    assert worker.process_source_detail_job(_job(), settings=_settings()) is False
    assert finished[0]["succeeded"] is False


def test_timeout_failure_does_not_publish_or_change_source_state(monkeypatch):
    sale = _sale()
    finished = []
    refusals = []
    monkeypatch.setattr(worker, "source_detail_source_enabled", lambda source, settings: True)
    monkeypatch.setattr(worker, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(
        worker,
        "fetch_public_detail",
        lambda *args: (_ for _ in ()).throw(httpx.ReadTimeout("timed out")),
    )
    monkeypatch.setattr(worker, "report_source_detail_refusal", lambda *args, **kwargs: refusals.append(args))
    monkeypatch.setattr(
        worker,
        "finish_auction_enrichment_job_in_supabase",
        lambda *args, **kwargs: finished.append(kwargs),
    )

    assert worker.process_source_detail_job(_job(), settings=_settings()) is False
    assert finished[0]["succeeded"] is False
    assert refusals == []


def test_paused_source_releases_claim_without_http_or_attempt_consumption(monkeypatch):
    fetched = []
    released = []
    monkeypatch.setattr(worker, "source_detail_source_enabled", lambda source, settings: False)
    monkeypatch.setattr(worker, "fetch_sale_for_data_refresh", lambda source_url: fetched.append(source_url))
    monkeypatch.setattr(
        worker,
        "release_source_detail_job_without_attempt",
        lambda job, *, reason, settings=None: released.append((job["attempt_count"], reason)),
    )
    monkeypatch.setattr(
        worker,
        "fetch_public_detail",
        lambda *args: (_ for _ in ()).throw(AssertionError("paused source must not issue HTTP")),
    )

    assert worker.process_source_detail_job(_job(), settings=_settings()) is False
    assert fetched == []
    assert released == [(2, "Source-detail source is paused before fetch")]


@pytest.mark.parametrize('source,detail_url,client_origin', [
    ('licitor','https://www.licitor.com/annonce/alias-1','https://www.licitor.com'),
    ('notaires','https://www.immo-interactif.fr/encheres-en-ligne/maison/bordeaux-33/2','https://www.immobilier.notaires.fr'),
])
def test_retry_after_from_polite_client_is_carried_to_queue_finish(monkeypatch, source, detail_url, client_origin):
    sale = _sale()
    finished = []
    retry_at = "2026-09-13T12:00:00+00:00"
    client = SimpleNamespace(coverage_metrics=lambda: {"retry_not_before": retry_at})
    clients = {}
    monkeypatch.setattr(worker, "source_detail_source_enabled", lambda source, settings: True)
    monkeypatch.setattr(worker, "fetch_sale_for_data_refresh", lambda source_url: sale)

    def failed_fetch(source, url, settings, passed_clients):
        passed_clients[client_origin] = client
        raise RuntimeError("Source deferred until retry deadline")

    monkeypatch.setattr(worker, "fetch_public_detail", failed_fetch)
    monkeypatch.setattr(
        worker,
        "finish_auction_enrichment_job_in_supabase",
        lambda *args, **kwargs: finished.append((args, kwargs)),
    )

    assert worker.process_source_detail_job(_job(detail_source_name=source, detail_source_url=detail_url), settings=_settings(), clients=clients) is False
    assert finished[0][1]["retry_not_before"] == retry_at


def test_shared_client_retry_after_releases_next_claim_without_http(monkeypatch):
    retry_at = "2099-01-01T12:00:00+00:00"
    client = SimpleNamespace(coverage_metrics=lambda: {"retry_not_before": retry_at, "access_denials": 0})
    clients = {"https://www.licitor.com": client}
    released = []
    monkeypatch.setattr(worker, "source_detail_source_enabled", lambda source, settings: True)
    monkeypatch.setattr(worker, "fetch_sale_for_data_refresh", lambda *_: (_ for _ in ()).throw(AssertionError("no DB read after Retry-After")))
    monkeypatch.setattr(
        worker,
        "release_source_detail_job_without_attempt",
        lambda job, *, reason, settings=None, retry_not_before=None: released.append(
            (job["attempt_count"], reason, retry_not_before)
        ),
    )
    monkeypatch.setattr(
        worker,
        "fetch_public_detail",
        lambda *args: (_ for _ in ()).throw(AssertionError("Retry-After must prevent HTTP")),
    )

    assert worker.process_source_detail_job(_job(), settings=_settings(), clients=clients) is False
    assert released == [(2, f"Source deferred until {retry_at}", datetime.fromisoformat(retry_at))]


def test_access_refusals_persist_and_suspend_after_two_tasks(monkeypatch):
    from contextlib import nullcontext

    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    from test_autonomy_postgres import migration, setup

    from src.storage.supabase_client import _postgres_connect

    with _postgres_connect(url) as db:
        try:
            setup(db)
            db.execute(migration("20260913081411_recurring_source_detail_jobs.sql"))
            db.execute("update auction_pipeline_control set enabled=true,source_details_enabled=true")
            db.execute("update auction_source_state set enabled=true where source_name='licitor'")
            retry_at = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
            settings = {"supabase_db_url": url}
            coverage = {"access_denials": 1, "retry_not_before": retry_at}
            monkeypatch.setattr(worker.storage, '_postgres_connect', lambda _: nullcontext(db))

            worker.report_source_detail_refusal(
                "licitor",
                error_message="403 forbidden",
                coverage=coverage,
                settings=settings,
            )
            first = db.execute(
                "select availability,suspended_until,suspension_reason,coverage from auction_source_state where source_name='licitor'"
            ).fetchone()
            assert first[0] == "access_denied"
            assert first[1] is not None
            assert first[2] == "Source-detail access refused"
            assert first[3]["source_detail"]["refusal_tasks"] == 1

            worker.report_source_detail_refusal(
                "licitor",
                error_message="403 forbidden again",
                coverage=coverage,
                settings=settings,
            )
            second = db.execute(
                "select suspended_until,suspension_reason,coverage from auction_source_state where source_name='licitor'"
            ).fetchone()
            assert second[0] >= datetime.now(UTC) + timedelta(hours=23, minutes=59)
            assert second[1] == "Persistent source-detail access refusal"
            assert second[2]["source_detail"]["refusal_tasks"] == 2
        finally:
            db.rollback()
