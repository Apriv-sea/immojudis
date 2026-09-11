from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest

from src.court_competence import CompetentCourtAssignment
from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION
from src.normalize import normalize_sale
from src.storage import supabase_client
from src.storage.supabase_client import _sanitize_postgrest_payload, _secondary_source_urls


@pytest.fixture(autouse=True)
def isolate_enrichment_queue(monkeypatch):
    monkeypatch.setattr(supabase_client, "_enqueue_due_enrichment", lambda *args: None)


def test_postgrest_upsert_batch_retries_cloudflare_520(monkeypatch) -> None:
    responses = iter(
        [
            httpx.Response(520, request=httpx.Request("POST", "https://supabase.test/rest/v1/properties")),
            httpx.Response(201, request=httpx.Request("POST", "https://supabase.test/rest/v1/properties")),
        ]
    )
    attempts: list[int] = []

    def fake_post(*args, **kwargs):
        attempts.append(1)
        return next(responses)

    monkeypatch.setattr(supabase_client.httpx, "post", fake_post)
    monkeypatch.setattr(supabase_client.time, "sleep", lambda _seconds: None)

    response = supabase_client._postgrest_upsert_batch(
        "https://supabase.test/rest/v1/properties",
        "secret",
        "properties",
        [{"source_url": "https://example.test/sale"}],
        "source_url",
    )

    assert response.status_code == 201
    assert len(attempts) == 2


def test_sanitize_postgrest_payload_removes_null_characters_recursively() -> None:
    payload = {
        "result": [
            {
                "text": "surface\x00 habitable",
                "pages": [{"text": "page\x00 1"}, {"confidence": 0.7}],
            }
        ],
        "untouched": None,
        "decimal_values": [Decimal("187"), Decimal("39.67")],
    }

    assert _sanitize_postgrest_payload(payload) == {
        "result": [
            {
                "text": "surface habitable",
                "pages": [{"text": "page 1"}, {"confidence": 0.7}],
            }
        ],
        "untouched": None,
        "decimal_values": [187, 39.67],
    }


def test_secondary_source_urls_excludes_batch_primary_urls() -> None:
    first = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://vench.test/rich",
        }
    )
    first.source_urls.append("https://avoventes.test/poor")
    second = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://licitor.test/keep",
            "source_urls": ["https://licitor.test/keep"],
        }
    )

    assert _secondary_source_urls([first, second]) == ["https://avoventes.test/poor"]


def test_known_signatures_only_include_scored_rows(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "fetch_known_sale_details",
        lambda: {
            "https://example.test/scored": {
                "_signature": "2027-01-10|100000",
                "score_version": "v1",
            },
            "https://example.test/unscored": {
                "_signature": "2027-01-11|200000",
                "score_version": None,
            },
        },
    )

    assert supabase_client.fetch_known_sale_signatures() == {
        "https://example.test/scored": "2027-01-10|100000"
    }


