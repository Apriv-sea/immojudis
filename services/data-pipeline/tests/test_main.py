import sys
import types
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from src.freshness import document_fingerprint
from src.models import AuctionSale
from src.sources.common import ScrapeResult

try:
    from src import main
except ModuleNotFoundError as exc:
    if exc.name != "pandas":
        raise
    sys.modules.pop("src.main", None)
    export_stub = types.ModuleType("src.export")
    export_stub.export_sales = lambda sales: ("out.json", "out.csv")
    sys.modules["src.export"] = export_stub
    from src import main

    del sys.modules["src.export"]


@pytest.fixture(autouse=True)
def _disable_real_expired_sale_cleanup(monkeypatch) -> None:
    monkeypatch.delenv("GITHUB_ENV", raising=False)
    monkeypatch.setattr(main, "delete_expired_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_secondary_sales_in_supabase", lambda sales: 0)
    monkeypatch.setattr(
        main,
        "bridge_auction_sales_before_cleanup",
        lambda settings: types.SimpleNamespace(
            scanned_count=0,
            created_count=0,
            reused_count=0,
        ),
    )


def test_needs_heavy_enrichment_skips_complete_sale(monkeypatch) -> None:
    monkeypatch.setattr(main, "load_settings", lambda: {**_settings(), "llm_prompt_version": "auction_llm_v5"})
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        property_type="apartment",
        app_surface_m2=Decimal("42"),
        occupancy_status="vacant",
        rooms_count=2,
        raw_text="Appartement libre de 42 m2.",
    )

    assert main._needs_heavy_enrichment(sale, use_llm=False) is False
    assert main._needs_heavy_enrichment(sale, use_llm=True) is True
    sale.raw_payload["llm_display_description"] = "Appartement libre de 42 m2."
    assert main._needs_heavy_enrichment(sale, use_llm=True) is True
    sale.raw_payload["llm_prompt_version"] = "auction_llm_v5"
    assert main._needs_heavy_enrichment(sale, use_llm=True) is False


def test_document_facts_version_forces_one_time_pdf_reanalysis() -> None:
    sale = AuctionSale(
        source_name="info_encheres",
        source_url="https://www.info-encheres.com/vente-6008.html",
        property_type="house",
        app_surface_m2=Decimal("375"),
        occupancy_status="occupied",
        rooms_count=2,
        starting_price_eur=Decimal("11"),
        documents=[
            {
                "label": "Cahier des conditions de la vente",
                "url": "https://www.info-encheres.com/upload/cahier-6008.pdf",
            }
        ],
        content_hash="known-content",
    )

    assert main._needs_structured_heavy_enrichment(sale) is True
    assert main._heavy_enrichment_already_current(sale, {"known-content"}, use_llm=False) is False

    sale.raw_payload["document_facts_version"] = "document_facts_v1_starting_price"

    assert main._needs_structured_heavy_enrichment(sale) is True
    assert main._heavy_enrichment_already_current(sale, {"known-content"}, use_llm=False) is False

    sale.raw_payload["document_facts_version"] = main.DOCUMENT_FACTS_VERSION
    sale.raw_payload["document_analysis"] = {"checked_at": datetime.now(UTC).isoformat(), "input_fingerprint": document_fingerprint(sale.documents)}

    assert main._needs_structured_heavy_enrichment(sale) is False
    assert main._heavy_enrichment_already_current(sale, {"known-content"}, use_llm=False) is True


def test_heavy_enrichment_does_not_skip_stale_llm_description(monkeypatch) -> None:
    monkeypatch.setattr(main, "load_settings", lambda: {**_settings(), "llm_prompt_version": "auction_llm_v5"})
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente-stale",
        property_type="apartment",
        app_surface_m2=Decimal("42"),
        occupancy_status="vacant",
        rooms_count=2,
        raw_text="Appartement libre de 42 m2.",
        content_hash="same-content",
        raw_payload={
            "llm_display_description": "Ancienne synthèse.",
            "llm_prompt_version": "auction_llm_v4",
        },
    )

    assert main._needs_heavy_enrichment(sale, use_llm=True) is True
    assert main._heavy_enrichment_already_current(sale, {"same-content"}, use_llm=True) is False

    sale.raw_payload["llm_prompt_version"] = "auction_llm_v5"
    assert main._heavy_enrichment_already_current(sale, {"same-content"}, use_llm=True) is True


