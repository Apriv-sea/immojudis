from __future__ import annotations

import logging
import sys
import time
from collections import defaultdict
from datetime import UTC, datetime

from src.asset_normalization import normalize_asset_features
from src.cadastre import enrich_cadastre_sales
from src.config import load_settings
from src.dpe import enrich_dpe_sales
from src.enrichment.extract_structured import enrich_sale_with_llm
from src.enrichment.llm_client import LLMClientUnavailable, create_llm_client
from src.freshness import documents_are_current
from src.information_agent_evidence import run_information_agent_evidence_batch
from src.main import (
    SOURCE_NAMES,
    PipelineOptions,
    _needs_llm_display_description_refresh,
    run_llm_description_backfill,
    run_pipeline,
)
from src.pdf_enrichment import enrich_sale_from_pdfs
from src.sale_procedure import classify_sale_procedure
from src.storage.supabase_client import (
    claim_auction_enrichment_jobs_from_supabase,
    fail_stale_running_runs_in_supabase,
    fetch_next_data_refresh_request_from_supabase,
    fetch_next_queued_run_from_supabase,
    fetch_sale_for_data_refresh,
    finish_auction_enrichment_job_in_supabase,
    finish_data_refresh_request_in_supabase,
    finish_run_in_supabase,
    has_active_running_run_in_supabase,
    mark_past_sales_in_supabase,
    upsert_cadastre_parcels_to_supabase,
    upsert_dpe_diagnostics_to_supabase,
    upsert_sales_to_supabase,
)
from src.tribunal import fill_tribunal

LOGGER = logging.getLogger(__name__)
VALID_SOURCES = {"all", *SOURCE_NAMES}
LLM_BACKFILL_SOURCE = "llm-description-backfill"


def main() -> int:
    stale_failed = fail_stale_running_runs_in_supabase()
    if has_active_running_run_in_supabase():
        print(
            "Another Immojudis data run is already active. "
            f"Marked stale runs failed: {stale_failed}. Skipping this worker."
        )
        return 0

    run = fetch_next_queued_run_from_supabase()
    if not run:
        settings = load_settings()
        evidence_processed = run_information_agent_evidence_batch(
            limit=int(settings.get("information_agent_evidence_batch_size") or 5)
        )
        if evidence_processed:
            print(
                f"Processed information-agent evidence: {evidence_processed}. "
                f"Marked stale runs failed: {stale_failed}."
            )
            return 0
        refresh_request = fetch_next_data_refresh_request_from_supabase()
        if refresh_request:
            return run_data_refresh_request(refresh_request)
        if settings.get("pipeline_enrichment_queue_enabled"):
            processed = run_enrichment_queue_batch(
                limit=int(settings.get("pipeline_enrichment_queue_batch_size") or 10)
            )
            if processed:
                cleaned = mark_past_sales_in_supabase()
                print(
                    f"Processed enrichment queue jobs: {processed}. "
                    f"Marked past sales: {cleaned}. Marked stale runs failed: {stale_failed}."
                )
                return 0
        if settings.get("pipeline_idle_llm_backfill_enabled"):
            backfill_result = run_llm_description_backfill(
                PipelineOptions(
                    llm_backfill=True,
                    upsert=True,
                    limit=int(settings["pipeline_llm_backfill_max_targets"]),
                )
            )
            if backfill_result != 0:
                return backfill_result
        cleaned = mark_past_sales_in_supabase()
        print(
            f"No queued Immojudis data run found. "
            f"Marked past sales: {cleaned}. Marked stale runs failed: {stale_failed}."
        )
        return 0

    run_id = str(run.get("id") or "")
    source = str(run.get("source") or "all")
    # Every queued scroll must produce the public AI display description. Older
    # queued rows may still carry use_llm=false, so the worker treats the flag as
    # legacy metadata and enforces the current product rule here.
    use_llm = True

    if not run_id:
        print("Queued run has no id; skipping.")
        return 1

    if source == LLM_BACKFILL_SOURCE:
        print(f"Running queued Immojudis LLM description backfill: {run_id}")
        return run_llm_description_backfill(
            PipelineOptions(
                llm_backfill=True,
                use_llm=True,
                upsert=True,
                run_id=run_id,
                limit=_queued_backfill_limit(run),
            )
        )

    if source not in VALID_SOURCES:
        message = f"Invalid queued source: {source}"
        finish_run_in_supabase(run_id, "failed", {"runner": "github_actions_queue"}, {"runner": [message]})
        print(message)
        return 1

    heavy_enrichment = use_llm
    print(f"Running queued Immojudis data pipeline: {run_id} ({source}, llm={use_llm}, heavy={heavy_enrichment})")
    try:
        return run_pipeline(
            PipelineOptions(
                source=source,
                use_llm=use_llm,
                heavy_enrichment=heavy_enrichment,
                upsert=True,
                run_id=run_id,
            )
        )
    except Exception as exc:
        LOGGER.exception("Queued run failed: %s", exc)
        finish_run_in_supabase(
            run_id,
            "failed",
            {"runner": "github_actions_queue"},
            {"runner": [str(exc)]},
        )
        return 1


