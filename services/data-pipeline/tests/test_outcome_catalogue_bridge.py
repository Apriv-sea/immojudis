from __future__ import annotations

import httpx
import pytest

from src.outcome_ingestion.catalogue_bridge import (
    BRIDGE_RPC_NAME,
    COURT_RECONCILIATION_RPC_NAME,
    OutcomeCatalogueBridgeError,
    bridge_auction_sales_before_cleanup,
)


def _response(payload: object, *, status_code: int = 200) -> httpx.Response:
    if isinstance(payload, list):
        for row in payload:
            if isinstance(row, dict) and "created_count" in row:
                row.setdefault("next_cursor", "00000000-0000-0000-0000-000000000013")
                row.setdefault("has_more", False)
    return httpx.Response(
        status_code,
        json=payload,
        request=httpx.Request("POST", "https://example.supabase.co/rest/v1/rpc/bridge"),
    )


def _settings() -> dict[str, object]:
    return {
        "supabase_url": "https://example.supabase.co/",
        "supabase_service_role_key": "service-role-secret",
    }


def _reconciliation_payload(count: int | str = 13) -> list[dict[str, object]]:
    return [
        {
            "scanned_count": count,
            "corrected_count": 0,
            "already_correct_count": count,
            "blocked_count": 0,
            "complete": True,
            "next_cursor": "00000000-0000-0000-0000-000000000013",
            "has_more": False,
        }
    ]


def test_bridge_calls_the_service_role_rpc_without_serializing_sale_money() -> None:
    calls: list[dict[str, object]] = []

    def post(url: str, **kwargs: object) -> httpx.Response:
        calls.append({"url": url, **kwargs})
        if url.endswith(f"/{COURT_RECONCILIATION_RPC_NAME}"):
            return _response(_reconciliation_payload())
        return _response(
            [
                {
                    "scanned_count": 13,
                    "created_count": 13,
                    "reused_count": 0,
                    "linked_count": 13,
                    "complete": True,
                }
            ]
        )

    result = bridge_auction_sales_before_cleanup(_settings(), post=post)

    assert result.scanned_count == 13
    assert result.remaining_unlinked == 0
    assert len(calls) == 2
    assert calls[0]["url"] == (f"https://example.supabase.co/rest/v1/rpc/{BRIDGE_RPC_NAME}")
    assert calls[0]["json"] == {"p_after_id": None, "p_limit": 25}
    assert calls[1]["url"] == (f"https://example.supabase.co/rest/v1/rpc/{COURT_RECONCILIATION_RPC_NAME}")
    headers = calls[0]["headers"]
    assert isinstance(headers, dict)
    assert headers["apikey"] == "service-role-secret"
    assert headers["Authorization"] == "Bearer service-role-secret"


def test_bridge_accepts_an_idempotent_replay() -> None:
    def post(url: str, **_kwargs: object) -> httpx.Response:
        if url.endswith(f"/{COURT_RECONCILIATION_RPC_NAME}"):
            return _response(_reconciliation_payload("13"))
        return _response(
            [
                {
                    "scanned_count": "13",
                    "created_count": "0",
                    "reused_count": "13",
                    "linked_count": "13",
                    "complete": True,
                }
            ]
        )

    result = bridge_auction_sales_before_cleanup(
        _settings(),
        post=post,
    )

    assert result.created_count == 0
    assert result.reused_count == 13


def test_bridge_blocks_cleanup_when_court_reconciliation_is_incomplete() -> None:
    def post(url: str, **_kwargs: object) -> httpx.Response:
        if url.endswith(f"/{COURT_RECONCILIATION_RPC_NAME}"):
            return _response(
                [
                    {
                        "scanned_count": 2,
                        "corrected_count": 1,
                        "already_correct_count": 0,
                        "blocked_count": 1,
                        "complete": False,
                    }
                ]
            )
        return _response(
            [
                {
                    "scanned_count": 2,
                    "created_count": 2,
                    "reused_count": 0,
                    "linked_count": 2,
                    "complete": True,
                }
            ]
        )

    with pytest.raises(OutcomeCatalogueBridgeError, match="reconciliation is incomplete"):
        bridge_auction_sales_before_cleanup(_settings(), post=post)