def test_needs_heavy_enrichment_keeps_incomplete_sale() -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        property_type="apartment",
        documents=[{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
    )

    assert main._needs_heavy_enrichment(sale) is True


def test_pdf_target_limit_prioritizes_missing_surface_with_official_documents() -> None:
    partner_only = AuctionSale(
        source_name="licitor",
        source_url="https://www.licitor.com/annonce/partner-only.html",
        property_type="house",
        status="upcoming",
        documents=[
            {
                "label": "Voir le dossier complet avec",
                "url": "https://app-pro.la-loupe.immo/ext-partenaire/licitor/token/",
                "type": "pdf",
            }
        ],
    )
    official_documents = AuctionSale(
        source_name="info_encheres",
        source_url="https://www.info-encheres.com/vente-pv.html",
        property_type="apartment",
        status="upcoming",
        documents=[
            {
                "label": "Procès-verbal descriptif",
                "url": "https://www.info-encheres.com/upload/pvd.pdf",
                "type": "pv_descriptif",
            }
        ],
    )

    selected = main._limit_pdf_targets(
        [partner_only, official_documents],
        {"pipeline_pdf_max_targets": 1},
    )

    assert selected == [official_documents]


def test_run_pipeline_upserts_light_sale_before_pdf_enrichment(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    _fake_geocode.calls = calls
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: calls.append("pdf") or (_raise_pdf()))
    monkeypatch.setattr(main, "enrich_sale_with_llm", lambda *args, **kwargs: main.LLMEnrichmentStats())
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)

    def upsert_sales(sales: list[AuctionSale]) -> int:
        calls.append("upsert")
        if "geocode" in calls:
            assert sales[0].latitude is not None
        else:
            assert sales[0].latitude is None
        assert sales[0].last_run_id == "run-1"
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert_sales)
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    assert main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, upsert=True)) == 0
    assert calls.index("upsert") < calls.index("pdf")
    assert calls.index("upsert") < calls.index("geocode")
    assert calls.count("upsert") == 2


def test_light_pipeline_geocodes_and_reupserts_when_heavy_enrichment_disabled(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    _fake_geocode.calls = calls
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)

    def upsert_sales(sales: list[AuctionSale]) -> int:
        calls.append("upsert")
        if "geocode" in calls:
            assert sales[0].latitude is not None
        else:
            assert sales[0].latitude is None
        assert sales[0].last_run_id == "run-1"
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert_sales)
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    assert (
        main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True))
        == 0
    )
    assert calls == ["upsert", "observations", "geocode", "upsert", "observations"]


@pytest.mark.parametrize(
    "source,limit,global_cleanup", [("all", None, True), ("avoventes", None, False), ("all", 10, False)]
)
def test_pipeline_deletes_expired_sales_after_supabase_publication(monkeypatch, source, limit, global_cleanup) -> None:
    summary_capture: dict[str, object] = {}
    calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: summary_capture.update(summary),
    )
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "geocode_sale", lambda sale: sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(
        main,
        "bridge_auction_sales_before_cleanup",
        lambda settings: (
            calls.append("bridge") or types.SimpleNamespace(scanned_count=3, created_count=3, reused_count=0)
        ),
    )
    monkeypatch.setattr(
        main,
        "reconcile_duplicate_sales_in_supabase",
        lambda **kwargs: calls.append("reconcile") or 0,
    )
    monkeypatch.setattr(
        main,
        "delete_secondary_sales_in_supabase",
        lambda sales: calls.append("delete_secondary") or 1,
    )
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: calls.append("mark_past") or 0)
    monkeypatch.setattr(main, "delete_expired_sales_in_supabase", lambda: calls.append("delete_expired") or 3)
    monkeypatch.setattr(
        main,
        "delete_vench_sales_without_surface_in_supabase",
        lambda: calls.append("delete_vench") or 0,
    )
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales: calls.append("upsert") or len(sales))
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    assert (
        main.run_pipeline(
            main.PipelineOptions(source=source, limit=limit, use_llm=False, heavy_enrichment=False, upsert=True)
        )
        == 0
    )
    expected_cleanup = [
        "bridge",
        "delete_secondary",
        "reconcile",
        "mark_past",
        "delete_expired",
        "delete_vench",
    ]
    if global_cleanup:
        assert calls[-6:] == expected_cleanup
    else:
        assert "bridge" not in calls
        assert "delete_secondary" not in calls
    assert summary_capture["deleted_expired_sales"] == (3 if global_cleanup else 0)
    assert summary_capture["deleted_secondary_sales"] == (1 if global_cleanup else 0)
    assert summary_capture["outcome_bridge_scanned"] == (3 if global_cleanup else 0)


