"""HTTP transport coverage for idempotent queue claims."""

import uuid
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import httpx
import pytest

from src.storage import supabase_client


def _settings():
    return {
        "supabase_url": "https://supabase.test",
        "supabase_service_role_key": "test-only",
    }


def test_claim_http_500_retries_same_request_id_and_honors_retry_after(monkeypatch):
    request_ids: list[str] = []
    sleeps: list[float] = []
    request_id = uuid.UUID("11111111-1111-1111-1111-111111111111")
    responses = iter(
        [
            httpx.Response(
                500,
                headers={"Retry-After": "2"},
                json={"message": "reservation committed before response was lost"},
                request=httpx.Request("POST", "https://supabase.test/rest/v1/rpc/claim"),
            ),
            httpx.Response(
                200,
                json=[{"id": "job-1", "status": "running", "attempt_count": 1}],
                request=httpx.Request("POST", "https://supabase.test/rest/v1/rpc/claim"),
            ),
        ]
    )

    def fake_post(_url, **kwargs):
        request_ids.append(kwargs["json"]["p_request_id"])
        return next(responses)

    monkeypatch.setattr(supabase_client, "load_settings", _settings)
    monkeypatch.setattr(supabase_client.uuid, "uuid4", lambda: request_id)
    monkeypatch.setattr(supabase_client.httpx, "post", fake_post)
    monkeypatch.setattr(supabase_client.time, "sleep", sleeps.append)

    rows = supabase_client.claim_auction_enrichment_jobs_family_from_supabase(
        "source_detail", limit=1
    )

    assert rows == [{"id": "job-1", "status": "running", "attempt_count": 1}]
    assert request_ids == [str(request_id), str(request_id)]
    assert sleeps == [2.0]


def test_claim_timeout_retries_three_times_with_same_id(monkeypatch):
    request_ids: list[str] = []
    sleeps: list[float] = []
    request_id = uuid.UUID("22222222-2222-2222-2222-222222222222")
    calls = 0

    def fake_post(_url, **kwargs):
        nonlocal calls
        calls += 1
        request_ids.append(kwargs["json"]["p_request_id"])
        if calls < 4:
            raise httpx.TimeoutException("temporary timeout")
        return httpx.Response(
            200,
            json=[],
            request=httpx.Request("POST", "https://supabase.test/rest/v1/rpc/claim"),
        )

    monkeypatch.setattr(supabase_client, "load_settings", _settings)
    monkeypatch.setattr(supabase_client.uuid, "uuid4", lambda: request_id)
    monkeypatch.setattr(supabase_client.httpx, "post", fake_post)
    monkeypatch.setattr(supabase_client.time, "sleep", sleeps.append)

    assert supabase_client.claim_auction_enrichment_jobs_family_from_supabase(
        "enrichment", limit=1
    ) == []
    assert request_ids == [str(request_id)] * 4
    assert sleeps == [1.0, 3.0, 5.0]


def test_claim_network_error_retries_same_uuid(monkeypatch):
    request_ids: list[str] = []
    request_id = uuid.UUID("33333333-3333-3333-3333-333333333333")
    calls = 0

    def fake_post(_url, **kwargs):
        nonlocal calls
        calls += 1
        request_ids.append(kwargs["json"]["p_request_id"])
        if calls == 1:
            raise httpx.NetworkError("connection reset")
        return httpx.Response(
            200,
            json=[],
            request=httpx.Request("POST", "https://supabase.test/rest/v1/rpc/claim"),
        )

    monkeypatch.setattr(supabase_client, "load_settings", _settings)
    monkeypatch.setattr(supabase_client.uuid, "uuid4", lambda: request_id)
    monkeypatch.setattr(supabase_client.httpx, "post", fake_post)
    monkeypatch.setattr(supabase_client.time, "sleep", lambda _seconds: None)

    assert supabase_client.claim_auction_enrichment_jobs_family_from_supabase(
        "source_detail", limit=1
    ) == []
    assert request_ids == [str(request_id), str(request_id)]


@pytest.mark.parametrize(
    "retry_after",
    [
        "120",
        format_datetime(datetime.now(UTC) + timedelta(hours=1), usegmt=True),
    ],
)
def test_long_retry_after_defers_without_shortening_or_sleeping(monkeypatch, retry_after):
    request_id = uuid.UUID("44444444-4444-4444-4444-444444444444")
    calls = 0
    persisted: list[datetime] = []

    def fake_post(_url, **_kwargs):
        nonlocal calls
        calls += 1
        return httpx.Response(
            429,
            headers={"Retry-After": retry_after},
            json={"code": "rate_limited", "message": "retry later"},
            request=httpx.Request("POST", "https://supabase.test/rest/v1/rpc/claim"),
        )

    monkeypatch.setattr(supabase_client, "load_settings", _settings)
    monkeypatch.setattr(supabase_client.uuid, "uuid4", lambda: request_id)
    monkeypatch.setattr(supabase_client.httpx, "post", fake_post)
    monkeypatch.setattr(
        supabase_client,
        "_persist_queue_claim_backoff",
        lambda _settings, retry_not_before: persisted.append(retry_not_before)
        or retry_not_before,
    )
    monkeypatch.setattr(supabase_client.time, "sleep", lambda _seconds: pytest.fail("must defer"))

    with pytest.raises(supabase_client.QueueClaimDeferred) as deferred:
        supabase_client.claim_auction_enrichment_jobs_family_from_supabase(
            "source_detail", limit=1
        )
    assert calls == 1
    assert len(persisted) == 1
    assert deferred.value.request_id == str(request_id)
    assert deferred.value.retry_not_before > datetime.now(UTC) + timedelta(seconds=50)


def test_retry_after_parser_rejects_non_finite_values():
    assert supabase_client._claim_retry_after_seconds("nan") is None
    assert supabase_client._claim_retry_after_seconds("inf") is None
    assert supabase_client._claim_retry_after_seconds("-10") == 0.0


def test_claim_validation_error_is_not_retried(monkeypatch):
    calls = 0

    def fake_post(_url, **_kwargs):
        nonlocal calls
        calls += 1
        return httpx.Response(
            400,
            json={"message": "Invalid queue claim request arguments"},
            request=httpx.Request("POST", "https://supabase.test/rest/v1/rpc/claim"),
        )

    monkeypatch.setattr(supabase_client, "load_settings", _settings)
    monkeypatch.setattr(supabase_client.httpx, "post", fake_post)
    monkeypatch.setattr(supabase_client.time, "sleep", lambda _: pytest.fail("must not retry"))

    with pytest.raises(httpx.HTTPStatusError):
        supabase_client.claim_auction_enrichment_jobs_family_from_supabase(
            "source_detail", limit=1
        )
    assert calls == 1
