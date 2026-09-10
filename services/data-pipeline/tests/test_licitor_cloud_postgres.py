"""Opt-in integration tests: refuse anything except the temporary local PostgreSQL."""

from __future__ import annotations

import os
import re
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from test_licitor_history import DETAIL_HTML, LIST_HTML
from test_licitor_history_run import AUTHORIZATION

import src.sources.licitor_cloud as cloud
import src.sources.licitor_cloud_store as repo

ZONE = cloud.LICITOR_HISTORY_ZONE_URLS[0]
END_INDEX = re.sub(r'<a class="Next PageNav"[^>]*></a>', "", LIST_HTML).replace("3393", "1").replace("16965", "1")


@pytest.fixture
def store(monkeypatch):
    dsn = os.environ.get("LICITOR_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("Set LICITOR_TEST_DATABASE_URL to the isolated local test database")
    settings = conninfo_to_dict(dsn)
    assert settings.get("host", "").startswith("/private/tmp/licitor-cloud-pg."), "Never run against production"
    db = psycopg.connect(dsn, autocommit=True, prepare_threshold=None)
    db.execute("""truncate licitor_ingestion.events,licitor_ingestion.candidate_versions,
        licitor_ingestion.candidates,licitor_ingestion.index_entries,licitor_ingestion.index_pages,
        licitor_ingestion.aliases,licitor_ingestion.announcements,licitor_ingestion.captures,
        licitor_ingestion.tasks,licitor_ingestion.runs,licitor_ingestion.control""")
    db.execute(
        "insert into licitor_ingestion.control(singleton,enabled,monthly_enabled,authorization_record) values (true,true,true,%s)",
        (Jsonb(AUTHORIZATION),),
    )
    monkeypatch.setattr(repo, "LICITOR_HISTORY_ZONE_URLS", (ZONE,))
    monkeypatch.setattr(cloud, "LICITOR_HISTORY_ZONE_URLS", (ZONE,))
    yield repo.CloudStore(db)
    db.close()


def fixture_http(*, pages=None, detail=DETAIL_HTML, stop_after=None):
    calls = []

    class Http:
        def __init__(self, store, run_id):
            self.store = store
            self.run_id = run_id
            self.count = 0
            self.client = SimpleNamespace(close=lambda: None)

        def checkpoint(self):
            if stop_after is not None and self.count >= stop_after:
                raise cloud.BatchYield("test checkpoint")

        def load_robots(self):
            pass

        def fetch(self, url, kind):
            calls.append(url)
            self.count += 1
            self.store.request_started(self.run_id)
            html = (pages or {}).get(url, END_INDEX) if kind == "index" else detail
            with self.store.guarded():
                capture = self.store.capture(url, kind, html)
            return html, capture

    return Http, calls


def test_end_to_end_one_page_never_publishes_candidates(store):
    store.create_run("backfill-test", "backfill", None, 100)
    http, calls = fixture_http()
    result = cloud.run_tick(store, http_factory=http)
    assert result["status"] == "completed"
    assert len(calls) == 2
    report = store.summary()
    assert report["candidate_lots"] == 5
    assert report["parsed_announcements"] == 1
    assert report["lease_until"] is None
    assert report["runs"][0]["status"] == "completed"
    assert all(
        row["payload"]["publication_eligible"] is False
        for row in store.db.execute("select payload from licitor_ingestion.candidates")
    )


def test_resume_after_time_budget_and_single_writer_lease(store):
    store.create_run("backfill-test", "backfill", None, 100)
    http, calls = fixture_http(stop_after=1)
    assert cloud.run_tick(store, http_factory=http)["status"] == "checkpointed"
    assert store.summary()["candidate_lots"] == 0
    assert store.summary()["runs"][0]["pending_tasks"] == 1
    assert cloud.run_tick(store, http_factory=http)["status"] == "checkpointed"
    assert store.summary()["candidate_lots"] == 5
    http, _ = fixture_http()
    assert cloud.run_tick(store, http_factory=http)["status"] == "completed"
    assert len(calls) == 2
    assert store.acquire()
    other_db = psycopg.connect(os.environ["LICITOR_TEST_DATABASE_URL"], autocommit=True)
    other = repo.CloudStore(other_db)
    try:
        assert other.acquire() is False
        store.db.execute("update licitor_ingestion.control set lease_until=now()-interval '1 second'")
        assert other.acquire()
        with pytest.raises(repo.LeaseLost):
            with store.guarded():
                pytest.fail("Stale worker must never write")
        store.release()
        assert other.control()["lease_token"] is not None
        other.release()
    finally:
        other_db.close()


def test_monthly_refresh_is_idempotent_and_records_price_changes(store):
    store.create_run("backfill-test", "backfill", None, 100)
    http, _ = fixture_http()
    cloud.run_tick(store, http_factory=http)
    assert cloud.start_monthly(store, today=date(2026, 9, 1))["status"] == "queued"
    assert cloud.start_monthly(store, today=date(2026, 9, 2))["status"] == "already_exists"
    assert store.one("select cutoff_date from licitor_ingestion.runs where id='monthly-2026-09'")["cutoff_date"] >= date(2023, 9, 1)
    http, calls = fixture_http(detail=DETAIL_HTML.replace("376 000", "377 000"))
    assert cloud.run_tick(store, http_factory=http)["status"] == "completed"
    assert len(calls) == 2
    row = store.one("select payload from licitor_ingestion.candidates where external_id='109034:lot:1'")["payload"]
    assert row["adjudication_price_eur"] == "377000.00"
    assert "source_result_changed_pending_review" in row["quality_flags"]
    assert (
        store.one("select count(*) as n from licitor_ingestion.candidate_versions where external_id='109034:lot:1'")[
            "n"
        ]
        == 2
    )
    assert store.summary()["candidate_lots"] == 5


def test_source_access_denied_pauses_all_future_requests(store):
    store.create_run("backfill-test", "backfill", None, 100)
    http, _ = fixture_http()

    class Denied(http):
        def load_robots(self):
            raise cloud.RunPaused("source_http_403")

    assert cloud.run_tick(store, http_factory=Denied)["status"] == "paused"
    assert store.control()["network_paused"] is True
    assert cloud.start_monthly(store, today=date(2026, 9, 1))["status"] == "disabled_or_paused"
    assert cloud.run_tick(store, http_factory=Denied)["status"] == "disabled_or_paused"


def test_parser_failures_remain_visible_in_completed_campaign(store):
    store.create_run("backfill-test", "backfill", None, 100)
    http, _ = fixture_http(detail="<article class='LegalAd'>No parsed lots</article>")
    assert cloud.run_tick(store, http_factory=http)["status"] == "completed"
    summary = store.summary()
    assert summary["runs"][0]["status"] == "completed_with_errors"
    assert summary["runs"][0]["errors"] == 1
    assert summary["candidate_lots"] == 0
    assert summary["source_captures"] == 2


def test_monthly_stops_after_two_known_old_pages(store):
    store.create_run("backfill-test", "backfill", None, 100)
    http, _ = fixture_http()
    cloud.run_tick(store, http_factory=http)
    # All rows are known, older than the rolling window. Page two is a boundary check.
    cloud.start_monthly(store, today=date(2027, 1, 1))
    first = LIST_HTML.replace("3393", "3").replace("16965", "3")
    second = first.replace("?p=2", "?p=3")
    http, calls = fixture_http(pages={ZONE: first, ZONE + "?p=2": second})
    assert cloud.run_tick(store, http_factory=http)["status"] == "completed"
    assert calls == [ZONE, ZONE + "?p=2"]
    assert store.summary()["candidate_lots"] == 5


def test_backfill_stops_at_two_old_unknown_pages_without_fetching_details(store):
    store.create_run("backfill-window", "backfill", None, 100)
    cutoff = cloud.licitor_window_start(datetime.now(UTC).date())
    older = (cutoff - timedelta(days=1)).strftime("%d-%m-%Y")
    first = LIST_HTML.replace("09-07-2026", older).replace("3393", "3").replace("16965", "3")
    second = first.replace("?p=2", "?p=3")
    http, calls = fixture_http(pages={ZONE: first, ZONE + "?p=2": second})
    assert cloud.run_tick(store, http_factory=http)["status"] == "completed"
    assert calls == [ZONE, ZONE + "?p=2"]
    assert store.summary()["candidate_lots"] == 0


def test_active_view_keeps_exact_boundary_and_archives_invalid_old_future_dates(store):
    store.create_run("backfill-test", "backfill", None, 100)
    http, _ = fixture_http()
    cloud.run_tick(store, http_factory=http)
    original = store.one("select payload from licitor_ingestion.candidates limit 1")["payload"]
    today = datetime.now(UTC).date()
    cutoff = cloud.licitor_window_start(today)
    values = [cutoff.isoformat(), (cutoff - timedelta(days=1)).isoformat(),
              (today + timedelta(days=1)).isoformat(), None, "2026-02-30"]
    for index, value in enumerate(values):
        store.upsert_candidate({**original, "external_id": f"109034:test:{index}", "sale_date": value}, "109034")
    store.db.execute("set role licitor_collector")
    try:
        assert store.one("select count(*) as n from licitor_ingestion.active_candidates where external_id like '%%:test:%%'")["n"] == 1
        assert store.summary()["outside_window_candidate_lots"] == 4
        assert store.one("select count(*) as n from licitor_ingestion.candidates")["n"] == 10
    finally:
        store.db.execute("reset role")


def test_private_statistics_view_suppresses_small_samples_and_never_publishes(store):
    store.create_run("backfill-test", "backfill", None, 100)
    http, _ = fixture_http()
    cloud.run_tick(store, http_factory=http)
    store.db.execute("set role licitor_collector")
    try:
        national = store.one(
            "select * from licitor_ingestion.diagnostic_price_statistics where scope_type='national'"
        )
        assert national["sample_size"] == 4
        assert national["diagnostic_status"] == "insufficient_data"
        assert national["median_hammer_to_starting_ratio"] is None
        assert national["publication_eligible"] is False
        tribunal = store.one(
            "select * from licitor_ingestion.diagnostic_price_statistics where scope_type='tribunal'"
        )
        assert tribunal["sample_size"] == 4
        assert tribunal["median_hammer_price_eur"] is None
    finally:
        store.db.execute("reset role")


def test_worker_role_cannot_enable_collection_or_publish_candidates(store):
    store.db.execute("set role licitor_collector")
    try:
        assert store.summary()["candidate_lots"] == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            store.db.execute("update licitor_ingestion.control set enabled=false")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            store.db.execute("select licitor_ingestion.dispatch_pending()")
        assert store.acquire()
        store.release()
    finally:
        store.db.execute("reset role")


def test_publication_guard_is_enforced_in_database(store):
    store.register("https://www.licitor.com/annonce/test/123.html")
    with pytest.raises(psycopg.errors.CheckViolation):
        store.upsert_candidate({"external_id": "123:lot:1", "publication_eligible": True}, "123")


def test_later_alias_enriches_own_city_without_duplicate_download(store):
    entry = cloud.parse_licitor_history_list_html(LIST_HTML).entries[0]
    alias = entry.source_url.replace("un-appartement/garches/hauts-de-seine", "une-maison/nice/alpes-maritimes")
    second = END_INDEX.replace(entry.source_url.removeprefix("https://www.licitor.com"), alias)
    second = second.replace("Garches", "Nice").replace('class="Number">92', 'class="Number">06')
    detail = DETAIL_HTML.replace(
        "</div></article>",
        """<section class="AddressBlock">
        <div class="Lot"><h1>7ème lot de vente</h1><div class="SousLot"><h2>Une maison</h2></div>
        <h3>Adjudication : 200 000 €</h3><h4>(Mise à prix : 100 000 €)</h4></div>
        <div class="Location"><p class="City">Nice (Alpes-Maritimes)</p></div>
        </section></div></article>""",
    )
    store.create_run("backfill-test", "backfill", None, 100)
    http, calls = fixture_http(pages={ZONE: LIST_HTML, ZONE + "?p=2": second}, detail=detail)
    assert cloud.run_tick(store, http_factory=http)["status"] == "completed"
    assert len(calls) == 3
    assert alias not in calls
    rows = [
        r["payload"] for r in store.db.execute("select payload from licitor_ingestion.candidates order by external_id")
    ]
    assert len(rows) == 6
    assert rows[0]["department"] == "92"
    assert rows[-1]["department"] == "06"
    assert set(rows[-1]["source_alias_urls"]) == {alias, entry.source_url}


def test_disappearing_lot_is_retained_and_excluded(store):
    store.create_run("backfill-test", "backfill", None, 100)
    http, _ = fixture_http()
    cloud.run_tick(store, http_factory=http)
    cloud.start_monthly(store, today=date(2026, 9, 1))
    shorter = re.sub(
        r'<div class="Lot">\s*<h1>6ème lot de vente</h1>.*?</div>\s*<div class="Location">',
        '<div class="Location">',
        DETAIL_HTML,
        flags=re.S,
    )
    http, _ = fixture_http(detail=shorter)
    cloud.run_tick(store, http_factory=http)
    row = store.one("select payload from licitor_ingestion.candidates where external_id='109034:lot:6'")["payload"]
    assert "lot_missing_in_latest_capture" in row["quality_flags"]
    assert store.summary()["candidate_lots"] == 5


def test_sqlite_handoff_is_atomic_idempotent_and_resumes_only_remaining_work(store, tmp_path, monkeypatch):
    from src.sources import licitor_cloud_import as transfer
    from src.sources import licitor_history_run as local

    monkeypatch.setattr(local, "LICITOR_HISTORY_ZONE_URLS", (ZONE,))
    state = local.ArchiveState(tmp_path / "archive")
    state.bind(AUTHORIZATION)

    class LocalHttp:
        count = 0

        def checkpoint(self):
            pass

        def fetch(self, url, kind):
            content = LIST_HTML if kind == "index" else DETAIL_HTML
            state.capture(url, kind, content)
            self.count += 1
            return content

    local.collect(state, LocalHttp(), AUTHORIZATION, max_pages=1)
    snapshot = tmp_path / "snapshot.sqlite3"
    transfer.snapshot_archive(state.root / "archive.sqlite3", snapshot)
    with pytest.raises(ValueError, match="Disable"):
        transfer.import_snapshot(store, snapshot, "backfill-test")
    assert store.summary()["candidate_lots"] == 0
    store.db.execute("update licitor_ingestion.control set enabled=false")
    report = transfer.import_snapshot(store, snapshot, "backfill-test")
    assert report["candidate_lots"] == 5
    assert transfer.import_snapshot(store, snapshot, "backfill-test") == report
    assert store.summary()["runs"][0]["pending_tasks"] == 1
    assert store.summary()["source_captures"] == 2
    store.db.execute("update licitor_ingestion.control set enabled=true")
    http, calls = fixture_http()
    assert cloud.run_tick(store, http_factory=http)["status"] == "completed"
    assert calls == [ZONE + "?p=2"]
    assert store.summary()["candidate_lots"] == 5
    state.db.close()
