from src.normalize import normalize_sale
from src.storage import supabase_client


def _sale(source_url: str, observations: list[dict[str, object]]):
    return normalize_sale(
        {
            "source_name": "licitor",
            "source_url": source_url,
            "starting_price_eur": 100000,
            "observations": observations,
        }
    )


def test_observation_batch_deduplicates_urls_and_keeps_admissible_rows(monkeypatch) -> None:
    calls: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://example",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgres_upsert",
        lambda _db_url, _table, payload, on_conflict: calls.append(payload),
    )

    sale = _sale(
        "https://sale.test/canonical",
        [
            {
                "source_url": "https://source.test/b",
                "raw_payload": {"version": "new"},
                "observed_at": "2026-09-13T12:00:00Z",
            },
            {"source_url": "https://source.test/a", "raw_payload": {"version": "one"}},
            {"source_url": "https://source.test/b", "raw_payload": {"version": "old"}},
            {"source_url": ""},
        ],
    )
    sale.observations.extend([None, "invalid"])

    result = supabase_client.upsert_observations_to_supabase([sale])

    assert result == 2
    assert len(calls) == 1
    payload = calls[0]
    assert [row["source_url"] for row in payload] == [
        "https://source.test/a",
        "https://source.test/b",
    ]
    selected = payload[1]
    assert selected["raw_payload"] == {"version": "new"}
    assert selected["observed_at"] == "2026-09-13T12:00:00+00:00"


def test_observation_batch_does_not_regress_when_stale_retry_follows_newer_version(monkeypatch) -> None:
    captured: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, on_conflict: captured.append(payload),
    )

    newer = _sale(
        "https://sale.test/new",
        [
            {
                "source_url": "https://source.test/retry",
                "external_id": "current",
                "raw_payload": {"version": 2, "title": "current"},
                "observed_at": "2026-09-13T12:00:00Z",
            }
        ],
    )
    stale_retry = _sale(
        "https://sale.test/old",
        [
            {
                "source_url": "https://source.test/retry",
                "external_id": "stale",
                "raw_payload": {"version": 1, "title": "stale"},
                "observed_at": "2026-09-13T11:00:00Z",
            }
        ],
    )

    assert supabase_client.upsert_observations_to_supabase([newer, stale_retry]) == 1

    row = captured[0][0]
    assert row["external_id"] == "current"
    assert row["raw_payload"] == {"version": 2, "title": "current"}
    assert row["observed_at"] == "2026-09-13T12:00:00+00:00"


def test_observation_batch_rest_fallback_receives_deduplicated_payload(monkeypatch) -> None:
    postgres_calls: list[list[dict[str, object]]] = []
    rest_calls: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://example",
        },
    )

    def fail_postgres(_db_url, _table, payload, on_conflict):
        postgres_calls.append(payload)
        raise RuntimeError("test direct-write failure")

    monkeypatch.setattr(supabase_client, "_postgres_upsert", fail_postgres)
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, on_conflict: rest_calls.append(payload),
    )

    sale = _sale(
        "https://sale.test/fallback",
        [
            {
                "source_url": "https://source.test/duplicate",
                "raw_payload": {"version": "new"},
                "observed_at": "2026-09-13T12:00:00Z",
            },
            {
                "source_url": "https://source.test/duplicate",
                "raw_payload": {"version": "old"},
                "observed_at": "2026-09-13T11:00:00Z",
            },
        ],
    )

    assert supabase_client.upsert_observations_to_supabase([sale]) == 1
    assert len(postgres_calls) == 1
    assert len(rest_calls) == 1
    assert len(rest_calls[0]) == 1
    assert rest_calls[0][0]["raw_payload"] == {"version": "new"}
