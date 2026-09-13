from __future__ import annotations

import logging
import os
import sys
import time
from collections import defaultdict

from src.admission import is_expired
from src.asset_normalization import normalize_asset_features
from src.cadastre import enrich_cadastre_sales
from src.config import load_settings
from src.dpe import enrich_dpe_sales
from src.enrichment.extract_structured import enrich_sale_with_llm
from src.enrichment.llm_client import create_llm_client
from src.freshness import documents_are_current
from src.geocode import geocode_sale
from src.information_agent_evidence import run_information_agent_evidence_batch
from src.main import (
    SOURCE_NAMES,
    PipelineOptions,
    _needs_llm_display_description_refresh,
    run_llm_description_backfill,
    run_pipeline,
)
from src.pdf_enrichment import PdfExtractionDeferred, enrich_sale_from_pdfs
from src.pipeline_usage import PipelineBudgetExhausted, defer_budget_jobs
from src.sale_procedure import classify_sale_procedure
from src.source_detail_worker import run_source_detail_jobs
from src.storage.supabase_client import (
    claim_auction_enrichment_jobs_family_from_supabase,
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
SOURCE_DETAIL_FAMILY = "source_detail"
ENRICHMENT_FAMILY = "enrichment"
ENRICHMENT_FAMILY_CYCLE = (SOURCE_DETAIL_FAMILY,) * 5 + (ENRICHMENT_FAMILY,)
ENRICHMENT_MAX_JOBS = 90
ENRICHMENT_BUDGET_SECONDS = 1200


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


def _finish_job(job: dict[str, object], **kwargs) -> None:
    # A worker whose lease expired must not finish a later worker's attempt.
    if job.get("attempt_count") is not None:
        kwargs["attempt_count"] = int(job["attempt_count"])
    if job.get("locked_at") is not None:
        kwargs["locked_at"] = job["locked_at"]
    finish_auction_enrichment_job_in_supabase(str(job.get("id") or ""), **kwargs)


def _claim_enrichment_queue_jobs(*, limit: int, family: str | None) -> list[dict[str, object]]:
    if family is None:
        # Keep the old call shape for manual/legacy callers and for workers
        # deployed before the family RPC migration.
        return claim_auction_enrichment_jobs_from_supabase(limit=limit)
    if family not in {SOURCE_DETAIL_FAMILY, ENRICHMENT_FAMILY}:
        raise ValueError(f"Unknown enrichment queue family: {family!r}")
    return claim_auction_enrichment_jobs_family_from_supabase(family=family, limit=limit)


def run_enrichment_queue_batch(
    *,
    limit: int,
    family: str | None = None,
    provider_clients: dict[str, object] | None = None,
) -> int:
    jobs = _claim_enrichment_queue_jobs(limit=limit, family=family)
    if not jobs:
        return 0
    settings = load_settings()
    if family == SOURCE_DETAIL_FAMILY:
        detail_jobs = [job for job in jobs if str(job.get("job_type") or "") == SOURCE_DETAIL_FAMILY]
        enrichment_jobs: list[dict[str, object]] = []
    elif family == ENRICHMENT_FAMILY:
        detail_jobs = []
        enrichment_jobs = [job for job in jobs if str(job.get("job_type") or "") != SOURCE_DETAIL_FAMILY]
    else:
        detail_jobs = [job for job in jobs if str(job.get("job_type") or "") == SOURCE_DETAIL_FAMILY]
        enrichment_jobs = [job for job in jobs if str(job.get("job_type") or "") != SOURCE_DETAIL_FAMILY]

    # Source details are deliberately completed before grouping the remaining
    # enrichment work.  Each regular group fetches its sale again below, so a
    # PDF/LLM job never writes a stale pre-detail catalogue snapshot.
    processed_detail_jobs = run_source_detail_jobs(
        detail_jobs,
        settings=settings,
        clients=provider_clients,
    )
    if not enrichment_jobs:
        return processed_detail_jobs

    jobs_by_sale: dict[str, list[dict[str, object]]] = defaultdict(list)
    for job in enrichment_jobs:
        source_url = str(job.get("source_url") or "")
        if source_url:
            jobs_by_sale[source_url].append(job)

    prompt_version = str(settings.get("llm_prompt_version") or "")
    llm_client = None

    for source_url, sale_jobs in jobs_by_sale.items():
        try:
            sale = fetch_sale_for_data_refresh(source_url)
        except Exception as exc:
            for job in sale_jobs:
                _finish_job(job, succeeded=False, error_message=str(exc))
            continue
        if sale is None:
            for job in sale_jobs:
                _finish_job(job,
                    succeeded=False,
                    error_message="sale not found",
                )
            continue
        if is_expired(sale) or sale.status in {'cancelled', 'withdrawn', 'adjudicated', 'quarantined'}:
            for job in sale_jobs:
                _finish_job(job, succeeded=True)
            continue
        job_types = {str(job.get("job_type") or "") for job in sale_jobs}
        try:
            if "pdf" in job_types and sale.documents and not documents_are_current(sale):
                pdf_stats = enrich_sale_from_pdfs(sale)
                if pdf_stats.errors or (sale.raw_payload.get("document_analysis") or {}).get("failed_documents"):
                    raise RuntimeError("Document extraction incomplete; retry required")
            if job_types & {"fact_extraction", "display_description"}:
                # The early scan upsert enqueues a safety-net job before the
                # inline Qwen call. If the final upsert already persisted the
                # current synthesis, completing that job without another paid
                # prediction prevents duplicate Replicate spend.
                description_current = bool(sale.raw_payload.get("llm_display_description")) and not sale.raw_payload.get("source_content_changed") and not _needs_llm_display_description_refresh(
                    sale,
                    prompt_version=prompt_version,
                )
                if not (description_current and "fact_extraction" not in job_types):
                    if llm_client is None:
                        llm_client = create_llm_client()
                    llm_stats = enrich_sale_with_llm(sale, client=llm_client, **({"extraction_mode": "structured_then_display"} if "fact_extraction" in job_types else {}))
                    if llm_stats.unavailable or not llm_stats.valid_json or getattr(llm_stats, "errors", 0):
                        detail = (
                            llm_stats.error_messages[-1]
                            if llm_stats.error_messages
                            else "LLM extraction incomplete"
                        )
                        raise RuntimeError(detail)
                    if not sale.raw_payload.get("llm_display_description") or _needs_llm_display_description_refresh(sale, prompt_version=prompt_version):
                        raise RuntimeError("Missing or stale display description")
                    if "fact_extraction" in job_types and not (sale.raw_payload.get("llm_fact_coverage") or {}).get("complete"):
                        raise RuntimeError("Fact extraction coverage incomplete")
            if "display_description" in job_types or "fact_extraction" in job_types:
                sale.raw_payload.pop("source_content_changed", None)
            if sale.latitude is None or sale.longitude is None:
                geocode_sale(sale)
            fill_tribunal(sale)
            classify_sale_procedure(sale)
            normalize_asset_features(sale)
            upsert_sales_to_supabase([sale], refresh_last_seen=False)
        except PdfExtractionDeferred as exc:
            if exc.progress_made:
                # OCR page checkpoints are real work, but they are not a
                # completed document. Requeue without consuming this job's
                # retry budget so the next worker continues from the page
                # cache. Only this sale's jobs are deferred.
                defer_budget_jobs(sale_jobs, exc)
                LOGGER.info(
                    "PDF extraction deferred after %s/%s pages for %s; %s new pages checkpointed",
                    exc.checkpointed_pages,
                    exc.total_pages,
                    source_url,
                    exc.new_progress_pages,
                )
            else:
                # A budget stop with no newly successful or explicitly blank
                # page must consume a normal bounded retry; otherwise a
                # permanently unreadable first page would loop forever.
                message = f"{exc}; no new page progress, retry budget consumed"
                LOGGER.warning("PDF extraction made no progress for %s", source_url)
                for job in sale_jobs:
                    _finish_job(job, succeeded=False, error_message=message)
            continue
        except PipelineBudgetExhausted as exc:
            defer_budget_jobs(enrichment_jobs, exc)
            LOGGER.info("Enrichment deferred without consuming retry attempts: %s", exc)
            # A general-lane budget exhaustion is a handled queue outcome. The
            # bounded lane worker must continue its detail slots, while the
            # default mixed-batch API keeps its historical completion count.
            return len(enrichment_jobs) if family == ENRICHMENT_FAMILY else processed_detail_jobs
        except Exception as exc:
            LOGGER.exception("Enrichment queue failed for %s: %s", source_url, exc)
            for job in sale_jobs:
                _finish_job(job,
                    succeeded=False,
                    error_message=str(exc),
                )
            continue
        for job in sale_jobs:
            _finish_job(job,
                succeeded=True,
            )
    return processed_detail_jobs + len(enrichment_jobs)


def run_enrichment_queue_worker(
    *,
    max_jobs: int | None = None,
    budget_seconds: int | None = None,
) -> int:
    """Run one fair, bounded queue worker using one claim per lane slot.

    Five source-detail slots are followed by one general enrichment slot. An
    empty preferred lane immediately gives its slot to the other lane. A
    deferred general job counts as handled so an exhausted AI budget cannot
    terminate the remaining source-detail work.
    """
    if max_jobs is None:
        max_jobs = min(
            ENRICHMENT_MAX_JOBS,
            max(1, int(os.getenv("PIPELINE_ENRICHMENT_MAX_JOBS", str(ENRICHMENT_MAX_JOBS)))),
        )
    else:
        max_jobs = min(ENRICHMENT_MAX_JOBS, max(1, int(max_jobs)))
    if budget_seconds is None:
        budget_seconds = min(
            ENRICHMENT_BUDGET_SECONDS,
            max(60, int(os.getenv("PIPELINE_ENRICHMENT_BUDGET_SECONDS", str(ENRICHMENT_BUDGET_SECONDS)))),
        )
    else:
        budget_seconds = max(0, min(ENRICHMENT_BUDGET_SECONDS, int(budget_seconds)))

    deadline = time.monotonic() + budget_seconds
    processed = 0
    provider_clients: dict[str, object] = {}
    for slot in range(max_jobs):
        if time.monotonic() >= deadline:
            break
        preferred = ENRICHMENT_FAMILY_CYCLE[slot % len(ENRICHMENT_FAMILY_CYCLE)]
        alternate = ENRICHMENT_FAMILY if preferred == SOURCE_DETAIL_FAMILY else SOURCE_DETAIL_FAMILY
        count = run_enrichment_queue_batch(
            limit=1,
            family=preferred,
            provider_clients=provider_clients,
        )
        if not count:
            count = run_enrichment_queue_batch(
                limit=1,
                family=alternate,
                provider_clients=provider_clients,
            )
        if not count:
            # Neither family is currently claimable. Avoid spinning against
            # paused/empty queues until the next scheduled worker.
            break
        processed += count
    return processed


if __name__ == "__main__":
    if "--enrichment-only" in sys.argv:
        # Claim one job at a time so each 30-minute lease is bounded by the
        # work immediately following its claim. GitHub serializes writers.
        processed = run_enrichment_queue_worker()
        print(f'Enrichment worker completed {processed} jobs within its bounded budget')
        sys.exit(0)
    sys.exit(main())