@pytest.mark.parametrize("collection_failed", [False, True])
def test_pipeline_skips_every_cleanup_when_outcome_bridge_fails(monkeypatch, collection_failed) -> None:
    finish_calls: list[tuple[str, dict[str, list[str]]]] = []
    cleanup_calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finish_calls.append((status, errors)),
    )
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(
        main,
        "scrape_avoventes_aquitaine_result",
        lambda known=None: ScrapeResult([_raw_sale()], ["source validation failed"] if collection_failed else []),
    )
    monkeypatch.setattr(main, "geocode_sale", lambda sale: sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales, **kwargs: len(sales))
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **kwargs: len(sales))
    monkeypatch.setattr(
        main,
        "bridge_auction_sales_before_cleanup",
        lambda settings: (_ for _ in ()).throw(RuntimeError("bridge incomplete")),
    )
    monkeypatch.setattr(
        main,
        "reconcile_duplicate_sales_in_supabase",
        lambda **kwargs: cleanup_calls.append("reconcile") or 0,
    )
    monkeypatch.setattr(
        main,
        "delete_secondary_sales_in_supabase",
        lambda sales: cleanup_calls.append("delete_secondary") or 0,
    )
    monkeypatch.setattr(
        main,
        "mark_past_sales_in_supabase",
        lambda: cleanup_calls.append("mark_past") or 0,
    )
    monkeypatch.setattr(
        main,
        "delete_expired_sales_in_supabase",
        lambda: cleanup_calls.append("delete_expired") or 0,
    )
    monkeypatch.setattr(
        main,
        "delete_vench_sales_without_surface_in_supabase",
        lambda: cleanup_calls.append("delete_vench") or 0,
    )

    result = main.run_pipeline(
        main.PipelineOptions(source="all", use_llm=False, heavy_enrichment=False, upsert=True)
    )

    assert result == 1
    assert cleanup_calls == []
    assert finish_calls[-1][0] == "failed"
    assert finish_calls[-1][1]["supabase"] == [
        "Collection incomplete; catalogue cleanup is disabled." if collection_failed else "bridge incomplete"
    ]


def test_pipeline_returns_failure_when_final_supabase_publication_fails(monkeypatch) -> None:
    finish_calls: list[tuple[str, dict[str, list[str]]]] = []
    upsert_calls = 0

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finish_calls.append((status, errors)),
    )
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **kwargs: len(sales))

    def upsert_sales(sales: list[AuctionSale]) -> int:
        nonlocal upsert_calls
        upsert_calls += 1
        if upsert_calls == 2:
            raise RuntimeError("final publication rejected")
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert_sales)

    result = main.run_pipeline(
        main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True)
    )

    assert result == 1
    assert finish_calls[-1][0] == "failed"
    assert finish_calls[-1][1]["supabase"] == ["final publication rejected"]


def test_pipeline_recovers_when_only_early_supabase_publication_fails(monkeypatch) -> None:
    finish_statuses: list[str] = []
    upsert_calls = 0

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finish_statuses.append(status),
    )
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **kwargs: len(sales))

    def upsert_sales(sales: list[AuctionSale]) -> int:
        nonlocal upsert_calls
        upsert_calls += 1
        if upsert_calls == 1:
            raise RuntimeError("temporary early publication failure")
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert_sales)

    result = main.run_pipeline(
        main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True)
    )

    assert result == 0
    assert finish_statuses[-1] == "succeeded"
    assert upsert_calls == 2


