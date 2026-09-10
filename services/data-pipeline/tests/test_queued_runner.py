import sys
import types
from types import SimpleNamespace

import pytest

from src.models import AuctionSale
from src.normalize import normalize_sale

try:
    from src import queued_runner
except ModuleNotFoundError as exc:
    if exc.name != "pandas":
        raise
    sys.modules.pop("src.main", None)
    export_stub = types.ModuleType("src.export")
    export_stub.export_sales = lambda sales: ("out.json", "out.csv")
    sys.modules["src.export"] = export_stub
    from src import queued_runner
    del sys.modules["src.export"]


@pytest.fixture(autouse=True)
def no_active_running_run(monkeypatch) -> None:
    monkeypatch.setattr(queued_runner, "has_active_running_run_in_supabase", lambda: False)


def test_queued_runner_skips_when_another_run_is_active(monkeypatch, capsys) -> None:
    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 1)
    monkeypatch.setattr(queued_runner, "has_active_running_run_in_supabase", lambda: True)

    assert queued_runner.main() == 0
    output = capsys.readouterr().out
    assert "already active" in output
    assert "Marked stale runs failed: 1" in output


def test_queued_runner_cleans_past_sales_without_queued_run(monkeypatch, capsys) -> None:
    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 2)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "fetch_next_data_refresh_request_from_supabase", lambda: None)
    monkeypatch.setattr(
        queued_runner,
        "load_settings",
        lambda: {"pipeline_idle_llm_backfill_enabled": False, "pipeline_llm_backfill_max_targets": 20},
    )
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 3)

    assert queued_runner.main() == 0
    output = capsys.readouterr().out
    assert "Marked past sales: 3" in output
    assert "Marked stale runs failed: 2" in output


def test_queued_runner_can_backfill_llm_descriptions_when_idle(monkeypatch) -> None:
    captured = {}

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "fetch_next_data_refresh_request_from_supabase", lambda: None)
    monkeypatch.setattr(
        queued_runner,
        "load_settings",
        lambda: {"pipeline_idle_llm_backfill_enabled": True, "pipeline_llm_backfill_max_targets": 7},
    )
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 0)

    def fake_backfill(options):
        captured["llm_backfill"] = options.llm_backfill
        captured["limit"] = options.limit
        captured["upsert"] = options.upsert
        return 0

    monkeypatch.setattr(queued_runner, "run_llm_description_backfill", fake_backfill)

    assert queued_runner.main() == 0
    assert captured == {"llm_backfill": True, "limit": 7, "upsert": True}


def test_queued_runner_processes_queued_llm_backfill_run(monkeypatch, capsys) -> None:
    captured = {}

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(
        queued_runner,
        "fetch_next_queued_run_from_supabase",
        lambda: {
            "id": "run-backfill",
            "source": "llm-description-backfill",
            "summary": {"limit": 11},
        },
    )
    monkeypatch.setattr(queued_runner, "fetch_next_data_refresh_request_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 0)

    def fake_backfill(options):
        captured["run_id"] = options.run_id
        captured["llm_backfill"] = options.llm_backfill
        captured["use_llm"] = options.use_llm
        captured["limit"] = options.limit
        return 0

    monkeypatch.setattr(queued_runner, "run_llm_description_backfill", fake_backfill)

    assert queued_runner.main() == 0
    assert captured == {
        "run_id": "run-backfill",
        "llm_backfill": True,
        "use_llm": True,
        "limit": 11,
    }
    assert "LLM description backfill" in capsys.readouterr().out


def test_queued_runner_defaults_missing_llm_flag_to_automatic(monkeypatch, capsys) -> None:
    captured = {}

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: {"id": "run-1", "source": "all"})
    monkeypatch.setattr(queued_runner, "fetch_next_data_refresh_request_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 0)

    def fake_run_pipeline(options):
        captured["use_llm"] = options.use_llm
        captured["heavy_enrichment"] = options.heavy_enrichment
        return 0

    monkeypatch.setattr(queued_runner, "run_pipeline", fake_run_pipeline)

    assert queued_runner.main() == 0
    assert captured == {"use_llm": True, "heavy_enrichment": True}
    assert "llm=True" in capsys.readouterr().out


def test_queued_runner_forces_llm_for_legacy_disabled_scroll(monkeypatch, capsys) -> None:
    captured = {}

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(
        queued_runner,
        "fetch_next_queued_run_from_supabase",
        lambda: {"id": "run-legacy", "source": "all", "use_llm": False},
    )
    monkeypatch.setattr(queued_runner, "fetch_next_data_refresh_request_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 0)

    def fake_run_pipeline(options):
        captured["use_llm"] = options.use_llm
        captured["heavy_enrichment"] = options.heavy_enrichment
        return 0

    monkeypatch.setattr(queued_runner, "run_pipeline", fake_run_pipeline)

    assert queued_runner.main() == 0
    assert captured == {"use_llm": True, "heavy_enrichment": True}
    assert "llm=True" in capsys.readouterr().out


def test_queued_runner_processes_data_refresh_when_no_full_run(monkeypatch, capsys) -> None:
    finished = []
    calls = []
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/sale",
        city="Bordeaux",
        latitude=44.84,
        longitude=-0.57,
    )

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: None)
    monkeypatch.setattr(
        queued_runner,
        "fetch_next_data_refresh_request_from_supabase",
        lambda: {
            "id": "refresh-1",
            "source_url": "https://example.test/sale",
            "request_kind": "full",
        },
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"cadastre_api_url": "https://cadastre.test"})
    monkeypatch.setattr(
        queued_runner,
        "enrich_cadastre_sales",
        lambda sales, settings: calls.append(("cadastre", sales[0].source_url)) or [{"source_url": sales[0].source_url}],
    )
    monkeypatch.setattr(
        queued_runner,
        "enrich_dpe_sales",
        lambda sales, settings: calls.append(("dpe", sales[0].source_url)) or [{"source_url": sales[0].source_url}],
    )
    monkeypatch.setattr(queued_runner, "upsert_cadastre_parcels_to_supabase", lambda rows: len(rows))
    monkeypatch.setattr(queued_runner, "upsert_dpe_diagnostics_to_supabase", lambda rows: len(rows))
    monkeypatch.setattr(
        queued_runner,
        "finish_data_refresh_request_in_supabase",
        lambda request_id, status, summary=None, error_message=None: finished.append(
            (request_id, status, summary, error_message)
        ),
    )

    assert queued_runner.main() == 0
    assert calls == [
        ("cadastre", "https://example.test/sale"),
        ("dpe", "https://example.test/sale"),
    ]
    assert finished == [
        (
            "refresh-1",
            "completed",
            {
                "runner": "data_refresh_queue",
                "request_kind": "full",
                "source_url": "https://example.test/sale",
                "cadastre_rows": 1,
                "cadastre_upserted": 1,
                "dpe_rows": 1,
                "dpe_upserted": 1,
            },
            None,
        )
    ]
    assert "Completed Immojudis data refresh: refresh-1" in capsys.readouterr().out