def test_fetch_known_sale_details_uses_bounded_pages(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    calls: list[tuple[str, str]] = []

    class Response:
        is_error = False
        status_code = 200
        text = ""

        def __init__(self, rows):
            self._rows = rows

        def json(self):
            return self._rows

    first_page = [
        {"source_url": f"https://example.test/{index}", "source_urls": []}
        for index in range(supabase_client.KNOWN_SALE_DETAIL_PAGE_SIZE)
    ]

    def fake_get(endpoint, params, headers, timeout):
        calls.append((params["limit"], params["offset"]))
        return Response(first_page if params["offset"] == "0" else [])

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    details = supabase_client.fetch_known_sale_details()

    assert len(details) == supabase_client.KNOWN_SALE_DETAIL_PAGE_SIZE
    assert calls == [("100", "0"), ("100", "100")]


def test_fetch_known_sale_details_raises_instead_of_returning_partial_data(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = True
        status_code = 500
        text = "canceling statement due to statement timeout"

    monkeypatch.setattr(supabase_client.httpx, "get", lambda *args, **kwargs: Response())

    with pytest.raises(RuntimeError, match="statement timeout"):
        supabase_client.fetch_known_sale_details()


def test_enriched_hashes_require_current_llm_description_when_requested(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False

        def json(self):
            return [
                {
                    "content_hash": "hash-current",
                    "raw_payload": {
                        "llm_display_description": "Synthèse IA prête.",
                        "llm_display_quality_version": DISPLAY_QUALITY_VERSION,
                        "llm_display_status": "accepted",
                        "llm_prompt_version": "auction_llm_v5",
                    },
                },
                {
                    "content_hash": "hash-missing",
                    "raw_payload": {
                        "source_description": "Description brute.",
                    },
                },
                {
                    "content_hash": "hash-stale",
                    "raw_payload": {
                        "llm_display_description": "Ancienne synthèse.",
                        "llm_prompt_version": "auction_llm_v4",
                    },
                },
            ]

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/auction_sales"
        assert params["select"] == "content_hash,raw_payload"
        assert params["score_version"] == "not.is.null"
        return Response()

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    assert supabase_client.fetch_enriched_content_hashes(
        ["hash-current", "hash-missing", "hash-stale"],
        require_llm_description=True,
        prompt_version="auction_llm_v5",
    ) == {"hash-current"}


def test_enriched_hashes_keep_legacy_score_only_mode(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False

        def json(self):
            return [
                {"content_hash": "hash-current", "raw_payload": {}},
                {"content_hash": "hash-missing", "raw_payload": {}},
            ]

    monkeypatch.setattr(supabase_client.httpx, "get", lambda *args, **kwargs: Response())

    assert supabase_client.fetch_enriched_content_hashes(
        ["hash-current", "hash-missing"],
        require_llm_description=False,
    ) == {"hash-current", "hash-missing"}


def test_enriched_hashes_require_successful_document_analysis_when_requested(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False

        def json(self):
            return [
                {
                    "content_hash": "hash-extracted",
                    "raw_payload": {
                        "document_analysis": {
                            "coverage_status": "partial",
                            "documents_listed": 3,
                            "documents_extracted": 1,
                        }
                    },
                },
                {
                    "content_hash": "hash-source-only",
                    "raw_payload": {
                        "document_analysis": {
                            "coverage_status": "source_only",
                            "documents_listed": 0,
                            "documents_extracted": 0,
                        }
                    },
                },
                {
                    "content_hash": "hash-not-extracted",
                    "raw_payload": {
                        "document_analysis": {
                            "coverage_status": "documents_not_extracted",
                            "documents_listed": 3,
                            "documents_extracted": 0,
                        }
                    },
                },
                {"content_hash": "hash-never-analyzed", "raw_payload": {}},
            ]

    monkeypatch.setattr(supabase_client.httpx, "get", lambda *args, **kwargs: Response())

    assert supabase_client.fetch_enriched_content_hashes(
        ["hash-extracted", "hash-source-only", "hash-not-extracted", "hash-never-analyzed"],
        require_document_analysis=True,
    ) == {"hash-extracted", "hash-source-only"}


def test_fetch_sales_needing_llm_descriptions_filters_current_rows(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    captured: dict[str, object] = {}

    class Response:
        is_error = False

        def json(self):
            return [
                {
                    "source_name": "avoventes",
                    "source_url": "https://example.test/current",
                    "status": "upcoming",
                    "raw_payload": {
                        "llm_display_description": "Synthèse courante.",
                        "llm_display_quality_version": DISPLAY_QUALITY_VERSION,
                        "llm_display_status": "accepted",
                        "llm_prompt_version": "auction_llm_v6_display",
                    },
                },
                {
                    "source_name": "notaires",
                    "source_url": "https://example.test/missing",
                    "status": "upcoming",
                    "title": "Maison 85 m²",
                    "raw_payload": {"source_blocks": {"description": "Maison avec jardin."}},
                },
                {
                    "source_name": "encheres_publiques",
                    "source_url": "https://example.test/stale",
                    "status": "active",
                    "title": "Appartement",
                    "raw_payload": {
                        "llm_display_description": "Ancienne synthèse.",
                        "llm_prompt_version": "auction_llm_v5",
                    },
                },
                {
                    "source_name": "notaires",
                    "source_url": "https://example.test/recent-failure",
                    "status": "upcoming",
                    "title": "Maison en échec récent",
                    "raw_payload": {
                        "source_blocks": {"description": "Maison."},
                        "llm_display_error_at": datetime.now(UTC).isoformat(),
                        "llm_display_error_prompt_version": "auction_llm_v6_display",
                    },
                },
                {
                    "source_name": "notaires",
                    "source_url": "https://example.test/old-failure",
                    "status": "upcoming",
                    "title": "Maison en ancien échec",
                    "raw_payload": {
                        "source_blocks": {"description": "Maison."},
                        "llm_display_error_at": (datetime.now(UTC) - timedelta(hours=25)).isoformat(),
                        "llm_display_error_prompt_version": "auction_llm_v6_display",
                    },
                },
            ]

    def fake_get(endpoint, params, headers, timeout):
        captured["endpoint"] = endpoint
        captured["params"] = params
        return Response()

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    sales = supabase_client.fetch_sales_needing_llm_descriptions(
        limit=10,
        prompt_version="auction_llm_v6_display",
        statuses=("active", "upcoming"),
    )

    assert captured["endpoint"] == "https://supabase.test/rest/v1/auction_sales"
    assert captured["params"]["status"] == 'in.("active","upcoming")'
    assert [sale.source_url for sale in sales] == [
        "https://example.test/missing",
        "https://example.test/stale",
        "https://example.test/old-failure",
    ]


def test_delete_vench_sales_without_surface_removes_observations_then_sales(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        def __init__(self, rows):
            self._rows = rows

        is_error = False

        def json(self):
            return self._rows

    responses = [
        [{"source_url": "https://vench.test/no-surface"}],
        [],
    ]

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/auction_sales"
        assert params["source_name"] == "eq.vench"
        assert params["surface_m2"] == "is.null"
        assert params["habitable_surface_m2"] == "is.null"
        assert params["carrez_surface_m2"] == "is.null"
        assert params["app_surface_m2"] == "is.null"
        assert params["land_surface_m2"] == "is.null"
        return Response(responses.pop(0))

    calls = []
    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete",
        lambda supabase_url, api_key, table, params: calls.append(table),
    )

    assert supabase_client.delete_vench_sales_without_surface_in_supabase() == 1
    assert calls == ["auction_observations", "auction_sales"]


def test_delete_vench_sales_without_surface_is_best_effort_on_lookup_error(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = True
        status_code = 522
        text = "connection timed out"

    monkeypatch.setattr(supabase_client.httpx, "get", lambda *args, **kwargs: Response())

    assert supabase_client.delete_vench_sales_without_surface_in_supabase() == 0


def test_delete_expired_sales_uses_atomic_retention_rpc(monkeypatch):
    monkeypatch.setattr(supabase_client, "load_settings", lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "test"})
    calls = []
    results = [{"deleted": 25, "remaining": 1, "busy": False}, {"deleted": 1, "remaining": 0, "busy": False}]
    def post(url, **kwargs):
        calls.append((url, kwargs["json"]))
        return httpx.Response(200, json=results.pop(0), request=httpx.Request("POST", url))
    monkeypatch.setattr(supabase_client.httpx, "post", post)
    assert supabase_client.delete_expired_sales_in_supabase(datetime(2026, 7, 9, 12, tzinfo=UTC)) == 26
    assert len(calls) == 2
    assert calls[0] == ("https://supabase.test/rest/v1/rpc/purge_expired_auction_sales", {"p_now": "2026-07-09T12:00:00+00:00", "p_limit": 25})


def test_delete_expired_sales_stops_on_busy(monkeypatch):
    monkeypatch.setattr(supabase_client, "load_settings", lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "test"})
    calls = []
    def post(url, **kwargs):
        calls.append(url)
        return httpx.Response(200, json={"deleted": 0, "remaining": None, "busy": True}, request=httpx.Request("POST", url))
    monkeypatch.setattr(supabase_client.httpx, "post", post)
    assert supabase_client.delete_expired_sales_in_supabase() == 0
    assert len(calls) == 1


def test_upsert_sales_prefers_direct_postgres_when_db_url_is_configured(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes", "starting_price_eur": 10000,
            "source_url": "https://example.test/sale",
            "source_urls": ["https://example.test/sale"],
            "raw_payload": {"text": "hello\x00"},
        }
    )
    calls: list[tuple[str, str, int]] = []

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
        lambda db_url, table, payload, on_conflict: calls.append((db_url, table, len(payload))),
    )
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows_with_postgres",
        lambda *args: (_ for _ in ()).throw(
            AssertionError("upsert must not delete secondary rows before the Outcome Graph bridge")
        ),
    )
    monkeypatch.setattr(
        supabase_client,
        "_sync_normalized_sale_tables_with_rest",
        lambda supabase_url, api_key, sales, now, **kwargs: calls.append(
            (supabase_url, "normalized_tables", len(sales))
        ),
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_with_rest",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("REST upsert should not run")),
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_asset_tables_with_rest",
        lambda supabase_url, api_key, sales, now: calls.append((supabase_url, "asset_tables", len(sales))),
    )

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda _: nullcontext(SimpleNamespace(execute=lambda *args: None)))
    monkeypatch.setattr(supabase_client, "_transaction_write", lambda table, payload, conflict: calls.append(("postgresql://example", table, len(payload))))
    assert supabase_client.upsert_sales_to_supabase([sale]) == 1
    assert calls == [
        ("postgresql://example", "auction_sales", 1),
        ("https://supabase.test", "normalized_tables", 1),
        ("https://supabase.test", "asset_tables", 1),
    ]


def test_upsert_sales_via_rest_does_not_delete_secondary_rows(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes", "starting_price_eur": 10000,
            "source_url": "https://example.test/primary",
            "source_urls": [
                "https://example.test/primary",
                "https://example.test/secondary",
            ],
        }
    )
    calls: list[str] = []

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
        "_upsert_with_rest",
        lambda *args, **kwargs: calls.append("upsert"),
    )
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows",
        lambda *args: (_ for _ in ()).throw(
            AssertionError("upsert must not delete secondary rows before the Outcome Graph bridge")
        ),
    )
    monkeypatch.setattr(
        supabase_client,
        "_sync_normalized_sale_tables_with_rest",
        lambda *args, **kwargs: calls.append("normalized"),
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_asset_tables_with_rest",
        lambda *args, **kwargs: calls.append("assets"),
    )

    assert supabase_client.upsert_sales_to_supabase([sale]) == 1
    assert calls == ["upsert", "normalized", "assets"]