def test_pipeline_skips_redundant_final_sale_upsert_when_unchanged(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "geocode_sale", lambda sale: calls.append("geocode") or sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "classify_sale_procedure", lambda sale: sale)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(
        main, "upsert_sales_to_supabase", lambda sales: calls.append(f"upsert:{len(sales)}") or len(sales)
    )
    monkeypatch.setattr(
        main,
        "upsert_observations_to_supabase",
        lambda sales: calls.append(f"observations:{len(sales)}") or len(sales),
    )

    assert (
        main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True))
        == 0
    )
    assert calls == ["upsert:1", "observations:1", "geocode"]


def test_pipeline_enriches_cadastre_after_final_geocode(monkeypatch) -> None:
    calls: list[str] = []
    settings = _settings()
    settings.update(
        {
            "cadastre_enrich_enabled": True,
            "cadastre_api_url": "https://apicarto.test/cadastre/parcelle",
            "cadastre_source_ign": "PCI",
            "cadastre_max_parcels": 4,
            "cadastre_timeout_seconds": 10,
        }
    )

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    _fake_geocode.calls = calls
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales: calls.append("upsert") or len(sales))
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    def enrich_cadastre(sales, settings):
        calls.append("cadastre_enrich")
        assert sales[0].latitude == Decimal("44.84")
        assert settings["cadastre_enrich_enabled"] is True
        return [{"source_url": sales[0].source_url, "parcel_key": "33063-AB-0123"}]

    monkeypatch.setattr(main, "enrich_cadastre_sales", enrich_cadastre)
    monkeypatch.setattr(
        main,
        "upsert_cadastre_parcels_to_supabase",
        lambda rows: calls.append(f"cadastre_upsert:{len(rows)}") or len(rows),
    )

    assert (
        main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True))
        == 0
    )
    assert calls == [
        "upsert",
        "observations",
        "geocode",
        "cadastre_enrich",
        "upsert",
        "observations",
        "cadastre_upsert:1",
    ]


def test_pipeline_enriches_dpe_after_final_geocode(monkeypatch) -> None:
    calls: list[str] = []
    settings = _settings()
    settings.update(
        {
            "dpe_enrich_enabled": True,
            "dpe_api_url": "https://data.ademe.test/lines",
            "dpe_geo_radius_m": 120,
            "dpe_max_results": 5,
            "dpe_timeout_seconds": 12,
        }
    )

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    _fake_geocode.calls = calls
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales: calls.append("upsert") or len(sales))
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    def enrich_dpe(sales, settings):
        calls.append("dpe_enrich")
        assert sales[0].latitude == Decimal("44.84")
        assert settings["dpe_enrich_enabled"] is True
        return [{"source_url": sales[0].source_url, "diagnostic_number": "2133E0178774F"}]

    monkeypatch.setattr(main, "enrich_dpe_sales", enrich_dpe)
    monkeypatch.setattr(
        main,
        "upsert_dpe_diagnostics_to_supabase",
        lambda rows: calls.append(f"dpe_upsert:{len(rows)}") or len(rows),
    )

    assert (
        main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True))
        == 0
    )
    assert calls == [
        "upsert",
        "observations",
        "geocode",
        "dpe_enrich",
        "upsert",
        "observations",
        "dpe_upsert:1",
    ]


def test_incremental_skip_only_skips_heavy_enrichment_not_publication(monkeypatch) -> None:
    calls: list[str] = []
    settings = _settings()
    settings["incremental_enrichment"] = True
    raw = {**_raw_sale(), "document_facts_version": main.DOCUMENT_FACTS_VERSION, "_known_unchanged": True}
    raw["document_analysis"] = {"checked_at": datetime.now(UTC).isoformat(), "input_fingerprint": document_fingerprint(raw.get("documents", []))}

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set(hashes))
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([raw], []))
    _fake_geocode.calls = calls
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: calls.append("pdf") or (_raise_pdf()))
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales: calls.append("upsert") or len(sales))
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    assert main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, upsert=True)) == 0
    assert "pdf" not in calls
    assert "geocode" in calls
    assert calls.count("upsert") == 2


