from __future__ import annotations

import json
from dataclasses import asdict, replace
from datetime import date

import httpx
import pytest
from test_licitor_history import DETAIL_HTML, LIST_HTML

import src.sources.licitor_history_run as runner
from src.sources.licitor_history import build_licitor_price_statistics, parse_licitor_history_list_html

AUTHORIZATION = {
    "reference": "test-operator-call-2026-08-28",
    "source": "licitor_public_results",
    "basis": "operator_reported_verbal_consent",
    "reported_at": "2026-08-28",
    "scope": ["public_historical_results"],
    "written_confirmation_received": False,
}


def test_authorization_records_verbal_basis_without_claiming_written_consent(tmp_path) -> None:
    path = tmp_path / "authorization.json"
    path.write_text(json.dumps(AUTHORIZATION))
    assert runner.read_authorization(path)["written_confirmation_received"] is False
    state = runner.ArchiveState(tmp_path / "archive")
    state.bind(AUTHORIZATION)
    with pytest.raises(ValueError, match="Authorization changed"):
        state.bind({**AUTHORIZATION, "basis": "written_source_consent"})
    state.db.close()


def test_all_detail_lots_survive_when_only_one_is_in_the_index() -> None:
    entry = parse_licitor_history_list_html(LIST_HTML).entries[0]
    records = runner.prepare_candidates(DETAIL_HTML, entry.source_url, [entry], AUTHORIZATION, "2026-08-28T12:00:00Z")
    assert len(records) == 5
    assert "adjudication_price_eur" not in records[-1]
    assert all(row["authorization_basis"] == "operator_reported_verbal_consent" for row in records)
    assert all(row["publication_eligible"] is False for row in records)
    assert all(row["training_eligible"] is False for row in records)
    assert all("commercial_reuse_rights_pending" not in row["quality_flags"] for row in records)
    assert all("surface_m2" not in row and "lawyer_contact" not in row for row in records)
    assert records[0]["department"] == "92"


def test_ambiguous_multi_lot_starting_price_is_not_reused_for_every_lot() -> None:
    entry = parse_licitor_history_list_html(LIST_HTML).entries[0]
    records = runner.prepare_candidates(
        DETAIL_HTML.replace("pour chaque lot", "globale"),
        entry.source_url,
        [entry],
        AUTHORIZATION,
        "2026-08-28T12:00:00Z",
    )
    assert all("starting_price_eur" not in row for row in records[1:4])


def test_singular_no_bid_and_non_tribunal_venue_are_preserved_but_not_price_stats() -> None:
    entry = parse_licitor_history_list_html(LIST_HTML).entries[0]
    html = DETAIL_HTML.replace("Carence d'enchères", "Carence d'enchère").replace(
        "Tribunal Judiciaire de Paris", "Étude de Maître Test, Notaire"
    )
    records = runner.prepare_candidates(html, entry.source_url, [entry], AUTHORIZATION, "2026-08-28T12:00:00Z")
    assert "held_no_bid_candidate" in records[-1]["quality_flags"]
    assert all(row["sale_venue_type"] == "other" for row in records)
    result = build_licitor_price_statistics(records, as_of=date(2026, 8, 28), minimum_sample=1)
    assert result["periods"]["fullArchive"]["sampleSize"] == 0


def test_multi_city_page_never_assigns_first_city_department_to_other_city() -> None:
    entry = parse_licitor_history_list_html(LIST_HTML).entries[0]
    html = DETAIL_HTML.replace(
        "</div></article>",
        """<section class="AddressBlock">
        <div class="Lot"><h1>7ème lot de vente</h1><div class="SousLot"><h2>Une maison</h2></div>
        <h3>Adjudication : 200 000 €</h3><h4>(Mise à prix : 100 000 €)</h4></div>
        <div class="Location"><p class="City">Nice (Alpes-Maritimes)</p></div>
        </section></div></article>""",
    )
    records = runner.prepare_candidates(html, entry.source_url, [entry], AUTHORIZATION, "2026-08-28T12:00:00Z")
    assert records[0]["city"] == "Garches"
    assert records[0]["department"] == "92"
    assert records[-1]["city"] == "Nice"
    assert records[-1]["department"] is None


def test_conflicting_dates_do_not_enter_diagnostic_price_statistics() -> None:
    entry = replace(parse_licitor_history_list_html(LIST_HTML).entries[0], result_date=date(2025, 1, 1))
    records = runner.prepare_candidates(DETAIL_HTML, entry.source_url, [entry], AUTHORIZATION, "2026-08-28T12:00:00Z")
    assert "index_detail_date_conflict" in records[0]["quality_flags"]
    result = build_licitor_price_statistics(records, as_of=date(2026, 8, 28), minimum_sample=1)
    assert result["periods"]["fullArchive"]["sampleSize"] == 0