def test_upsert_sales_registers_verified_competent_court_before_sale(monkeypatch) -> None:
    assignment = CompetentCourtAssignment(
        insee_code="01187",
        commune_name="HAUT VALROMEY",
        court_code="justice_tj_1_39",
        court_name="TJ Bourg-en-Bresse",
        official_court_name="Tribunal judiciaire de Bourg-en-Bresse",
        court_origin_code="1",
        court_srj_code="39",
        court_department="01",
        court_city="Bourg-en-Bresse",
        reference_sha256="c" * 64,
    )
    sale = normalize_sale(
        {
            "source_name": "avoventes", "starting_price_eur": 10000,
            "source_url": "https://example.test/haut-valromey",
            "tribunal": assignment.court_name,
            "tribunal_code": assignment.court_code,
            "raw_payload": {"tribunal_assignment": assignment.evidence()},
        }
    )
    sale.raw_payload["tribunal_assignment"] = assignment.evidence()
    calls: list[tuple[str, object]] = []
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
        lambda _url, _key, table, payload, on_conflict: calls.append((table, (payload, on_conflict))),
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_with_rest",
        lambda *_args, **_kwargs: calls.append(("auction_sales", None)),
    )
    monkeypatch.setattr(
        supabase_client,
        "_sync_normalized_sale_tables_with_rest",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_asset_tables_with_rest",
        lambda *args, **kwargs: None,
    )

    assert supabase_client.upsert_sales_to_supabase([sale]) == 1

    assert calls[0][0] == "tribunals"
    tribunal_payload, on_conflict = calls[0][1]
    assert on_conflict == "code"
    assert tribunal_payload[0]["code"] == "justice_tj_1_39"
    assert calls[1] == ("auction_sales", None)