def test_pipeline_generates_llm_description_when_heavy_enrichment_is_disabled(monkeypatch) -> None:
    calls: list[str] = []
    settings = _settings()
    settings["incremental_enrichment"] = True

    raw = {
        **_raw_sale(),
        "surface_m2": "42",
        "rooms_count": 2,
        "occupancy_status": "vacant",
        "document_facts_version": main.DOCUMENT_FACTS_VERSION,
        "source_blocks": {"description": "Appartement libre de 42 m2."},
    }

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([raw], []))

    def fake_fetch(hashes, **kwargs):
        if kwargs.get("require_llm_description"):
            return set()
        return set(hashes)

    monkeypatch.setattr(main, "fetch_enriched_content_hashes", fake_fetch)
    monkeypatch.setattr(main, "geocode_sale", lambda sale: sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: calls.append("pdf") or (_raise_pdf()))
    monkeypatch.setattr(
        main,
        "enrich_sale_with_llm",
        lambda *args, **kwargs: calls.append("llm") or main.LLMEnrichmentStats(analyzed=1, valid_json=1),
    )
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales, **kwargs: len(sales))
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **kwargs: len(sales))

    assert (
        main.run_pipeline(
            main.PipelineOptions(
                source="avoventes",
                use_llm=True,
                heavy_enrichment=False,
                upsert=True,
            )
        )
        == 0
    )
    assert "pdf" not in calls
    assert calls == ["llm"]


def test_pipeline_requires_current_llm_description_for_incremental_skip(monkeypatch) -> None:
    captured: dict[str, object] = {}
    settings = _settings()
    settings["incremental_enrichment"] = True

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "geocode_sale", lambda sale: sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: None)
    monkeypatch.setattr(main, "enrich_sale_with_llm", lambda *args, **kwargs: main.LLMEnrichmentStats())
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales, **kwargs: len(sales))
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **kwargs: len(sales))

    def fake_fetch(hashes, **kwargs):
        captured["hashes"] = hashes
        captured["kwargs"] = kwargs
        return set(hashes)

    monkeypatch.setattr(main, "fetch_enriched_content_hashes", fake_fetch)

    assert main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=True, upsert=True)) == 0
    assert captured["kwargs"] == {
        "require_llm_description": True,
        "prompt_version": "auction_llm_v5",
    }


def test_parse_args_can_select_llm_description_backfill() -> None:
    options = main.parse_args(
        [
            "--backfill-llm-descriptions",
            "--limit",
            "7",
            "--backfill-statuses",
            "active,upcoming,unknown",
        ]
    )

    assert options.llm_backfill is True
    assert options.limit == 7
    assert options.llm_backfill_statuses == ("active", "upcoming", "unknown")


def test_run_llm_description_backfill_marks_failed_sales(monkeypatch) -> None:
    settings = _settings()
    settings.update(
        {
            "pipeline_llm_backfill_max_targets": 2,
            "pipeline_enrich_workers": 1,
            "pipeline_llm_workers": 1,
            "pipeline_llm_backfill_progress_every": 5,
            "llm_prompt_version": "auction_llm_v6_display",
        }
    )
    stale = AuctionSale(
        source_name="notaires",
        source_url="https://example.test/stale",
        title="Maison 85 m²",
        raw_payload={"source_blocks": {"description": "Maison avec jardin."}},
    )
    failed = AuctionSale(
        source_name="notaires",
        source_url="https://example.test/failed",
        title="Appartement",
        raw_payload={"source_blocks": {"description": "Appartement."}},
    )
    calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-backfill")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: calls.append("finish"))
    monkeypatch.setattr(
        main,
        "update_run_progress_in_supabase",
        lambda run_id, summary, errors=None: calls.append(f"progress:{summary['completed']}"),
    )
    monkeypatch.setattr(main, "fetch_sales_needing_llm_descriptions", lambda **kwargs: [stale, failed])
    monkeypatch.setattr(main, "create_llm_client", lambda: object())

    def fake_enrich(sale, client=None):
        calls.append(f"llm:{sale.source_url.rsplit('/', 1)[-1]}")
        if sale is stale:
            stats = main.LLMEnrichmentStats(analyzed=1, valid_json=1)
            sale.raw_payload["llm_display_description"] = "Maison avec jardin proche du centre."
            sale.raw_payload["llm_prompt_version"] = "auction_llm_v6_display"
        else:
            stats = main.LLMEnrichmentStats(
                analyzed=1,
                errors=1,
                error_messages=["LLM extraction failed [notaires] https://example.test/failed"],
            )
        return stats

    monkeypatch.setattr(main, "enrich_sale_with_llm", fake_enrich)

    def fake_upsert(sales: list[AuctionSale], *, refresh_last_seen: bool) -> int:
        assert refresh_last_seen is False
        calls.append(f"upsert:{len(sales)}")
        assert len(sales) == 1
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", fake_upsert)

    assert main.run_llm_description_backfill(main.PipelineOptions(llm_backfill=True, upsert=True)) == 1
    assert calls.count("upsert:1") == 2
    assert calls[-1] == "finish"
    assert failed.raw_payload["llm_display_error_count"] == 1