@pytest.mark.parametrize(
    "payload",
    [
        [],
        [{"scanned_count": 1}],
        [
            {
                "scanned_count": 2,
                "created_count": 1,
                "reused_count": 0,
                "linked_count": 1,
                "complete": False,
            }
        ],
        [
            {
                "scanned_count": 2,
                "created_count": 2,
                "reused_count": 1,
                "linked_count": 2,
                "complete": True,
            }
        ],
    ],
)
def test_bridge_fails_closed_on_incomplete_or_incoherent_results(payload: object) -> None:
    with pytest.raises(OutcomeCatalogueBridgeError, match="cleanup is disabled|field|shape|counters"):
        bridge_auction_sales_before_cleanup(
            _settings(),
            post=lambda *_args, **_kwargs: _response(payload),
        )


def test_bridge_fails_closed_without_service_credentials() -> None:
    called = False

    def post(*_args: object, **_kwargs: object) -> httpx.Response:
        nonlocal called
        called = True
        return _response([])

    with pytest.raises(OutcomeCatalogueBridgeError, match="supabase_service_role_key"):
        bridge_auction_sales_before_cleanup(
            {"supabase_url": "https://example.supabase.co"},
            post=post,
        )

    assert called is False


def test_bridge_fails_closed_on_http_error_without_echoing_response_body() -> None:
    with pytest.raises(OutcomeCatalogueBridgeError, match="HTTP 503") as error:
        bridge_auction_sales_before_cleanup(
            _settings(),
            post=lambda *_args, **_kwargs: _response(
                {"message": "database details must stay private"},
                status_code=503,
            ),
        )

    assert "database details" not in str(error.value)


@pytest.mark.parametrize("repeat_cursor", [False, True])
def test_reconciliation_pages_and_rejects_repeated_cursor(repeat_cursor):
    calls = []

    def post(url, **kwargs):
        if url.endswith(f"/{BRIDGE_RPC_NAME}"):
            first_bridge = kwargs["json"]["p_after_id"] is None
            count = 25 if first_bridge else 1
            return _response([dict(scanned_count=count, created_count=0, reused_count=count, linked_count=count,
                                   complete=True, has_more=first_bridge,
                                   next_cursor="00000000-0000-0000-0000-000000000001" if first_bridge else
                                               "00000000-0000-0000-0000-000000000002")])
        calls.append(kwargs["json"])
        first = len(calls) == 1
        cursor = (
            "00000000-0000-0000-0000-000000000001" if first or repeat_cursor else "00000000-0000-0000-0000-000000000002"
        )
        return _response(
            [
                dict(
                    scanned_count=25 if first else 1,
                    corrected_count=0,
                    already_correct_count=25 if first else 1,
                    blocked_count=0,
                    complete=True,
                    next_cursor=cursor,
                    has_more=first,
                )
            ]
        )

    if repeat_cursor:
        with pytest.raises(OutcomeCatalogueBridgeError, match="cursor"):
            bridge_auction_sales_before_cleanup(_settings(), post=post)
    else:
        assert bridge_auction_sales_before_cleanup(_settings(), post=post).scanned_count == 26
    assert calls == [
        dict(p_after_id=None, p_limit=25),
        dict(p_after_id="00000000-0000-0000-0000-000000000001", p_limit=25),
    ]


@pytest.mark.parametrize("count,more,cursor", [
    (0, True, None), (26, False, "00000000-0000-0000-0000-000000000001"),
    (1, True, "not-a-uuid"),
])
def test_bridge_rejects_invalid_page_bounds(count, more, cursor):
    with pytest.raises(OutcomeCatalogueBridgeError):
        bridge_auction_sales_before_cleanup(_settings(), post=lambda *a, **k: _response([dict(
            scanned_count=count, created_count=count, reused_count=0, linked_count=count,
            complete=True, has_more=more, next_cursor=cursor)]))


def test_bridge_repeated_cursor_cannot_trigger_cleanup():
    with pytest.raises(OutcomeCatalogueBridgeError, match="cursor"):
        bridge_auction_sales_before_cleanup(_settings(), post=lambda *a, **k: _response([dict(
            scanned_count=1, created_count=0, reused_count=1, linked_count=1, complete=True,
            has_more=True, next_cursor="00000000-0000-0000-0000-000000000001")]))