def test_secondary_sale_cleanup_is_explicit_and_uses_postgres(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/primary",
            "source_urls": [
                "https://example.test/primary",
                "https://example.test/secondary",
            ],
        }
    )
    calls: list[str] = []

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
        "_delete_secondary_sale_rows_with_postgres",
        lambda db_url, sales: calls.append("delete_secondary") or 1,
    )
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows",
        lambda *args: (_ for _ in ()).throw(AssertionError("REST fallback should not run")),
    )

    assert supabase_client.delete_secondary_sales_in_supabase([sale]) == 1
    assert calls == ["delete_secondary"]


def test_upsert_sales_can_preserve_last_seen_during_recompute(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor", "starting_price_eur": 10000,
            "source_url": "https://example.test/licitor-sale",
        }
    )
    sale.last_seen_at = datetime(2026, 7, 1, 9, 30, tzinfo=UTC)
    captured: dict[str, object] = {}

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
        lambda db_url, table, payload, on_conflict: captured.setdefault("payload", payload),
    )
    monkeypatch.setattr(supabase_client, "_delete_secondary_sale_rows_with_postgres", lambda *args: 0)
    monkeypatch.setattr(
        supabase_client,
        "_sync_normalized_sale_tables_with_rest",
        lambda supabase_url, api_key, sales, now, **kwargs: captured.setdefault(
            "refresh_last_seen", kwargs.get("refresh_last_seen")
        ),
    )
    monkeypatch.setattr(supabase_client, "_upsert_asset_tables_with_rest", lambda *args: None)

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda _: nullcontext(SimpleNamespace(execute=lambda *args: None)))
    monkeypatch.setattr(supabase_client, "_transaction_write", lambda table, payload, conflict: captured.setdefault("payload", payload))
    assert supabase_client.upsert_sales_to_supabase([sale], refresh_last_seen=False) == 1

    payload = captured["payload"]
    assert isinstance(payload, list)
    assert payload[0]["last_seen_at"] == "2026-07-01T09:30:00+00:00"
    assert captured["refresh_last_seen"] is False