def test_enrichment_queue_runs_pdf_before_fact_extraction_and_completes_jobs(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/enrichment-success",
            "documents": [{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
        }
    )
    calls: list[str] = []
    finished: list[tuple[str, bool, str | None]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [
            {"id": "job-pdf", "source_url": sale.source_url, "job_type": "pdf"},
            {"id": "job-facts", "source_url": sale.source_url, "job_type": "fact_extraction"},
        ],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(queued_runner, "enrich_sale_from_pdfs", lambda current: calls.append("pdf") or SimpleNamespace(errors=0))
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda current, client, **kwargs: calls.append("facts_then_display")
        or SimpleNamespace(unavailable=False, valid_json=1, error_messages=[]),
    )
    monkeypatch.setattr(queued_runner, "normalize_asset_features", lambda current: calls.append("normalize"))
    monkeypatch.setattr(
        queued_runner,
        "upsert_sales_to_supabase",
        lambda sales, refresh_last_seen: calls.append("upsert") or len(sales),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None: finished.append((job_id, succeeded, error_message)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=10) == 2
    assert calls == ["pdf", "facts_then_display", "normalize", "upsert"]
    assert finished == [("job-pdf", True, None), ("job-facts", True, None)]


def test_enrichment_queue_marks_every_sale_job_failed_on_extraction_error(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/enrichment-failure",
        }
    )
    finished: list[tuple[str, bool, str | None]] = []
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [
            {"id": "job-facts", "source_url": sale.source_url, "job_type": "fact_extraction"},
            {"id": "job-display", "source_url": sale.source_url, "job_type": "display_description"},
        ],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda current, client, **kwargs: SimpleNamespace(
            unavailable=False,
            valid_json=0,
            error_messages=["invalid structured response"],
        ),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None: finished.append((job_id, succeeded, error_message)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=10) == 2
    assert finished == [
        ("job-facts", False, "invalid structured response"),
        ("job-display", False, "invalid structured response"),
    ]


def test_enrichment_queue_does_not_pay_twice_for_scan_description(monkeypatch) -> None:
    prompt_version = "auction_llm_v9_qwen2_7b_scan_display"
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/already-summarized",
        description="Appartement de 42 m² situé à Bordeaux.",
        raw_payload={
            "llm_display_description": "Appartement de 42 m² situé à Bordeaux.",
            "llm_prompt_version": prompt_version,
        },
    )
    finished: list[tuple[str, bool, str | None]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [
            {
                "id": "job-display",
                "source_url": sale.source_url,
                "job_type": "display_description",
            }
        ],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(
        queued_runner,
        "load_settings",
        lambda: {
            "llm_extraction_mode": "display_description",
            "llm_prompt_version": prompt_version,
        },
    )
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("Replicate must not be called twice")),
    )
    monkeypatch.setattr(queued_runner, "normalize_asset_features", lambda current: current)
    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", lambda sales, refresh_last_seen: len(sales))
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None: finished.append((job_id, succeeded, error_message)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=10) == 1
    assert finished == [("job-display", True, None)]