def test_statistics_deduplicate_lots_and_exclude_future_or_conflicting_rows() -> None:
    valid = {
        "external_id": "a",
        "sale_date": "2026-01-01",
        "starting_price_eur": "2000",
        "adjudication_price_eur": "4000",
    }
    rows = [
        valid,
        valid,
        {**valid, "external_id": "b", "sale_date": "2027-01-01"},
        {**valid, "external_id": "c"},
        {**valid, "external_id": "c", "adjudication_price_eur": "5000"},
    ]
    result = build_licitor_price_statistics(rows, as_of=date(2026, 8, 28), minimum_sample=1)
    assert result["periods"]["fullArchive"]["sampleSize"] == 1
    assert result["method"]["conflictingLotIdsExcluded"] == 1
    assert result["source"]["publicationEligible"] is False


def test_resume_uses_cached_pages_and_does_not_duplicate_lots(tmp_path, monkeypatch) -> None:
    zone = runner.LICITOR_HISTORY_ZONE_URLS[0]
    monkeypatch.setattr(runner, "LICITOR_HISTORY_ZONE_URLS", (zone,))
    state = runner.ArchiveState(tmp_path / "archive")
    state.bind(AUTHORIZATION)

    class FakeHttp:
        count = 0

        def checkpoint(self):
            pass

        def fetch(self, url, kind):
            if (cached := state.cached(url)) is not None:
                return cached
            self.count += 1
            content = LIST_HTML if kind == "index" else DETAIL_HTML
            state.capture(url, kind, content)
            return content

    http = FakeHttp()
    runner.collect(state, http, AUTHORIZATION, max_pages=1)
    runner.collect(state, http, AUTHORIZATION, max_pages=1)
    assert http.count == 2
    assert len(state.records()) == 5
    report = runner.write_report(state, status="paused_at_page_limit", export=True)
    assert report["candidate_lots"] == 5
    assert report["candidate_no_bid"] == 1
    assert report["zones"][0]["pagination_complete"] is False
    assert report["publication_eligible"] is False
    assert len((state.root / "candidates.jsonl").read_text().splitlines()) == 5
    state.db.close()


def test_slug_alias_uses_one_capture_and_enriches_each_lot_from_its_own_city(tmp_path, monkeypatch) -> None:
    zone = runner.LICITOR_HISTORY_ZONE_URLS[0]
    monkeypatch.setattr(runner, "LICITOR_HISTORY_ZONE_URLS", (zone,))
    entry = parse_licitor_history_list_html(LIST_HTML).entries[0]
    alias = entry.source_url.replace("un-appartement/garches/hauts-de-seine", "une-maison/nice/alpes-maritimes")
    second_index = LIST_HTML.replace(entry.source_url.removeprefix("https://www.licitor.com"), alias)
    second_index = second_index.replace("3393", "2").replace("16965", "2").replace("Garches", "Nice")
    second_index = second_index.replace('class="Number">92', 'class="Number">06')
    detail = DETAIL_HTML.replace(
        "</div></article>",
        """<section class="AddressBlock">
        <div class="Lot"><h1>7ème lot de vente</h1><div class="SousLot"><h2>Une maison</h2></div>
        <h3>Adjudication : 200 000 €</h3><h4>(Mise à prix : 100 000 €)</h4></div>
        <div class="Location"><p class="City">Nice (Alpes-Maritimes)</p></div>
        </section></div></article>""",
    )
    state = runner.ArchiveState(tmp_path / "archive")
    state.bind(AUTHORIZATION)
    calls = []

    class FakeHttp:
        count = 0

        def checkpoint(self):
            pass

        def fetch(self, url, kind):
            if (cached := state.cached(url)) is not None:
                return cached
            calls.append(url)
            self.count += 1
            content = (second_index if "?p=2" in url else LIST_HTML) if kind == "index" else detail
            state.capture(url, kind, content)
            return content

    http = FakeHttp()
    runner.collect(state, http, AUTHORIZATION, max_pages=2)
    runner.collect(state, http, AUTHORIZATION, max_pages=2)
    assert http.count == 3
    assert alias not in calls
    rows = state.records()
    assert len(rows) == 6
    assert all(row["department"] == "92" for row in rows[:-1])
    assert rows[-1]["city"] == "Nice"
    assert rows[-1]["department"] == "06"
    assert rows[0]["source_page_url"] == entry.source_url
    assert set(rows[0]["source_alias_urls"]) == {entry.source_url, alias}
    assert len(rows[0]["source_capture_evidence"]) == 1
    report = runner.write_report(state, status=state.get("status"))
    assert report["detail_pages"] == 1
    assert report["detail_urls_resolved"] == 2
    assert report["alias_urls_discovered"] == 1
    assert report["pending_detail_pages"] == 0
    assert report["unresolved_errors"] == []
    state.db.close()