def test_reconcile_duplicate_sales_in_supabase_merges_historical_rows(monkeypatch) -> None:
    notaires = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://www.immo-interactif.fr/encheres-en-ligne/maison/merignac-33/2008146",
            "address": "33 Avenue Léon Blum, 33700 Mérignac",
            "city": "Mérignac",
            "postal_code": "33700",
            "department": "33",
            "starting_price_eur": "330 000 €",
            "sale_date": "22 juillet 2026 à 10h00",
            "surface_m2": "94 m²",
        }
    )
    encheres_publiques = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://www.encheres-publiques.com/encheres/immobilier/maisons/merignac-33/belle-maison_129746",
            "address": "33 Av. Léon Blum, 33700 Mérignac, France",
            "city": "Mérignac",
            "postal_code": "33700",
            "department": "33",
            "starting_price_eur": "330 000 €",
            "sale_date": "22 juillet 2026 à 10h00",
            "surface_m2": "94 m²",
        }
    )
    rows = [
        {**sale.to_storage_dict(exclude_none=False), "status": "upcoming"}
        for sale in (notaires, encheres_publiques)
    ]
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "dedupe_reconcile_max_rows": 20,
        },
    )

    class Response:
        is_error = False
        status_code = 200
        text = ""

        def json(self):
            return rows

    def fake_get(endpoint, params, headers, timeout):
        captured["fetch_endpoint"] = endpoint
        captured["fetch_params"] = params
        return Response()

    def fake_delete(supabase_url, api_key, sales):
        captured["delete_sales"] = sales
        return len(supabase_client._secondary_source_urls(sales))

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)
    monkeypatch.setattr(
        supabase_client,
        "_upsert_with_rest",
        lambda supabase_url, api_key, payload: captured.setdefault("upsert_payload", payload),
    )
    monkeypatch.setattr(supabase_client, "_delete_secondary_sale_rows", fake_delete)
    monkeypatch.setattr(
        supabase_client,
        "_sync_normalized_sale_tables_with_rest",
        lambda supabase_url, api_key, sales, now: captured.setdefault("normalized_sales", sales),
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_asset_tables_with_rest",
        lambda supabase_url, api_key, sales, now: captured.setdefault("asset_sales", sales),
    )

    deleted = supabase_client.reconcile_duplicate_sales_in_supabase(limit=20)

    assert deleted == 1
    assert captured["fetch_endpoint"] == "https://supabase.test/rest/v1/auction_sales"
    assert captured["fetch_params"]["status"] == 'in.("active","upcoming","unknown")'
    payload = captured["upsert_payload"]
    assert isinstance(payload, list)
    assert len(payload) == 1
    assert payload[0]["dedupe_confidence"] == "address"
    assert payload[0]["source_urls"] == [
        "https://www.encheres-publiques.com/encheres/immobilier/maisons/merignac-33/belle-maison_129746",
        "https://www.immo-interactif.fr/encheres-en-ligne/maison/merignac-33/2008146",
    ]