def test_llm_backfill_progress_is_batched() -> None:
    assert main._should_update_llm_backfill_progress(0, total=20, every=5) is False
    assert main._should_update_llm_backfill_progress(4, total=20, every=5) is False
    assert main._should_update_llm_backfill_progress(5, total=20, every=5) is True
    assert main._should_update_llm_backfill_progress(19, total=20, every=5) is False
    assert main._should_update_llm_backfill_progress(20, total=20, every=5) is True


def test_known_unchanged_detail_is_hydrated_from_known_sale() -> None:
    raw = {
        "_known_unchanged": True,
        "source_url": "https://example.test/vente",
        "source_name": "vench",
        "title": "",
    }
    known = {
        "https://example.test/vente": {
            "title": "Appartement connu",
            "latitude": 44.84,
            "longitude": -0.57,
            "visit_dates": ["2027-01-05 10:00"],
            "lawyer_name": "Me Test",
            "lawyer_contact": "contact@example.test",
            "raw_payload": {
                "source_blocks": {"visites": "Sur rendez-vous"},
                "source_images": ["https://example.test/photo.jpg"],
            },
        }
    }

    assert main._hydrate_known_unchanged_sales([raw], known) == 1
    assert raw["title"] == "Appartement connu"
    assert raw["latitude"] == 44.84
    assert raw["visit_dates"] == ["2027-01-05 10:00"]
    assert raw["lawyer_name"] == "Me Test"
    assert raw["source_blocks"] == {"visites": "Sur rendez-vous"}


def test_known_pdf_surface_is_preserved_before_incremental_publication() -> None:
    raw = {
        "source_url": "https://www.info-encheres.com/vente-6009.html",
        "source_name": "info_encheres",
        "property_type": "Appartement",
    }
    known = {
        raw["source_url"]: {
            "surface_m2": 3.78,
            "carrez_surface_m2": 3.78,
            "app_surface_m2": None,
            "app_surface_kind": None,
            "surface_scope": "partial",
            "surface_source": "pdf",
            "surface_confidence": 0.45,
            "surface_evidence": "Mesurage incomplet : 3,78 m².",
            "raw_payload": {
                "surface_extraction": {"source": "pdf", "value_m2": "3.78"},
                "document_analysis": {"coverage_status": "rich", "documents_extracted": 3},
            },
        }
    }

    preserved = main._preserve_known_enrichment_payloads([raw], known)

    assert preserved == 8
    assert raw["surface_m2"] == 3.78
    assert raw["carrez_surface_m2"] == 3.78
    assert raw["surface_scope"] == "partial"
    assert raw["surface_source"] == "pdf"
    assert raw["surface_extraction"] == {"source": "pdf", "value_m2": "3.78"}
    assert raw["document_analysis"]["documents_extracted"] == 3