def _queued_backfill_limit(run: dict[str, object]) -> int | None:
    summary = run.get("summary")
    if not isinstance(summary, dict):
        return None
    value = summary.get("limit")
    if isinstance(value, int):
        return max(1, min(100, value))
    if isinstance(value, str) and value.strip().isdigit():
        return max(1, min(100, int(value)))
    return None


def run_data_refresh_request(request: dict[str, object]) -> int:
    request_id = str(request.get("id") or "")
    source_url = str(request.get("source_url") or "")
    request_kind = str(request.get("request_kind") or "full")
    if request_kind not in {"cadastre", "dpe", "full"}:
        message = f"Invalid data refresh kind: {request_kind}"
        finish_data_refresh_request_in_supabase(request_id, "failed", {"runner": "data_refresh_queue"}, message)
        print(message)
        return 1

    sale = fetch_sale_for_data_refresh(source_url)
    if sale is None:
        message = f"Sale not found for data refresh: {source_url}"
        finish_data_refresh_request_in_supabase(request_id, "failed", {"runner": "data_refresh_queue"}, message)
        print(message)
        return 1

    settings = load_settings()
    summary: dict[str, object] = {
        "runner": "data_refresh_queue",
        "request_kind": request_kind,
        "source_url": source_url,
    }
    print(f"Running Immojudis data refresh: {request_id} ({request_kind}, {source_url})")
    try:
        if request_kind in {"cadastre", "full"}:
            cadastre_rows = enrich_cadastre_sales([sale], settings=settings)
            summary["cadastre_rows"] = len(cadastre_rows)
            summary["cadastre_upserted"] = upsert_cadastre_parcels_to_supabase(cadastre_rows)
        if request_kind in {"dpe", "full"}:
            dpe_rows = enrich_dpe_sales([sale], settings=settings)
            summary["dpe_rows"] = len(dpe_rows)
            summary["dpe_upserted"] = upsert_dpe_diagnostics_to_supabase(dpe_rows)
    except Exception as exc:
        LOGGER.exception("Data refresh request failed: %s", exc)
        finish_data_refresh_request_in_supabase(request_id, "failed", summary, str(exc))
        return 1

    finish_data_refresh_request_in_supabase(request_id, "completed", summary)
    print(f"Completed Immojudis data refresh: {request_id}")
    return 0