def test_normalized_sale_rows_split_property_and_judicial_context() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/sale",
            "source_urls": ["https://example.test/sale", "https://licitor.test/sale"],
            "primary_source": "avoventes",
            "department": "33",
            "city": "Bordeaux",
            "address": "12 rue Sainte-Catherine",
            "property_type": "apartment",
            "surface_m2": 42,
            "rooms_count": 2,
            "latitude": 44.84,
            "longitude": -0.57,
            "tribunal": "TJ Bordeaux",
            "tribunal_code": "bordeaux",
            "starting_price_eur": 120000,
            "lawyer_name": "Me Source",
            "lawyer_contact": "source@example.test",
            "documents": [{"label": "Cahier des conditions", "url": "https://example.test/cdc.pdf"}],
            "raw_payload": {"source": "fixture"},
        }
    )

    properties = supabase_client._property_rows_for_sales([sale], "2026-07-06T10:00:00+00:00")
    judicial_sales = supabase_client._judicial_sale_rows_for_sales([sale], "2026-07-06T10:00:00+00:00")

    assert len(properties) == 1
    assert properties[0]["source_url"] == "https://example.test/sale"
    assert properties[0]["source_urls"] == ["https://example.test/sale", "https://licitor.test/sale"]
    assert properties[0]["address"] == "12 rue Sainte-Catherine"
    assert properties[0]["property_type"] == "apartment"
    assert properties[0]["surface_m2"] == 42.0
    assert properties[0]["rooms_count"] == 2
    assert properties[0]["latitude"] == 44.84
    assert properties[0]["longitude"] == -0.57
    assert isinstance(properties[0]["raw_payload"], dict)
    assert properties[0]["last_seen_at"] == "2026-07-06T10:00:00+00:00"
    assert judicial_sales[0]["property_source_url"] == "https://example.test/sale"
    assert judicial_sales[0]["tribunal_code"] == "bordeaux"
    assert judicial_sales[0]["starting_price_eur"] == 120000.0
    assert judicial_sales[0]["source_lawyer_name"] == "Me Source"
    assert judicial_sales[0]["source_lawyer_contact"] == "source@example.test"
    assert judicial_sales[0]["documents_count"] == 1
    assert "referenced_lawyer_id" not in judicial_sales[0]

    sale.last_seen_at = datetime(2026, 7, 1, 9, 30, tzinfo=UTC)
    preserved_properties = supabase_client._property_rows_for_sales(
        [sale],
        "2026-07-06T10:00:00+00:00",
        refresh_last_seen=False,
    )
    preserved_judicial_sales = supabase_client._judicial_sale_rows_for_sales(
        [sale],
        "2026-07-06T10:00:00+00:00",
        refresh_last_seen=False,
    )
    assert preserved_properties[0]["last_seen_at"] == "2026-07-01T09:30:00+00:00"
    assert preserved_judicial_sales[0]["last_seen_at"] == "2026-07-01T09:30:00+00:00"


def test_sync_normalized_sale_tables_upserts_properties_before_judicial_sales(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/sale",
            "city": "Pau",
        }
    )
    calls: list[tuple[str, str, str, int]] = []

    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda supabase_url, api_key, table, payload, on_conflict: calls.append(
            (supabase_url, table, on_conflict, len(payload))
        ),
    )

    supabase_client._sync_normalized_sale_tables_with_rest(
        "https://supabase.test",
        "secret",
        [sale],
        "2026-07-06T10:00:00+00:00",
    )

    assert calls == [
        ("https://supabase.test", "properties", "source_url", 1),
        ("https://supabase.test", "judicial_sales", "source_url", 1),
    ]


def test_upsert_observations_prefers_direct_postgres_when_db_url_is_configured(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes", "starting_price_eur": 10000,
            "source_url": "https://example.test/sale",
            "observations": [{"source_name": "avoventes", "starting_price_eur": 10000, "source_url": "https://example.test/sale"}],
        }
    )
    calls: list[tuple[str, str, int]] = []

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
        lambda db_url, table, payload, on_conflict: calls.append((db_url, table, len(payload))),
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("REST observation upsert should not run")),
    )

    assert supabase_client.upsert_observations_to_supabase([sale]) == 1
    assert calls == [("postgresql://example", "auction_observations", 1)]


def test_upsert_documents_deduplicates_document_urls(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes", "starting_price_eur": 10000,
            "source_url": "https://example.test/sale",
            "documents": [
                {"url": "https://example.test/pv.pdf", "label": "PV descriptif"},
                {"url": "https://example.test/pv.pdf", "label": "PV descriptif duplicate"},
                {"url": "https://example.test/ccv.pdf", "label": "CCV"},
            ],
        }
    )
    calls: list[tuple[str, list[dict[str, object]], str]] = []

    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda supabase_url, api_key, table, payload, on_conflict: calls.append(
            (table, payload, on_conflict)
        ),
    )

    assert supabase_client.upsert_documents_to_supabase([sale]) == 2
    assert calls[0][0] == "auction_documents"
    assert calls[0][2] == "document_url"
    assert [row["document_url"] for row in calls[0][1]] == [
        "https://example.test/pv.pdf",
        "https://example.test/ccv.pdf",
    ]
    assert calls[0][1][0]["label"] == "PV descriptif duplicate"


def test_upsert_cadastre_parcels_uses_service_role_rest_upsert(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda supabase_url, api_key, table, payload, on_conflict: calls.append(
            (supabase_url, api_key, table, payload, on_conflict)
        ),
    )

    count = supabase_client.upsert_cadastre_parcels_to_supabase(
        [
            {
                "source_url": "https://example.test/sale",
                "parcel_key": "33063-AB-0123",
                "section": "AB",
                "parcel_number": "0123",
            },
            {"source_url": "https://example.test/ignored"},
        ]
    )

    assert count == 1
    assert calls[0][0] == "https://supabase.test"
    assert calls[0][1] == "secret"
    assert calls[0][2] == "auction_cadastre_parcels"
    assert calls[0][3][0]["parcel_key"] == "33063-AB-0123"
    assert calls[0][3][0]["updated_at"]
    assert calls[0][4] == "source_url,parcel_key"


