from datetime import UTC, datetime
from unittest.mock import Mock

import httpx
import pytest

from src.sources.common import PoliteHttpClient, retry_after_seconds


def client_with(responses):
    client = object.__new__(PoliteHttpClient)
    client.delay_seconds = 0
    client._client = Mock()
    client._client.request.side_effect = responses
    client._retry_not_before = None
    client._access_denials = 0
    return client


def response(status, **headers):
    return httpx.Response(status, headers=headers, request=httpx.Request('GET', 'https://example.test'))


def test_three_spaced_retries_then_success(monkeypatch):
    sleeps = []
    monkeypatch.setattr('src.sources.common.time.sleep', sleeps.append)
    client = client_with([response(503), httpx.ReadTimeout('interrupted'), response(429, **{'Retry-After': '9'}), response(200)])
    assert client._request_with_retries('GET', 'https://example.test').status_code == 200
    assert client._client.request.call_count == 4
    assert sleeps == [1, 2, 9]


def test_http_date_is_respected():
    assert retry_after_seconds('Sat, 12 Sep 2026 12:00:30 GMT', now=datetime(2026, 9, 12, 12, tzinfo=UTC)) == 30
    for invalid in ('nan', 'inf', 'invalid', '-10'):
        assert retry_after_seconds(invalid) == 0


def test_long_retry_after_defers_without_sleeping(monkeypatch):
    monkeypatch.setattr('src.sources.common.time.sleep', lambda _: pytest.fail('must defer'))
    client = client_with([response(429, **{'Retry-After': '7200'})])
    assert client._request_with_retries('GET', 'https://example.test').status_code == 429
    assert client._retry_not_before
    with pytest.raises(RuntimeError, match='deferred'):
        client._request('GET', 'https://example.test/another')
    assert client._client.request.call_count == 1


def test_persistent_access_refusals_open_circuit():
    client = client_with([response(403), response(403)])
    for _ in range(2):
        assert client._request_with_retries('GET', 'https://example.test').status_code == 403
    with pytest.raises(RuntimeError, match='suspended'):
        client._request('GET', 'https://example.test/third')
    assert client._client.request.call_count == 2