def test_known_pdf_price_resolution_is_preserved_until_source_price_changes() -> None:
    source_url = "https://www.info-encheres.com/vente-6008.html"
    raw = {
        "source_url": source_url,
        "source_name": "info_encheres",
        "starting_price_eur": "11 €",
    }
    extraction = {
        "version": "document_facts_v1_starting_price",
        "source": "pdf",
        "status": "resolved",
        "value_eur": 10500.0,
        "rejected_source_price_eur": 11.0,
        "selected_value_eur": 10500.0,
    }
    known = {
        source_url: {
            "starting_price_eur": 10500,
            "raw_payload": {
                "starting_price_extraction": extraction,
                "document_facts_version": "document_facts_v1_starting_price",
            },
        }
    }

    preserved = main._preserve_known_enrichment_payloads([raw], known)

    assert preserved == 3
    assert raw["starting_price_eur"] == Decimal("10500")
    assert raw["starting_price_extraction"] == extraction
    assert raw["document_facts_version"] == "document_facts_v1_starting_price"

    changed_raw = {
        "source_url": source_url,
        "source_name": "info_encheres",
        "starting_price_eur": "12 000 €",
    }

    assert main._preserve_known_enrichment_payloads([changed_raw], known) == 0
    assert changed_raw["starting_price_eur"] == "12 000 €"
    assert "starting_price_extraction" not in changed_raw
    assert "document_facts_version" not in changed_raw


def test_pipeline_aborts_before_publication_when_known_sale_lookup_fails(monkeypatch) -> None:
    settings = _settings()
    settings["incremental_enrichment"] = True
    finish_calls: list[tuple[str, dict[str, object], dict[str, list[str]]]] = []

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finish_calls.append((status, summary, errors)),
    )
    monkeypatch.setattr(
        main,
        "fetch_known_sale_details",
        lambda: (_ for _ in ()).throw(RuntimeError("known sale query timed out")),
    )
    monkeypatch.setattr(
        main,
        "scrape_avoventes_aquitaine_result",
        lambda known=None: (_ for _ in ()).throw(AssertionError("scraping must not start")),
    )

    result = main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, upsert=True))

    assert result == 1
    assert finish_calls == [
        (
            "failed",
            {"stage": "known_sale_lookup"},
            {
                "avoventes": [],
                "licitor": [],
                "vench": [],
                "info_encheres": [],
                "encheres_publiques": [],
                "petites_affiches": [],
                "cessions_etat": [],
                "agrasc": [],
                "encheres_immobilieres": [],
                "notaires": [],
                "supabase": ["known sale query timed out"],
            },
        )
    ]


def _settings() -> dict[str, object]:
    return {
        "incremental_enrichment": False,
        "pipeline_pdf_workers": 1,
        "pipeline_enrich_workers": 1,
        "pipeline_llm_workers": 1,
        "pipeline_llm_backfill_progress_every": 5,
        "pipeline_llm_failure_cooldown_hours": 24,
        "pipeline_pdf_max_targets": 0,
        "pipeline_llm_max_targets": 0,
        "enable_licitor_benchmark": False,
        "enable_vench_benchmark": False,
        "enable_info_encheres_benchmark": False,
        "enable_encheres_publiques_benchmark": False,
        "enable_petites_affiches_benchmark": False,
        "enable_cessions_etat_benchmark": False,
        "enable_agrasc_benchmark": False,
        "enable_encheres_immobilieres_benchmark": False,
        "enable_notaires_benchmark": False,
        "licitor_max_pages": 1,
        "vench_max_pages": 1,
        "info_encheres_max_pages": 1,
        "encheres_publiques_max_pages": 1,
        "cessions_etat_max_pages": 1,
        "encheres_immobilieres_max_pages": 1,
        "notaires_max_pages": 1,
        "llm_prompt_version": "auction_llm_v5",
    }


def _raw_sale() -> dict[str, object]:
    return {
        "source_name": "avoventes",
        "source_url": "https://example.test/vente",
        "address": "1 rue Test",
        "city": "Bordeaux",
        "postal_code": "33000",
        "property_type": "apartment",
        "sale_date": "10 janvier 2027 à 9h00",
        "starting_price_eur": "100 000 €",
        "documents": [{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
    }


def _fake_geocode(sale: AuctionSale) -> AuctionSale:
    try:
        main_calls = _fake_geocode.calls
    except AttributeError:
        main_calls = None
    if isinstance(main_calls, list):
        main_calls.append("geocode")
    sale.latitude = Decimal("44.84")
    sale.longitude = Decimal("-0.57")
    return sale


def _raise_pdf() -> None:
    raise RuntimeError("pdf boom")