def test_upsert_dpe_diagnostics_uses_service_role_rest_upsert(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda supabase_url, api_key, table, payload, on_conflict: calls.append(
            (supabase_url, api_key, table, payload, on_conflict)
        ),
    )

    count = supabase_client.upsert_dpe_diagnostics_to_supabase(
        [
            {
                "source_url": "https://example.test/sale",
                "diagnostic_number": "2133E0178774F",
                "dpe_class": "E",
            },
            {"source_url": "https://example.test/ignored"},
        ]
    )

    assert count == 1
    assert calls[0][0] == "https://supabase.test"
    assert calls[0][1] == "secret"
    assert calls[0][2] == "auction_dpe_diagnostics"
    assert calls[0][3][0]["diagnostic_number"] == "2133E0178774F"
    assert calls[0][3][0]["updated_at"]
    assert calls[0][4] == "source_url,diagnostic_number"


def test_postgres_connect_disables_prepared_statements_for_pooler(monkeypatch) -> None:
    calls: dict[str, object] = {}
    connection = object()

    class Psycopg:
        def connect(self, *args, **kwargs):
            calls["args"] = args
            calls["kwargs"] = kwargs
            return connection

    monkeypatch.setattr(supabase_client, "psycopg", Psycopg())

    assert supabase_client._postgres_connect("postgresql://example") is connection
    assert calls["args"] == ("postgresql://example",)
    assert calls["kwargs"] == {
        "connect_timeout": supabase_client.POSTGRES_CONNECT_TIMEOUT,
        "prepare_threshold": None,
    }


def test_asset_table_cleanup_batches_source_url_deletes(monkeypatch) -> None:
    sales = [
        normalize_sale(
            {
                "source_name": "licitor",
                "source_url": f"https://example.test/annonce/{index}/" + ("path-" * 30),
            }
        )
        for index in range(supabase_client.POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE + 1)
    ]
    delete_calls: list[tuple[str, str]] = []

    monkeypatch.setattr(supabase_client, "_postgrest_upsert", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "_postgrest_insert", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "upsert_documents_to_supabase", lambda *args, **kwargs: 0)
    monkeypatch.setattr(supabase_client, "upsert_extractions_to_supabase", lambda *args, **kwargs: 0)
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete",
        lambda supabase_url, api_key, table, params: delete_calls.append((table, params["source_url"])),
    )

    supabase_client._upsert_asset_tables_with_rest(
        "https://supabase.test",
        "secret",
        sales,
        "2026-06-30T13:00:00+00:00",
    )

    assert [table for table, _filter in delete_calls] == [
        "auction_surface_derivations",
        "auction_surface_derivations",
        "auction_surface_measurements",
        "auction_surface_measurements",
        "auction_risks",
        "auction_risks",
        "auction_risk_occurrences",
        "auction_risk_occurrences",
        "auction_urban_planning_signals",
        "auction_urban_planning_signals",
        "auction_score_factors",
        "auction_score_factors",
    ]
    assert delete_calls[0][1].count("https://example.test") == supabase_client.POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE
    assert delete_calls[1][1].count("https://example.test") == 1


def test_surface_reasoning_rows_preserve_evidence_and_formula() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_immobilieres",
            "source_url": "https://example.test/surface-persistence",
        }
    )
    sale.raw_payload["surface_analysis"] = {
        "version": "surface_reasoning_v1",
        "selected_derivation_id": "derivation-1",
        "measurements": [
            {
                "measurement_id": "measurement-1",
                "asset_id": "asset-main",
                "space_label": "séjour",
                "category": "habitable",
                "value_m2": "19.56",
                "included_in_habitable_sum": True,
                "confidence": 0.93,
                "extraction_method": "llm",
                "evidence": {
                    "quote": "séjour (19,56 m²)",
                    "document_label": "PV descriptif",
                    "page_number": 3,
                },
            }
        ],
        "candidates": [],
        "derivations": [
            {
                "derivation_id": "derivation-1",
                "asset_id": "asset-main",
                "kind": "calculated_room_sum",
                "value_m2": "19.56",
                "operand_measurement_ids": ["measurement-1"],
                "formula": "19.56 = 19.56 m²",
                "validation_status": "partial",
                "confidence": 0.68,
                "warnings": ["room_measurement_set_may_be_incomplete"],
            }
        ],
    }

    measurements = supabase_client._surface_measurement_rows_for_sale(sale)
    derivations = supabase_client._surface_derivation_rows_for_sale(sale)

    assert measurements[0]["evidence_quote"] == "séjour (19,56 m²)"
    assert measurements[0]["page_number"] == 3
    assert measurements[0]["reasoning_version"] == "surface_reasoning_v1"
    assert derivations[0]["formula"] == "19.56 = 19.56 m²"
    assert derivations[0]["is_selected"] is True
    assert derivations[0]["operand_measurement_keys"] == [measurements[0]["measurement_key"]]