@pytest.mark.parametrize("conflicting", [False, True])
def test_reparse_old_cache_deduplicates_aliases_and_quarantines_conflicting_prices(tmp_path, conflicting) -> None:
    entry = parse_licitor_history_list_html(LIST_HTML).entries[0]
    alias = entry.source_url.replace("un-appartement", "un-parking")
    state = runner.ArchiveState(tmp_path / "archive")
    state.bind(AUTHORIZATION)
    state.set("parser_version", "licitor-history/3")
    state.capture(entry.source_url, "detail", DETAIL_HTML)
    state.capture(alias, "detail", DETAIL_HTML.replace("376 000", "377 000") if conflicting else DETAIL_HTML)
    state.error(alias, "detail", "UNIQUE constraint failed: lots.external_id")
    with state.db:
        for index, value in enumerate((entry, replace(entry, source_url=alias))):
            state.db.execute(
                "insert into index_entries values (?, ?, ?, ?)",
                ("test-index", index, value.source_url, runner.json_text(asdict(value))),
            )
    with pytest.raises(ValueError, match="Parser version changed"):
        state.bind(AUTHORIZATION)
    state.bind(AUTHORIZATION, reparse=True)
    runner.reparse_captures(state, AUTHORIZATION)
    runner.reparse_captures(state, AUTHORIZATION)
    rows = state.records()
    assert len(rows) == 5
    assert rows[0]["adjudication_price_eur"] == "376000.00"
    assert len(rows[0]["source_capture_evidence"]) == 2
    assert state.cached(alias) is not None
    result = build_licitor_price_statistics(rows, as_of=date(2026, 8, 28), minimum_sample=1)
    assert result["periods"]["fullArchive"]["sampleSize"] == (0 if conflicting else 4)
    errors = state.db.execute("select * from errors").fetchall()
    assert len(errors) == (1 if conflicting else 0)
    if conflicting:
        assert errors[0]["kind"] == "detail_alias_conflict"
        assert all("conflicting_announcement_alias_capture" in row["quality_flags"] for row in rows)
    report = runner.write_report(state, status="test")
    assert report["detail_pages"] == 1
    assert report["detail_urls_resolved"] == 2
    state.db.close()


def test_failed_cached_reparse_preserves_old_candidates_but_excludes_them_from_statistics(tmp_path) -> None:
    entry = parse_licitor_history_list_html(LIST_HTML).entries[0]
    state = runner.ArchiveState(tmp_path / "archive")
    state.bind(AUTHORIZATION)
    state.capture(entry.source_url, "detail", DETAIL_HTML)
    runner.reparse_captures(state, AUTHORIZATION)
    state.capture(entry.source_url, "detail", "<article class='LegalAd'>Changed layout</article>")
    runner.reparse_captures(state, AUTHORIZATION)
    rows = state.records()
    assert len(rows) == 5
    assert all("cached_reparse_failed" in row["quality_flags"] for row in rows)
    result = build_licitor_price_statistics(rows, as_of=date(2026, 8, 28), minimum_sample=1)
    assert result["periods"]["fullArchive"]["sampleSize"] == 0
    assert state.db.execute("select count(*) from details").fetchone()[0] == 0
    assert state.db.execute("select kind from errors").fetchone()[0] == "detail_reparse"
    state.db.close()


@pytest.mark.parametrize("mode", ["robots", "rate_limit", "redirect"])
def test_http_stops_on_robots_rate_limit_or_untrusted_redirect(tmp_path, monkeypatch, mode) -> None:
    state = runner.ArchiveState(tmp_path / "archive")
    client_class = httpx.Client
    calls = []

    def handle(request):
        calls.append(str(request.url))
        if request.url.path == "/robots.txt":
            return httpx.Response(
                200, text="User-agent: *\nDisallow: /annonce/" if mode == "robots" else "User-agent: *\nAllow: /"
            )
        if mode == "redirect":
            return httpx.Response(302, headers={"location": "https://example.test/steal"})
        return httpx.Response(429, headers={"retry-after": "60"})

    monkeypatch.setattr(
        runner.httpx, "Client", lambda **kwargs: client_class(transport=httpx.MockTransport(handle), **kwargs)
    )
    monkeypatch.setattr(runner.time, "sleep", lambda _: None)
    http = runner.ArchiveHttp(state, delay=2, max_requests=20, max_seconds=60)
    with pytest.raises(runner.RunPaused):
        http.fetch("https://www.licitor.com/annonce/test/123.html", "detail")
    assert all("example.test" not in url for url in calls)
    assert len(calls) == (1 if mode == "robots" else 2)
    http.client.close()
    state.db.close()
