from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import httpx
import pytest

import src.sources.licitor_cloud as cloud


@pytest.mark.parametrize("today,expected", [
    (date(2026, 9, 7), date(2023, 9, 7)),
    (date(2024, 2, 29), date(2021, 2, 28)),
    (date(2027, 3, 1), date(2024, 3, 1)),
])
def test_three_calendar_years_including_leap_day(today, expected):
    assert cloud.licitor_window_start(today) == expected


@pytest.mark.parametrize(
    "secret,header,expected",
    [
        (None, None, False),
        (None, "Bearer x", False),
        ("test", None, False),
        ("test", "Bearer wrong", False),
        ("test", "Bearer test", True),
        ("test", "Bearer é", False),
    ],
)
def test_cron_secret_is_required_and_compared_exactly(monkeypatch, secret, header, expected):
    monkeypatch.delenv("CRON_SECRET", raising=False)
    if secret:
        monkeypatch.setenv("CRON_SECRET", secret)
    assert cloud.request_authorized(header) is expected


@pytest.mark.parametrize("mode", ["rate_limit", "robots", "redirect"])
def test_source_network_refusals_stop_without_bypass(monkeypatch, mode):
    seen = []

    class Store:
        def request_started(self, _run):
            pass

    client_class = httpx.Client

    def handle(request):
        seen.append(str(request.url))
        if mode == "redirect":
            return httpx.Response(302, headers={"location": "https://example.invalid/not-licitor"})
        return httpx.Response(429)

    monkeypatch.setattr(cloud.httpx, "Client", lambda **kw: client_class(transport=httpx.MockTransport(handle), **kw))
    monkeypatch.setattr(cloud.time, "sleep", lambda _: None)
    http = cloud.SourceHttp(Store(), "test")
    if mode == "robots":
        http.rules = cloud.RobotsRules.parse("User-agent: *\nDisallow: /annonce/", cloud.USER_AGENT)
    with pytest.raises(cloud.RunPaused):
        http.fetch("https://www.licitor.com/annonce/test/123.html", "detail")
    assert all("example.invalid" not in url for url in seen)
    assert len(seen) == (0 if mode == "robots" else 1)
    http.client.close()


def test_unauthorized_handler_does_not_open_a_database(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "test")
    monkeypatch.setattr(cloud, "connect_store", lambda: pytest.fail("No DB access before authorization"))
    responses = []
    handler = object.__new__(cloud.CollectorHandler)
    handler.headers = {}
    handler.respond = lambda status, body: responses.append((status, body))
    handler.do_GET()
    assert responses[0][0] == 401


def test_preview_cannot_start_production_collection(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "test")
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setattr(cloud, "connect_store", lambda: pytest.fail("Preview must not open production DB"))
    handler = object.__new__(cloud.CollectorHandler)
    handler.headers = {"Authorization": "Bearer test"}
    responses = []
    handler.respond = lambda status, body: responses.append((status, body))
    handler.do_GET()
    assert responses[0][0] == 409


def test_database_errors_are_not_returned_to_the_caller(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "test")
    monkeypatch.setenv("VERCEL_ENV", "production")

    def fail():
        raise ValueError("postgres://secret-user:secret-password@db.invalid")

    monkeypatch.setattr(cloud, "connect_store", fail)
    handler = object.__new__(cloud.CollectorHandler)
    handler.headers = {"Authorization": "Bearer test"}
    responses = []
    handler.respond = lambda status, body: responses.append((status, body))
    handler.do_GET()
    assert responses == [(500, {"ok": False, "error": "Collector execution failed"})]


def test_batch_duration_is_bounded(monkeypatch):
    http = cloud.SourceHttp(SimpleNamespace(), "test", max_seconds=999999, max_requests=999999)
    assert http.max_seconds == 240
    assert http.max_requests == 100
    http.started -= 206
    with pytest.raises(cloud.BatchYield):
        http.checkpoint()
    http.client.close()