def test_fail_stale_running_runs_marks_rows_failed(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False

        def json(self):
            return [
                {
                    "id": "run-1",
                    "summary": {"trigger": "admin_dashboard"},
                    "errors": {},
                    "started_at": "2026-06-29T14:41:12Z",
                }
            ]

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/auction_runs"
        assert params["status"] == "eq.running"
        assert params["started_at"].startswith("lt.")
        return Response()

    finished = []
    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)
    monkeypatch.setattr(
        supabase_client,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finished.append((run_id, status, summary, errors)),
    )

    assert supabase_client.fail_stale_running_runs_in_supabase(max_age_minutes=190) == 1
    assert finished[0][0] == "run-1"
    assert finished[0][1] == "failed"
    assert "stale_cleanup" in finished[0][2]
    assert finished[0][3]["runner"]


def test_has_active_running_run_checks_recent_running_rows(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False
        text = ""

        def json(self):
            return [{"id": "run-active"}]

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/auction_runs"
        assert params["select"] == "id"
        assert params["status"] == "eq.running"
        assert params["started_at"].startswith("gte.")
        assert params["limit"] == "1"
        return Response()

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    assert supabase_client.has_active_running_run_in_supabase(max_age_minutes=190) is True


def test_update_run_progress_in_supabase_patches_running_row(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    captured: dict[str, object] = {}

    class Response:
        is_error = False
        text = ""

    def fake_patch(endpoint, params, headers, json, timeout):
        captured["endpoint"] = endpoint
        captured["params"] = params
        captured["json"] = json
        return Response()

    monkeypatch.setattr(supabase_client.httpx, "patch", fake_patch)

    supabase_client.update_run_progress_in_supabase(
        "run-progress",
        {"mode": "llm_description_backfill", "completed": 1},
        {"llm_backfill": []},
    )

    assert captured["endpoint"] == "https://supabase.test/rest/v1/auction_runs"
    assert captured["params"] == {"id": "eq.run-progress", "status": "eq.running"}
    assert captured["json"] == {
        "summary": {"mode": "llm_description_backfill", "completed": 1},
        "errors": {"llm_backfill": []},
    }


def test_fetch_next_data_refresh_request_locks_queued_row(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False
        text = ""

        def __init__(self, rows):
            self._rows = rows

        def json(self):
            return self._rows

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/data_refresh_requests"
        assert params["status"] == "eq.queued"
        assert params["order"] == "priority.desc,created_at.asc"
        return Response(
            [
                {
                    "id": "refresh-1",
                    "source_url": "https://example.test/sale",
                    "request_kind": "dpe",
                    "status": "queued",
                }
            ]
        )

    def fake_patch(endpoint, params, headers, json, timeout):
        assert endpoint == "https://supabase.test/rest/v1/data_refresh_requests"
        assert params == {"id": "eq.refresh-1", "status": "eq.queued"}
        assert json["status"] == "running"
        assert json["started_at"]
        return Response([{**json, "id": "refresh-1", "request_kind": "dpe"}])

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)
    monkeypatch.setattr(supabase_client.httpx, "patch", fake_patch)

    request = supabase_client.fetch_next_data_refresh_request_from_supabase()

    assert request is not None
    assert request["id"] == "refresh-1"
    assert request["status"] == "running"
    assert request["request_kind"] == "dpe"


def test_fetch_sale_for_data_refresh_returns_auction_sale(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False
        text = ""

        def json(self):
            return [
                {
                    "source_name": "avoventes",
                    "source_url": "https://example.test/sale",
                    "city": "Bordeaux",
                    "latitude": 44.84,
                    "longitude": -0.57,
                    "source_urls": ["https://example.test/sale"],
                    "documents": [],
                    "raw_payload": {},
                }
            ]

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/auction_sales"
        assert params["source_url"] == "eq.https://example.test/sale"
        assert "source_name" in params["select"]
        return Response()

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    sale = supabase_client.fetch_sale_for_data_refresh("https://example.test/sale")

    assert sale is not None
    assert sale.source_name == "avoventes"
    assert sale.source_url == "https://example.test/sale"
    assert float(sale.latitude or 0) == 44.84