def run_enrichment_queue_batch(*, limit: int) -> int:
    jobs = claim_auction_enrichment_jobs_from_supabase(limit=limit)
    if not jobs:
        return 0
    jobs_by_sale: dict[str, list[dict[str, object]]] = defaultdict(list)
    for job in jobs:
        source_url = str(job.get("source_url") or "")
        if source_url:
            jobs_by_sale[source_url].append(job)

    needs_llm = any(
        str(job.get("job_type") or "") in {"fact_extraction", "display_description"}
        for job in jobs
    )
    settings = load_settings()
    display_only_mode = str(settings.get("llm_extraction_mode") or "display_description") == "display_description"
    prompt_version = str(settings.get("llm_prompt_version") or "")
    llm_client = None
    if needs_llm:
        try:
            llm_client = create_llm_client()
        except LLMClientUnavailable as exc:
            for job in jobs:
                finish_auction_enrichment_job_in_supabase(
                    str(job.get("id") or ""),
                    succeeded=False,
                    error_message=str(exc),
                )
            return len(jobs)

    for source_url, sale_jobs in jobs_by_sale.items():
        sale = fetch_sale_for_data_refresh(source_url)
        if sale is None:
            for job in sale_jobs:
                finish_auction_enrichment_job_in_supabase(
                    str(job.get("id") or ""),
                    succeeded=False,
                    error_message="sale not found",
                )
            continue
        if sale.sale_date is not None and sale.sale_date < datetime.now(UTC):
            for job in sale_jobs:
                finish_auction_enrichment_job_in_supabase(str(job.get("id") or ""), succeeded=True)
            continue
        job_types = {str(job.get("job_type") or "") for job in sale_jobs}
        try:
            if "pdf" in job_types and sale.documents and not documents_are_current(sale):
                pdf_stats = enrich_sale_from_pdfs(sale)
                if pdf_stats.errors or (sale.raw_payload.get("document_analysis") or {}).get("failed_documents"):
                    raise RuntimeError("Document extraction incomplete; retry required")
            if job_types & {"fact_extraction", "display_description"}:
                if llm_client is None:
                    raise RuntimeError("LLM client unavailable")
                # The early scan upsert enqueues a safety-net job before the
                # inline Qwen call. If the final upsert already persisted the
                # current synthesis, completing that job without another paid
                # prediction prevents duplicate Replicate spend.
                description_current = not _needs_llm_display_description_refresh(
                    sale,
                    prompt_version=prompt_version,
                )
                if not (display_only_mode and description_current and "fact_extraction" not in job_types):
                    llm_stats = enrich_sale_with_llm(sale, client=llm_client, **({"extraction_mode": "structured_then_display"} if "fact_extraction" in job_types else {}))
                    if llm_stats.unavailable or not llm_stats.valid_json:
                        detail = (
                            llm_stats.error_messages[-1]
                            if llm_stats.error_messages
                            else "LLM extraction incomplete"
                        )
                        raise RuntimeError(detail)
            if "display_description" in job_types or "fact_extraction" in job_types:
                sale.raw_payload.pop("source_content_changed", None)
            fill_tribunal(sale)
            classify_sale_procedure(sale)
            normalize_asset_features(sale)
            upsert_sales_to_supabase([sale], refresh_last_seen=False)
        except Exception as exc:
            LOGGER.exception("Enrichment queue failed for %s: %s", source_url, exc)
            for job in sale_jobs:
                finish_auction_enrichment_job_in_supabase(
                    str(job.get("id") or ""),
                    succeeded=False,
                    error_message=str(exc),
                )
            continue
        for job in sale_jobs:
            finish_auction_enrichment_job_in_supabase(
                str(job.get("id") or ""),
                succeeded=True,
            )
    return len(jobs)


if __name__ == "__main__":
    if "--enrichment-only" in sys.argv:
        # Claim small batches so their 30-minute leases cannot expire while
        # waiting behind other expensive documents. GitHub serializes writers.
        deadline = time.monotonic() + 40 * 60
        while time.monotonic() < deadline:
            if not run_enrichment_queue_batch(limit=2):
                break
        sys.exit(0)
    sys.exit(main())
