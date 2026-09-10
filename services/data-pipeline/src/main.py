from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from src.asset_normalization import normalize_asset_features
from src.cadastre import enrich_cadastre_sales
from src.config import load_settings
from src.dedupe import merge_duplicate_sales
from src.dpe import enrich_dpe_sales
from src.enrichment.extract_structured import (
    LLMEnrichmentStats,
    apply_cached_llm_extraction_to_sale,
    enrich_sale_with_llm,
    extract_source_description,
)
from src.enrichment.llm_client import LLMClientUnavailable, create_llm_client
from src.enrichment.surface_reasoning import extract_and_apply_deterministic_surface_reasoning
from src.export import export_sales
from src.freshness import detail_is_fresh, documents_are_current, record_source_checks
from src.geocode import geocode_sale
from src.lifecycle import mark_past_sales
from src.models import AuctionSale
from src.normalize import clean_text, normalize_sale, parse_price
from src.outcome_ingestion.catalogue_bridge import bridge_auction_sales_before_cleanup
from src.pdf_enrichment import (
    DOCUMENT_FACTS_VERSION,
    PdfEnrichmentStats,
    classify_document_type,
    enrich_sale_from_pdfs,
)
from src.quality import (
    build_extraction_gap_report,
    build_quality_report,
    format_extraction_gap_report,
    format_quality_report,
)
from src.sale_procedure import classify_sale_procedure
from src.sources.agrasc import scrape_agrasc_aquitaine_result
from src.sources.avoventes import scrape_avoventes_aquitaine_result
from src.sources.cessions_etat import scrape_cessions_etat_aquitaine_result
from src.sources.common import ScrapeResult
from src.sources.encheres_immobilieres import scrape_encheres_immobilieres_aquitaine_result
from src.sources.encheres_publiques import scrape_encheres_publiques_aquitaine_result
from src.sources.info_encheres import scrape_info_encheres_aquitaine_result
from src.sources.licitor import scrape_licitor_aquitaine_result
from src.sources.notaires import scrape_notaires_aquitaine_result
from src.sources.petites_affiches import scrape_petites_affiches_aquitaine_result
from src.sources.vench import scrape_vench_aquitaine_result
from src.storage.supabase_client import (
    create_run_in_supabase,
    delete_expired_sales_in_supabase,
    delete_secondary_sales_in_supabase,
    delete_vench_sales_without_surface_in_supabase,
    fetch_enriched_content_hashes,
    fetch_known_sale_details,
    fetch_sales_needing_llm_descriptions,
    finish_run_in_supabase,
    mark_past_sales_in_supabase,
    reconcile_duplicate_sales_in_supabase,
    update_run_progress_in_supabase,
    upsert_cadastre_parcels_to_supabase,
    upsert_dpe_diagnostics_to_supabase,
    upsert_observations_to_supabase,
    upsert_sales_to_supabase,
)
from src.tribunal import fill_tribunal

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
LOGGER = logging.getLogger(__name__)
SOURCE_NAMES = (
    "avoventes",
    "licitor",
    "vench",
    "info_encheres",
    "encheres_publiques",
    "petites_affiches",
    "cessions_etat",
    "agrasc",
    "encheres_immobilieres",
    "notaires",
)
LLM_DISPLAY_FAILURE_KEYS = (
    "llm_display_error_at",
    "llm_display_error_prompt_version",
    "llm_display_error_message",
    "llm_display_error_count",
)

KNOWN_UNCHANGED_BACKFILL_FIELDS = (
    "source_urls",
    "tribunal",
    "tribunal_code",
    "department",
    "city",
    "address",
    "postal_code",
    "property_type",
    "title",
    "description",
    "surface_m2",
    "habitable_surface_m2",
    "land_surface_m2",
    "carrez_surface_m2",
    "app_surface_m2",
    "app_surface_kind",
    "surface_scope",
    "surface_source",
    "surface_confidence",
    "surface_evidence",
    "rooms_count",
    "bedrooms_count",
    "bathrooms_count",
    "parking_count",
    "has_garden",
    "has_terrace",
    "has_garage",
    "has_pool",
    "has_air_conditioning",
    "has_double_glazing",
    "visit_dates",
    "lawyer_name",
    "lawyer_contact",
    "status",
    "adjudication_price_eur",
    "documents",
    "latitude",
    "longitude",
    "occupancy_status",
    "risk_notes",
    "investment_score",
    "investment_summary",
    "score_version",
    "score_confidence",
    "score_factors",
    "quality_flags",
    "raw_text",
)

KNOWN_ENRICHMENT_PAYLOAD_FIELDS = (
    "source_blocks",
    "source_images",
    "raw_image_url",
    "source_description",
    "llm_extraction",
    "llm_fact_extraction",
    "llm_fact_prompt_version",
    "llm_display_prompt_version",
    "llm_fact_coverage",
    "llm_fact_context_coverage",
    "llm_display_description",
    "llm_display_description_word_count",
    "llm_prompt_version",
    "document_analysis",
    "surface_extraction",
    "surface_analysis",
    "land_surface_extraction",
    "investment_analysis",
    "llm_due_diligence",
)

KNOWN_DOCUMENT_BUILT_SURFACE_FIELDS = (
    "surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
)
KNOWN_DOCUMENT_LAND_SURFACE_FIELDS = ("land_surface_m2",)
KNOWN_DOCUMENT_SURFACE_METADATA_FIELDS = (
    "app_surface_m2",
    "app_surface_kind",
    "surface_scope",
    "surface_source",
    "surface_confidence",
    "surface_evidence",
)


@dataclass
class PipelineOptions:
    source: str = "all"
    use_llm: bool = True
    heavy_enrichment: bool = True
    upsert: bool = True
    limit: int | None = None
    run_id: str | None = None
    llm_backfill: bool = False
    llm_backfill_statuses: tuple[str, ...] = ("active", "upcoming")


def run_pipeline(options: PipelineOptions | None = None) -> int:
    options = options or PipelineOptions()
    settings = load_settings()
    run_id = create_run_in_supabase(options.source, options.use_llm, run_id=options.run_id) if options.upsert else None
    errors: dict[str, list[str]] = {source: [] for source in SOURCE_NAMES}
    raw_sales: list[dict[str, object]] = []
    raw_by_source = {source: 0 for source in SOURCE_NAMES}
    scrape_coverage: dict[str, dict[str, object]] = {}
    timings: dict[str, float] = {}

    # Données connues en base : Vench s'en sert comme fallback quand la page est
    # paywall/sparse ; seules les lignes scorées peuvent servir au skip détail.
    try:
        known_details: dict[str, dict[str, object]] = (
            fetch_known_sale_details()
            if (settings["incremental_enrichment"] and options.upsert and (options.heavy_enrichment or options.use_llm))
            else {}
        )
    except Exception as exc:
        LOGGER.exception("Known enriched sale lookup failed; publication aborted: %s", exc)
        errors.setdefault("supabase", []).append(str(exc))
        finish_run_in_supabase(run_id, "failed", {"stage": "known_sale_lookup"}, errors)
        return 1
    known_signatures = {
        source_url: str(row["_signature"])
        for source_url, row in known_details.items()
        if row.get("_signature") and row.get("score_version") and detail_is_fresh(row, source_url)
    }

    # ── Scraping des sources en parallèle ────────────────────────────────────
    # Chaque source est indépendante (domaine + client HTTP + délai propres), donc
    # on les lance en threads : le temps total ≈ la source la plus lente au lieu
    # de la somme. Indispensable avant de passer à toute la France.
    scrapers = _enabled_scrapers(
        options.source,
        settings,
        known_signatures,
        known_details,
        fetch_detail_heavy=options.heavy_enrichment,
    )
    scrape_overall_started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=max(1, len(scrapers))) as executor:
        futures = {executor.submit(_timed_scrape, name, fn): name for name, fn in scrapers.items()}
        for future in as_completed(futures):
            name = futures[future]
            try:
                result, seconds = future.result()
            except Exception as exc:
                LOGGER.exception("Scraper %s failed: %s", name, exc)
                errors.setdefault(name, []).append(str(exc))
                continue
            timings[f"scrape_{name}_seconds"] = seconds
            errors.setdefault(name, []).extend(result.errors)
            raw_by_source[name] = len(result.sales)
            scrape_coverage[name] = {
                **result.coverage,
                "duration_seconds": seconds,
                "configured_page_limit": _configured_page_limit(name, settings),
            }
            raw_sales.extend(result.sales)
    collection_failed = any(errors.get(name) for name in scrapers)
    coverage_incomplete = any(item.get("coverage_complete") is False for item in scrape_coverage.values())
    timings["scrape_total_seconds"] = round(time.perf_counter() - scrape_overall_started, 2)

    # Les scrapers peuvent sauter une fiche détail inchangée. On garde quand
    # même l'annonce dans le flux pour republier les champs app-ready, en
    # l'hydratant avec la dernière version riche connue afin de ne pas écraser
    # Supabase avec les seules données clairsemées de listing.
    skipped_detail = _hydrate_known_unchanged_sales(raw_sales, known_details)
    preserved_enrichment = _preserve_known_enrichment_payloads(raw_sales, known_details)
    timings["known_enrichment_payloads_preserved"] = preserved_enrichment
    record_source_checks([sale for sale in raw_sales if not errors.get(str(sale.get("source_name")))], known_details)

    if options.limit is not None:
        raw_sales = raw_sales[: options.limit]

    normalized_observations = []
    started = time.perf_counter()
    for raw_sale in raw_sales:
        try:
            sale = normalize_sale(raw_sale)
            normalized_observations.append(sale)
        except Exception as exc:
            LOGGER.exception("Initial normalization failed for %s: %s", raw_sale.get("source_url"), exc)
            source_name = str(raw_sale.get("source_name") or "unknown")
            errors.setdefault(source_name, []).append(str(exc))
    timings["normalize_seconds"] = round(time.perf_counter() - started, 2)

    canonical_sales = merge_duplicate_sales(normalized_observations)

    # ── Incrémental : éviter seulement le lourd déjà fait ─────────────────────
    # Les annonces continuent de passer dans la finalisation + upsert pour que
    # les champs récemment collectés (avocat, visites, images, source_blocks,
    # corrections de géocodage) arrivent jusqu'au read model.
    enriched_hashes: set[str] = set()
    current_llm_description_hashes: set[str] = set()
    if settings["incremental_enrichment"] and options.upsert and (options.heavy_enrichment or options.use_llm):
        content_hashes = [sale.content_hash for sale in canonical_sales if sale.content_hash]
        if options.heavy_enrichment:
            enriched_hashes = fetch_enriched_content_hashes(
                content_hashes,
                require_llm_description=False,
                require_document_analysis=True,
            )
        if options.use_llm:
            current_llm_description_hashes = fetch_enriched_content_hashes(
                content_hashes,
                require_llm_description=True,
                prompt_version=str(settings["llm_prompt_version"]),
            )
        if enriched_hashes:
            LOGGER.info(
                "Incrémental : %s content_hash déjà enrichis; OCR/LLM seront sautés mais les lignes seront republiées",
                len(enriched_hashes),
            )
        timings["incremental_enriched_hashes"] = len(enriched_hashes)
        timings["incremental_current_llm_hashes"] = len(current_llm_description_hashes)

    pdf_stats = PdfEnrichmentStats()
    llm_stats = LLMEnrichmentStats()
    llm_client = None
    # The public description is a lightweight product requirement of every
    # scan. PDF/OCR can be disabled independently with --no-heavy-enrichment;
    # only --no-llm explicitly disables the Replicate synthesis.
    if options.use_llm:
        try:
            llm_client = create_llm_client()
        except LLMClientUnavailable as exc:
            LOGGER.warning("LLM client unavailable: %s", exc)
            llm_stats.unavailable = True

    pdf_workers = max(1, int(settings["pipeline_pdf_workers"]))
    llm_workers = max(1, int(settings["pipeline_llm_workers"]))
    enrich_started = time.perf_counter()
    failed_urls: set[str] = set()

    for sale in canonical_sales:
        sale.last_run_id = run_id

    # Les ventes doivent être visibles même si PDF/OCR/LLM prend trop longtemps
    # ou échoue. On prépare donc une version exploitable par l'app, puis le lourd
    # ne fait qu'améliorer ces lignes.
    early_upserted = 0
    early_observations_upserted = 0
    app_ready: list[AuctionSale] = []
    started = time.perf_counter()
    for sale in canonical_sales:
        try:
            _finalize_sale_for_app(sale, geocode=False)
            app_ready.append(sale)
        except Exception as exc:
            LOGGER.exception("Light finalisation failed for %s: %s", sale.source_url, exc)
            errors.setdefault(str(sale.source_name or "unknown"), []).append(str(exc))
    timings["app_ready_seconds"] = round(time.perf_counter() - started, 2)
    lifecycle_stats = mark_past_sales(app_ready)

    if options.upsert and app_ready:
        try:
            started = time.perf_counter()
            early_upserted = upsert_sales_to_supabase(app_ready)
            early_observations_upserted = upsert_observations_to_supabase(app_ready)
            timings["early_supabase_seconds"] = round(time.perf_counter() - started, 2)
        except Exception as exc:
            LOGGER.exception("Early Supabase upsert failed: %s", exc)
            errors.setdefault("supabase", []).append(str(exc))
    early_publication_fingerprints = (
        _sale_publication_fingerprints(app_ready) if options.upsert and early_upserted > 0 else {}
    )

    cached_llm_display_refreshed = 0
    prompt_version = str(settings["llm_prompt_version"])
    if options.use_llm:
        for sale in app_ready:
            if _needs_llm_display_description_refresh(
                sale,
                prompt_version=prompt_version,
            ) and apply_cached_llm_extraction_to_sale(
                sale,
                prompt_version=prompt_version,
            ):
                cached_llm_display_refreshed += 1
    timings["llm_display_from_cached_extraction"] = cached_llm_display_refreshed

    pdf_targets = (
        [
            sale
            for sale in app_ready
            if _needs_structured_heavy_enrichment(sale)
            and not _heavy_enrichment_already_current(sale, enriched_hashes, use_llm=False)
        ]
        if options.heavy_enrichment
        else []
    )
    pdf_targets_before_limit = len(pdf_targets)
    pdf_targets = _limit_pdf_targets(pdf_targets, settings)
    timings["pdf_targets_before_limit"] = pdf_targets_before_limit
    timings["pdf_targets_deferred"] = max(0, pdf_targets_before_limit - len(pdf_targets))
    print(
        "Pipeline enrichment targets: "
        f"app_ready={len(app_ready)}, pdf_targets={len(pdf_targets)}, "
        f"pdf_deferred={timings['pdf_targets_deferred']}, "
        f"cached_llm_display_refreshed={cached_llm_display_refreshed}",
        flush=True,
    )

    # ── Phase 1 : PDF / Docling / OCR (CPU+RAM) — concurrence modérée ─────────
    started = time.perf_counter()
    if pdf_targets:
        with ThreadPoolExecutor(max_workers=pdf_workers) as executor:
            futures = {executor.submit(enrich_sale_from_pdfs, sale): sale for sale in pdf_targets}
            for future in as_completed(futures):
                sale = futures[future]
                try:
                    item_stats = future.result()
                    _merge_pdf_stats(pdf_stats, item_stats)
                    if item_stats.errors:
                        errors.setdefault("documents", []).append(f"{sale.source_url}: {item_stats.errors} document errors")
                except Exception as exc:
                    LOGGER.exception("PDF enrichment failed for %s: %s", sale.source_url, exc)
                    errors.setdefault(str(sale.source_name or "unknown"), []).append(str(exc))
                    failed_urls.add(sale.source_url)
    timings["pdf_seconds"] = round(time.perf_counter() - started, 2)

    # ── Phase 2 : LLM Replicate (réseau) — forte concurrence ─────────────────
    started = time.perf_counter()
    llm_targets = (
        [
            sale
            for sale in app_ready
            if _needs_llm_display_description_refresh(sale, prompt_version=prompt_version)
            and not _llm_description_already_current(sale, current_llm_description_hashes)
            and sale.source_url not in failed_urls
        ]
        if options.use_llm
        else []
    )
    llm_targets_before_limit = len(llm_targets)
    llm_targets = _limit_llm_targets(llm_targets, settings)
    timings["llm_targets_before_limit"] = llm_targets_before_limit
    timings["llm_targets_deferred"] = max(0, llm_targets_before_limit - len(llm_targets))
    print(
        "Pipeline LLM targets: "
        f"before_limit={llm_targets_before_limit}, selected={len(llm_targets)}, "
        f"deferred={timings['llm_targets_deferred']}",
        flush=True,
    )
    if options.use_llm and llm_client is not None and llm_targets:
        with ThreadPoolExecutor(max_workers=llm_workers) as executor:
            futures = {executor.submit(enrich_sale_with_llm, sale, client=llm_client): sale for sale in llm_targets}
            for future in as_completed(futures):
                sale = futures[future]
                try:
                    sale_llm_stats = future.result()
                except Exception as exc:
                    LOGGER.exception("LLM enrichment failed for %s: %s", sale.source_url, exc)
                    errors.setdefault(str(sale.source_name or "unknown"), []).append(str(exc))
                    continue
                _add_llm_stats(llm_stats, sale_llm_stats)
                if sale_llm_stats.error_messages:
                    source_name = str(sale.source_name or sale.primary_source or "unknown")
                    errors.setdefault(source_name, []).extend(sale_llm_stats.error_messages)
                    _mark_llm_description_failure(sale, sale_llm_stats, prompt_version=prompt_version)
                elif not _needs_llm_display_description_refresh(sale, prompt_version=prompt_version):
                    sale.raw_payload.pop("source_content_changed", None)
                    _clear_llm_description_failure(sale)
    timings["llm_seconds"] = round(time.perf_counter() - started, 2)

    # ── Phase 3 : finition (géocode réseau léger, tribunal, scoring) ─────────
    started = time.perf_counter()
    for sale in app_ready:
        try:
            _finalize_sale_for_app(sale)
        except Exception as exc:
            LOGGER.exception("Finalisation failed for %s: %s", sale.source_url, exc)
            errors.setdefault(str(sale.source_name or "unknown"), []).append(str(exc))
    timings["geocode_seconds"] = round(time.perf_counter() - started, 2)
    cadastre_rows: list[dict[str, object]] = []
    if options.upsert and app_ready and bool(settings.get("cadastre_enrich_enabled", False)):
        started = time.perf_counter()
        cadastre_rows = enrich_cadastre_sales(app_ready, settings=settings)
        timings["cadastre_seconds"] = round(time.perf_counter() - started, 2)
    timings["cadastre_rows"] = len(cadastre_rows)
    dpe_rows: list[dict[str, object]] = []
    if options.upsert and app_ready and bool(settings.get("dpe_enrich_enabled", False)):
        started = time.perf_counter()
        dpe_rows = enrich_dpe_sales(app_ready, settings=settings)
        timings["dpe_seconds"] = round(time.perf_counter() - started, 2)
    timings["dpe_rows"] = len(dpe_rows)
    timings["enrich_wall_seconds"] = round(time.perf_counter() - enrich_started, 2)
    timings["enrich_pdf_workers"] = pdf_workers
    timings["enrich_llm_workers"] = llm_workers
    timings["heavy_enrich_targets"] = len(pdf_targets)
    timings["pdf_targets"] = len(pdf_targets)
    timings["llm_targets"] = len(llm_targets)
    heavy_enrich_skipped = len(app_ready) - len(pdf_targets)
    timings["heavy_enrich_skipped"] = heavy_enrich_skipped

    enriched = app_ready
    lifecycle_stats.marked_past += mark_past_sales(enriched).marked_past
    quality_report = build_quality_report(enriched, pdf_stats=pdf_stats, llm_stats=llm_stats)
    extraction_gap_report = build_extraction_gap_report(enriched)
    json_path, csv_path = export_sales(enriched)

    upserted = 0
    observations_upserted = 0
    final_upserted = 0
    final_observations_upserted = 0
    cadastre_upserted = 0
    dpe_upserted = 0
    supabase_cleaned_past = 0
    supabase_deleted_secondary = 0
    supabase_reconciled_duplicates = 0
    supabase_deleted_expired = 0
    supabase_deleted_vench_without_surface = 0
    outcome_bridge_scanned = 0
    outcome_bridge_created = 0
    outcome_bridge_reused = 0
    publication_failed = False
    summary = {
        "collected": len(raw_sales),
        "collected_by_source": raw_by_source,
        "scrape_coverage": scrape_coverage,
        "normalized": len(normalized_observations),
        "deduplicated": len(canonical_sales),
        "skipped_detail": skipped_detail,
        "skipped_unchanged": heavy_enrich_skipped,
        "enriched": len(enriched),
        "quality_report": quality_report,
        "extraction_gap_report": extraction_gap_report,
        "timings": timings,
        "heavy_enrichment_enabled": options.heavy_enrichment,
        "stage_status": {
            "collection": "failed" if collection_failed else "partial" if coverage_incomplete else "unverified" if any(item.get("coverage_complete") is None for item in scrape_coverage.values()) else "complete",
            "enrichment": "partial" if pdf_stats.errors or llm_stats.errors or timings.get("pdf_targets_deferred") or timings.get("llm_targets_deferred") else "complete",
            "publication": "pending",
        },
    }
    if options.upsert:
        try:
            started = time.perf_counter()
            final_sales = _sales_changed_since_publication(app_ready, early_publication_fingerprints)
            timings["final_supabase_sales_changed"] = len(final_sales)
            if final_sales:
                final_upserted = upsert_sales_to_supabase(final_sales)
                final_observations_upserted = upsert_observations_to_supabase(final_sales)
            if app_ready:
                if cadastre_rows:
                    try:
                        cadastre_upserted = upsert_cadastre_parcels_to_supabase(cadastre_rows)
                    except Exception as exc:
                        LOGGER.exception("Cadastre Supabase upsert failed: %s", exc)
                        errors.setdefault("cadastre", []).append(str(exc))
                if dpe_rows:
                    try:
                        dpe_upserted = upsert_dpe_diagnostics_to_supabase(dpe_rows)
                    except Exception as exc:
                        LOGGER.exception("DPE Supabase upsert failed: %s", exc)
                        errors.setdefault("dpe", []).append(str(exc))
            upserted = max(early_upserted, final_upserted)
            observations_upserted = max(early_observations_upserted, final_observations_upserted)
            # Fail closed before every path below that can delete catalogue
            # rows. The database also rejects deletion of any unbridged sale.
            if collection_failed or coverage_incomplete:
                raise RuntimeError("Collection incomplete; catalogue cleanup is disabled.")
            outcome_bridge = bridge_auction_sales_before_cleanup(settings)
            outcome_bridge_scanned = outcome_bridge.scanned_count
            outcome_bridge_created = outcome_bridge.created_count
            outcome_bridge_reused = outcome_bridge.reused_count
            supabase_deleted_secondary = delete_secondary_sales_in_supabase(app_ready)
            # A targeted/bounded refresh must not maintain unrelated sources.
            if app_ready and options.source == "all" and options.limit is None:
                if settings.get("dedupe_reconcile_enabled", True):
                    supabase_reconciled_duplicates = reconcile_duplicate_sales_in_supabase(
                        limit=int(settings.get("dedupe_reconcile_max_rows") or 2000)
                    )
                supabase_cleaned_past = mark_past_sales_in_supabase()
                supabase_deleted_expired = delete_expired_sales_in_supabase()
                supabase_deleted_vench_without_surface = delete_vench_sales_without_surface_in_supabase()
            else:
                summary["global_cleanup_skipped"] = "targeted_or_bounded_collection"
            timings["supabase_seconds"] = round(time.perf_counter() - started, 2)
            summary.update(
                {
                    "upserted": upserted,
                    "observations_upserted": observations_upserted,
                    "early_upserted": early_upserted,
                    "early_observations_upserted": early_observations_upserted,
                    "final_upserted": final_upserted,
                    "final_observations_upserted": final_observations_upserted,
                    "cadastre_upserted": cadastre_upserted,
                    "dpe_upserted": dpe_upserted,
                    "outcome_bridge_scanned": outcome_bridge_scanned,
                    "outcome_bridge_created": outcome_bridge_created,
                    "outcome_bridge_reused": outcome_bridge_reused,
                    "marked_past_in_run": lifecycle_stats.marked_past,
                    "deleted_secondary_sales": supabase_deleted_secondary,
                    "reconciled_duplicate_sales": supabase_reconciled_duplicates,
                    "marked_past_in_supabase": supabase_cleaned_past,
                    "deleted_expired_sales": supabase_deleted_expired,
                    "deleted_vench_without_surface": supabase_deleted_vench_without_surface,
                }
            )
            summary["completion_status"] = "partial_success" if any(errors.values()) or timings.get("pdf_targets_deferred") or timings.get("llm_targets_deferred") else "complete"
            summary["stage_status"]["publication"] = "complete"
            finish_run_in_supabase(run_id, "succeeded", summary, errors)
        except Exception as exc:
            LOGGER.exception("Supabase upsert failed: %s", exc)
            errors.setdefault("supabase", []).append(str(exc))
            summary["stage_status"]["publication"] = "partial_or_failed"
            finish_run_in_supabase(run_id, "failed", summary, errors)
            publication_failed = True

    print("Immojudis data pipeline summary")
    print(f"- collected: {len(raw_sales)}")
    print(f"- collected_by_source: {raw_by_source}")
    print(f"- scrape_coverage: {scrape_coverage}")
    print(f"- normalized: {len(normalized_observations)}")
    print(f"- deduplicated: {len(canonical_sales)}")
    print(f"- skipped_detail: {skipped_detail}")
    print(f"- skipped_unchanged: {heavy_enrich_skipped}")
    print(f"- enriched: {len(enriched)}")
    print(f"- upserted: {upserted}")
    print(f"- observations_upserted: {observations_upserted}")
    print(f"- early_upserted: {early_upserted}")
    print(f"- final_upserted: {final_upserted}")
    print(f"- cadastre_upserted: {cadastre_upserted}")
    print(f"- dpe_upserted: {dpe_upserted}")
    print(f"- outcome_bridge_scanned: {outcome_bridge_scanned}")
    print(f"- outcome_bridge_created: {outcome_bridge_created}")
    print(f"- outcome_bridge_reused: {outcome_bridge_reused}")
    print(f"- marked_past_in_run: {lifecycle_stats.marked_past}")
    print(f"- deleted_secondary_sales: {supabase_deleted_secondary}")
    print(f"- reconciled_duplicate_sales: {supabase_reconciled_duplicates}")
    print(f"- marked_past_in_supabase: {supabase_cleaned_past}")
    print(f"- deleted_expired_sales: {supabase_deleted_expired}")
    print(f"- deleted_vench_without_surface: {supabase_deleted_vench_without_surface}")
    print(f"- json: {json_path}")
    print(f"- csv: {csv_path}")
    for line in format_quality_report(quality_report):
        print(line)
    for line in format_extraction_gap_report(extraction_gap_report):
        print(line)
    for key, value in timings.items():
        print(f"- timing_{key}: {value}")
    print(f"- errors: { {source: len(items) for source, items in errors.items()} }")
    return 1 if publication_failed else 0


def run_llm_description_backfill(options: PipelineOptions | None = None) -> int:
    options = options or PipelineOptions(llm_backfill=True)
    settings = load_settings()
    if not options.use_llm:
        print("LLM description backfill skipped: --no-llm was provided.")
        return 0

    limit = options.limit or int(settings["pipeline_llm_backfill_max_targets"])
    prompt_version = str(settings["llm_prompt_version"])
    timings: dict[str, float] = {}
    errors: dict[str, list[str]] = {"llm_backfill": []}

    started = time.perf_counter()
    sales = fetch_sales_needing_llm_descriptions(
        limit=limit,
        prompt_version=prompt_version,
        statuses=options.llm_backfill_statuses,
    )
    timings["fetch_seconds"] = round(time.perf_counter() - started, 2)
    if not sales:
        summary = {
            "mode": "llm_description_backfill",
            "selected": 0,
            "processed": 0,
            "updated": 0,
            "prompt_version": prompt_version,
            "statuses": list(options.llm_backfill_statuses),
            "timings": timings,
        }
        if options.upsert:
            finish_run_in_supabase(options.run_id, "succeeded", summary, errors)
        print("LLM description backfill summary")
        print("- selected: 0")
        print("- updated: 0")
        return 0

    run_id = create_run_in_supabase("llm-description-backfill", True, run_id=options.run_id) if options.upsert else None
    completed = 0
    progress_summary = _llm_backfill_progress_summary(
        selected=len(sales),
        completed=completed,
        llm_stats=LLMEnrichmentStats(),
        failed_sales=[],
        prompt_version=prompt_version,
        statuses=options.llm_backfill_statuses,
        timings=timings,
        phase="starting",
    )
    if options.upsert:
        update_run_progress_in_supabase(run_id, progress_summary, errors)

    try:
        llm_client = create_llm_client()
    except LLMClientUnavailable as exc:
        errors["llm_backfill"].append(str(exc))
        if options.upsert:
            finish_run_in_supabase(run_id, "failed", {"mode": "llm_description_backfill"}, errors)
        print(f"LLM description backfill failed: {exc}")
        return 1

    workers = max(1, int(settings["pipeline_llm_workers"]))
    progress_every = max(1, int(settings.get("pipeline_llm_backfill_progress_every") or 5))
    llm_stats = LLMEnrichmentStats()
    failed_sales: list[AuctionSale] = []
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(enrich_sale_with_llm, sale, client=llm_client): sale for sale in sales}
        for future in as_completed(futures):
            sale = futures[future]
            completed += 1
            try:
                sale_stats = future.result()
            except Exception as exc:
                LOGGER.exception("LLM description backfill failed for %s: %s", sale.source_url, exc)
                errors.setdefault(str(sale.source_name or "unknown"), []).append(str(exc))
                if options.upsert and _should_update_llm_backfill_progress(
                    completed,
                    total=len(sales),
                    every=progress_every,
                ):
                    update_run_progress_in_supabase(
                        run_id,
                        _llm_backfill_progress_summary(
                            selected=len(sales),
                            completed=completed,
                            llm_stats=llm_stats,
                            failed_sales=failed_sales,
                            prompt_version=prompt_version,
                            statuses=options.llm_backfill_statuses,
                            timings=timings,
                            phase="llm",
                        ),
                        errors,
                    )
                continue
            _add_llm_stats(llm_stats, sale_stats)
            if sale_stats.error_messages:
                errors.setdefault(str(sale.source_name or sale.primary_source or "unknown"), []).extend(
                    sale_stats.error_messages
                )
                if _mark_llm_description_failure(sale, sale_stats, prompt_version=prompt_version):
                    failed_sales.append(sale)
            elif not _needs_llm_display_description_refresh(sale, prompt_version=prompt_version):
                _clear_llm_description_failure(sale)
            if options.upsert and _should_update_llm_backfill_progress(
                completed,
                total=len(sales),
                every=progress_every,
            ):
                update_run_progress_in_supabase(
                    run_id,
                    _llm_backfill_progress_summary(
                        selected=len(sales),
                        completed=completed,
                        llm_stats=llm_stats,
                        failed_sales=failed_sales,
                        prompt_version=prompt_version,
                        statuses=options.llm_backfill_statuses,
                        timings=timings,
                        phase="llm",
                    ),
                    errors,
                )
    timings["llm_seconds"] = round(time.perf_counter() - started, 2)

    updated_sales = [
        sale for sale in sales if not _needs_llm_display_description_refresh(sale, prompt_version=prompt_version)
    ]
    upserted = 0
    upsert_candidates = _unique_sales_by_source_url([*updated_sales, *failed_sales])
    if options.upsert and upsert_candidates:
        started = time.perf_counter()
        upserted = upsert_sales_to_supabase(upsert_candidates)
        timings["supabase_seconds"] = round(time.perf_counter() - started, 2)

    summary = {
        "mode": "llm_description_backfill",
        "selected": len(sales),
        "completed": completed,
        "processed": llm_stats.analyzed,
        "valid_json": llm_stats.valid_json,
        "updated": len(updated_sales),
        "failed_marked": len(failed_sales),
        "upserted": upserted,
        "prompt_version": prompt_version,
        "statuses": list(options.llm_backfill_statuses),
        "timings": timings,
        "llm_errors": llm_stats.errors,
        "llm_unavailable": llm_stats.unavailable,
    }
    if options.upsert:
        status = "succeeded" if not llm_stats.unavailable else "failed"
        finish_run_in_supabase(run_id, status, summary, errors)

    print("LLM description backfill summary")
    print(f"- selected: {len(sales)}")
    print(f"- processed: {llm_stats.analyzed}")
    print(f"- valid_json: {llm_stats.valid_json}")
    print(f"- updated: {len(updated_sales)}")
    print(f"- failed_marked: {len(failed_sales)}")
    print(f"- upserted: {upserted}")
    for key, value in timings.items():
        print(f"- timing_{key}: {value}")
    print(f"- errors: { {source: len(items) for source, items in errors.items()} }")
    return 0 if not llm_stats.unavailable else 1


def _should_update_llm_backfill_progress(completed: int, *, total: int, every: int) -> bool:
    if completed <= 0:
        return False
    if completed >= total:
        return True
    return completed % max(1, every) == 0


def _llm_backfill_progress_summary(
    *,
    selected: int,
    completed: int,
    llm_stats: LLMEnrichmentStats,
    failed_sales: list[AuctionSale],
    prompt_version: str,
    statuses: tuple[str, ...],
    timings: dict[str, float],
    phase: str,
) -> dict[str, object]:
    return {
        "mode": "llm_description_backfill",
        "phase": phase,
        "selected": selected,
        "completed": completed,
        "processed": llm_stats.analyzed,
        "valid_json": llm_stats.valid_json,
        "failed_marked": len(failed_sales),
        "prompt_version": prompt_version,
        "statuses": list(statuses),
        "timings": timings,
        "llm_errors": llm_stats.errors,
        "llm_unavailable": llm_stats.unavailable,
        "last_progress_at": datetime.now(UTC).isoformat(),
    }


def _mark_llm_description_failure(
    sale: AuctionSale,
    stats: LLMEnrichmentStats,
    *,
    prompt_version: str,
) -> bool:
    if not stats.error_messages:
        return False
    if not isinstance(sale.raw_payload, dict):
        sale.raw_payload = {}
    previous_count = sale.raw_payload.get("llm_display_error_count")
    try:
        count = int(previous_count or 0)
    except (TypeError, ValueError):
        count = 0
    sale.raw_payload["llm_display_error_at"] = datetime.now(UTC).isoformat()
    sale.raw_payload["llm_display_error_prompt_version"] = prompt_version
    sale.raw_payload["llm_display_error_message"] = stats.error_messages[-1][:500]
    sale.raw_payload["llm_display_error_count"] = count + 1
    return True


def _clear_llm_description_failure(sale: AuctionSale) -> None:
    if not isinstance(sale.raw_payload, dict):
        return
    for key in LLM_DISPLAY_FAILURE_KEYS:
        sale.raw_payload.pop(key, None)


def _unique_sales_by_source_url(sales: list[AuctionSale]) -> list[AuctionSale]:
    seen: set[str] = set()
    unique: list[AuctionSale] = []
    for sale in sales:
        if sale.source_url in seen:
            continue
        seen.add(sale.source_url)
        unique.append(sale)
    return unique


def _hydrate_known_unchanged_sales(
    raw_sales: list[dict[str, object]],
    known_details: dict[str, dict[str, object]],
) -> int:
    skipped = 0
    for sale in raw_sales:
        if not sale.get("_known_unchanged"):
            continue
        skipped += 1
        source_url = str(sale.get("source_url") or "")
        known = known_details.get(source_url)
        if not known:
            continue
        _backfill_raw_sale_from_known_detail(sale, known)
    return skipped


def _preserve_known_enrichment_payloads(
    raw_sales: list[dict[str, object]],
    known_details: dict[str, dict[str, object]],
) -> int:
    preserved = 0
    for sale in raw_sales:
        source_url = str(sale.get("source_url") or "")
        known = known_details.get(source_url)
        if not known:
            continue
        preserved += _backfill_payload_fields_from_known(
            sale,
            known,
            keys=KNOWN_ENRICHMENT_PAYLOAD_FIELDS,
        )
        preserved += _backfill_document_surface_fields_from_known(sale, known)
        preserved += _backfill_document_price_from_known(sale, known)
    return preserved


def _backfill_document_surface_fields_from_known(
    sale: dict[str, object],
    known: dict[str, object],
) -> int:
    known_payload = known.get("raw_payload")
    if not isinstance(known_payload, dict):
        known_payload = {}
    built_extraction = known_payload.get("surface_extraction")
    land_extraction = known_payload.get("land_surface_extraction")
    has_built_document_surface = known.get("surface_source") == "pdf" or (
        isinstance(built_extraction, dict) and built_extraction.get("source") == "pdf"
    )
    has_land_document_surface = isinstance(land_extraction, dict) and land_extraction.get("source") == "pdf"
    if not has_built_document_surface and not has_land_document_surface:
        return 0

    fields: tuple[str, ...] = KNOWN_DOCUMENT_SURFACE_METADATA_FIELDS
    if has_built_document_surface:
        fields += KNOWN_DOCUMENT_BUILT_SURFACE_FIELDS
    if has_land_document_surface:
        fields += KNOWN_DOCUMENT_LAND_SURFACE_FIELDS

    copied = 0
    for key in fields:
        if _is_missing_raw_value(sale.get(key)) and not _is_missing_raw_value(known.get(key)):
            sale[key] = known[key]
            copied += 1
    return copied


def _backfill_document_price_from_known(
    sale: dict[str, object],
    known: dict[str, object],
) -> int:
    known_payload = known.get("raw_payload")
    if not isinstance(known_payload, dict):
        return 0
    extraction = known_payload.get("starting_price_extraction")
    if not isinstance(extraction, dict) or extraction.get("version") not in {
        DOCUMENT_FACTS_VERSION,
        "document_facts_v1_starting_price",
    }:
        return 0

    known_price = parse_price(known.get("starting_price_eur"))
    if known_price is None:
        return 0
    incoming_price = parse_price(sale.get("starting_price_eur"))
    status = extraction.get("status")
    rejected_price = parse_price(extraction.get("rejected_source_price_eur"))
    source_matches_rejected = status == "resolved" and rejected_price is not None and incoming_price == rejected_price
    if incoming_price is not None and incoming_price != known_price and not source_matches_rejected:
        return 0

    copied = 0
    if incoming_price != known_price:
        sale["starting_price_eur"] = known_price
        copied += 1
    if sale.get("starting_price_extraction") != extraction:
        sale["starting_price_extraction"] = extraction
        copied += 1
    known_facts_version = known_payload.get("document_facts_version") or extraction.get("version")
    if sale.get("document_facts_version") != known_facts_version:
        # Preserve the last version that actually analyzed the document. Do not
        # mark it current here: the version check must still schedule the new
        # surface-reasoning pass while the verified price remains protected.
        sale["document_facts_version"] = known_facts_version
        copied += 1
    return copied


def _backfill_raw_sale_from_known_detail(
    sale: dict[str, object],
    known: dict[str, object],
) -> None:
    for key in KNOWN_UNCHANGED_BACKFILL_FIELDS:
        if _is_missing_raw_value(sale.get(key)) and not _is_missing_raw_value(known.get(key)):
            sale[key] = known[key]

    _backfill_payload_fields_from_known(sale, known, keys=KNOWN_ENRICHMENT_PAYLOAD_FIELDS)


def _backfill_payload_fields_from_known(
    sale: dict[str, object],
    known: dict[str, object],
    *,
    keys: tuple[str, ...],
) -> int:
    known_payload = known.get("raw_payload")
    if not isinstance(known_payload, dict):
        return 0
    copied = 0
    for key in keys:
        if _is_missing_raw_value(sale.get(key)) and not _is_missing_raw_value(known_payload.get(key)):
            sale[key] = known_payload[key]
            copied += 1
    return copied


def _is_missing_raw_value(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _enabled_scrapers(
    source: str,
    settings: dict[str, object],
    known: dict[str, str],
    known_details: dict[str, dict[str, object]],
    fetch_detail_heavy: bool = True,
) -> dict[str, Callable[[], ScrapeResult]]:
    """Map of enabled source name → zero-arg scraper callable, honouring the
    requested source and the per-source benchmark toggles. `known` (source_url →
    change-signature) lets list-based scrapers skip detail pages of unchanged
    listings; licitor exposes price/date only on detail pages, so it always
    fetches."""
    candidates: list[tuple[str, bool, Callable[[], ScrapeResult]]] = [
        ("avoventes", True, lambda: scrape_avoventes_aquitaine_result(known=known)),
        (
            "licitor",
            bool(settings["enable_licitor_benchmark"]),
            lambda: scrape_licitor_aquitaine_result(
                max_pages=int(settings["licitor_max_pages"]),
                fetch_details=fetch_detail_heavy,
            ),
        ),
        (
            "vench",
            bool(settings["enable_vench_benchmark"]),
            lambda: scrape_vench_aquitaine_result(
                max_pages=int(settings["vench_max_pages"]),
                known=known,
                known_details=known_details,
            ),
        ),
        (
            "info_encheres",
            bool(settings["enable_info_encheres_benchmark"]),
            lambda: scrape_info_encheres_aquitaine_result(
                max_pages=int(settings["info_encheres_max_pages"]), known=known
            ),
        ),
        (
            "encheres_publiques",
            bool(settings["enable_encheres_publiques_benchmark"]),
            lambda: scrape_encheres_publiques_aquitaine_result(
                max_pages=int(settings["encheres_publiques_max_pages"]), known=known
            ),
        ),
        (
            "petites_affiches",
            bool(settings["enable_petites_affiches_benchmark"]),
            lambda: scrape_petites_affiches_aquitaine_result(known=known),
        ),
        (
            "cessions_etat",
            bool(settings["enable_cessions_etat_benchmark"]),
            lambda: scrape_cessions_etat_aquitaine_result(
                max_pages=int(settings["cessions_etat_max_pages"]), known=known
            ),
        ),
        (
            "agrasc",
            bool(settings["enable_agrasc_benchmark"]),
            lambda: scrape_agrasc_aquitaine_result(),
        ),
        (
            "encheres_immobilieres",
            bool(settings["enable_encheres_immobilieres_benchmark"]),
            lambda: scrape_encheres_immobilieres_aquitaine_result(
                max_pages=int(settings["encheres_immobilieres_max_pages"]),
                known=known,
            ),
        ),
        (
            "notaires",
            bool(settings["enable_notaires_benchmark"]),
            lambda: scrape_notaires_aquitaine_result(max_pages=int(settings["notaires_max_pages"])),
        ),
    ]
    enabled: dict[str, Callable[[], ScrapeResult]] = {}
    for name, benchmark_on, fn in candidates:
        if source == name or (source == "all" and benchmark_on):
            enabled[name] = fn
    return enabled


def _configured_page_limit(source_name: str, settings: dict[str, object]) -> int | None:
    key_by_source = {
        "licitor": "licitor_max_pages",
        "vench": "vench_max_pages",
        "info_encheres": "info_encheres_max_pages",
        "encheres_publiques": "encheres_publiques_max_pages",
        "cessions_etat": "cessions_etat_max_pages",
        "encheres_immobilieres": "encheres_immobilieres_max_pages",
        "notaires": "notaires_max_pages",
    }
    key = key_by_source.get(source_name)
    if not key:
        return None
    try:
        return int(settings[key])
    except (KeyError, TypeError, ValueError):
        return None


def _timed_scrape(name: str, fn: Callable[[], ScrapeResult]) -> tuple[ScrapeResult, float]:
    started = time.perf_counter()
    result = fn()
    return result, round(time.perf_counter() - started, 2)


def _finalize_sale_for_app(sale: AuctionSale, *, geocode: bool = True) -> None:
    source_description = extract_source_description(sale)
    if source_description:
        sale.raw_payload["source_description"] = source_description
    else:
        sale.raw_payload.pop("source_description", None)
    if geocode:
        geocode_sale(sale)
    fill_tribunal(sale)
    classify_sale_procedure(sale)
    surface_context = _surface_reasoning_context_for_sale(sale)
    if surface_context:
        extract_and_apply_deterministic_surface_reasoning(sale, surface_context)
    normalize_asset_features(sale)


def _surface_reasoning_context_for_sale(sale: AuctionSale) -> str:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    source_blocks = payload.get("source_blocks")
    block_values = list(source_blocks.values()) if isinstance(source_blocks, dict) else []
    values: list[object] = [
        sale.title,
        sale.description,
        sale.raw_text,
        payload.get("source_description"),
        *block_values,
    ]
    return clean_text("\n".join(str(value) for value in values if value)) or ""


def _needs_heavy_enrichment(
    sale: AuctionSale,
    *,
    use_llm: bool = True,
    prompt_version: str | None = None,
) -> bool:
    if use_llm and _needs_llm_display_description_refresh(sale, prompt_version=prompt_version):
        return True
    return _needs_structured_heavy_enrichment(sale)


def _needs_structured_heavy_enrichment(sale: AuctionSale) -> bool:
    if not sale.documents and not sale.raw_text:
        return False
    if sale.documents and (sale.raw_payload.get("document_facts_version") != DOCUMENT_FACTS_VERSION or not documents_are_current(sale)):
        return True
    has_surface = any(
        (
            sale.app_surface_m2,
            sale.habitable_surface_m2,
            sale.carrez_surface_m2,
            sale.surface_m2,
            sale.land_surface_m2,
        )
    )
    has_type = bool(sale.property_type and sale.property_type not in {"unknown", "other"})
    has_occupancy = bool(sale.occupancy_status and sale.occupancy_status != "unknown")
    needs_rooms = sale.property_type not in {"land", "parking"} and sale.rooms_count is None
    return not (has_surface and has_type and has_occupancy and not needs_rooms)


def _heavy_enrichment_already_current(
    sale: AuctionSale,
    enriched_hashes: set[str],
    *,
    use_llm: bool = True,
    prompt_version: str | None = None,
) -> bool:
    if sale.documents and (sale.raw_payload.get("document_facts_version") != DOCUMENT_FACTS_VERSION or not documents_are_current(sale)):
        return False
    if not sale.content_hash or sale.content_hash not in enriched_hashes:
        return False
    if use_llm and _needs_llm_display_description_refresh(sale, prompt_version=prompt_version):
        return False
    return True


def _llm_description_already_current(
    sale: AuctionSale,
    current_llm_description_hashes: set[str],
) -> bool:
    return bool(not sale.raw_payload.get("source_content_changed") and sale.content_hash and sale.content_hash in current_llm_description_hashes)


def _limit_llm_targets(
    llm_targets: list[AuctionSale],
    settings: dict[str, object],
) -> list[AuctionSale]:
    max_targets = int(settings.get("pipeline_llm_max_targets") or 0)
    if max_targets <= 0 or len(llm_targets) <= max_targets:
        return llm_targets
    return sorted(llm_targets, key=_llm_target_priority_key)[:max_targets]


def _limit_pdf_targets(
    pdf_targets: list[AuctionSale],
    settings: dict[str, object],
) -> list[AuctionSale]:
    max_targets = int(settings.get("pipeline_pdf_max_targets") or 0)
    if max_targets <= 0 or len(pdf_targets) <= max_targets:
        return pdf_targets
    return sorted(pdf_targets, key=_pdf_target_priority_key)[:max_targets]


def _pdf_target_priority_key(sale: AuctionSale) -> tuple[int, int, int, str, str]:
    has_surface = any(
        value is not None
        for value in (
            sale.app_surface_m2,
            sale.habitable_surface_m2,
            sale.carrez_surface_m2,
            sale.surface_m2,
            sale.land_surface_m2,
        )
    )
    document_types = {
        classify_document_type(str(document.get("label") or ""), str(document.get("url") or ""))
        for document in sale.documents
        if isinstance(document, dict)
    }
    has_official_document = bool(
        document_types
        & {
            "pv_huissier",
            "pv_notaire",
            "proces_verbal",
            "diagnostics_techniques",
            "cahier_conditions_vente",
            "conditions_vente",
        }
    )
    suspicious_price_rank = (
        0
        if (
            sale.starting_price_eur is not None
            and sale.starting_price_eur < 1000
            and "cahier_conditions_vente" in document_types
        )
        else 1
    )
    if not has_surface and has_official_document:
        document_rank = 0
    elif not has_surface and sale.documents:
        document_rank = 1
    elif has_official_document:
        document_rank = 2
    elif sale.documents:
        document_rank = 3
    else:
        document_rank = 4
    status_rank, sale_date, source_url = _llm_target_priority_key(sale)
    return suspicious_price_rank, document_rank, status_rank, sale_date, source_url


def _llm_target_priority_key(sale: AuctionSale) -> tuple[int, str, str]:
    status_rank = {
        "upcoming": 0,
        "unknown": 1,
        "adjudicated": 2,
        "past": 3,
    }.get(str(sale.status or ""), 2)
    sale_date = sale.sale_date.isoformat() if sale.sale_date else "9999-12-31T23:59:59"
    return (status_rank, sale_date, sale.source_url)


def _needs_llm_display_description_refresh(
    sale: AuctionSale,
    *,
    prompt_version: str | None = None,
) -> bool:
    if not _sale_has_llm_context(sale):
        return False
    display_description = clean_payload_text(sale.raw_payload.get("llm_display_description"))
    if not display_description:
        return True
    current_prompt_version = clean_payload_text(
        prompt_version if prompt_version is not None else load_settings().get("llm_prompt_version")
    )
    if not current_prompt_version:
        return False
    return clean_payload_text(sale.raw_payload.get("llm_prompt_version")) != current_prompt_version


def _sale_has_llm_context(sale: AuctionSale) -> bool:
    if extract_source_description(sale):
        return True
    if sale.documents:
        return True
    if any(
        clean_payload_text(value)
        for value in (
            sale.raw_text,
            sale.description,
            sale.title,
            sale.city,
            sale.address,
            sale.property_type,
            sale.occupancy_status,
            sale.risk_notes,
        )
    ):
        return True
    if any((sale.surface_m2, sale.app_surface_m2, sale.rooms_count, sale.bedrooms_count)):
        return True
    blocks = sale.raw_payload.get("source_blocks") if isinstance(sale.raw_payload, dict) else None
    return isinstance(blocks, dict) and any(clean_payload_text(value) for value in blocks.values())


def clean_payload_text(value: object | None) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _merge_pdf_stats(total: PdfEnrichmentStats, item: PdfEnrichmentStats) -> None:
    total.downloaded += item.downloaded
    total.errors += item.errors
    total.raw_text_enriched += item.raw_text_enriched
    total.document_cache_hits += item.document_cache_hits
    total.document_cache_misses += item.document_cache_misses
    total.documents_processed += item.documents_processed


def _add_llm_stats(total: LLMEnrichmentStats, item: LLMEnrichmentStats) -> None:
    total.analyzed += item.analyzed
    total.valid_json += item.valid_json
    total.errors += item.errors
    total.surface_extracted += item.surface_extracted
    total.surface_detected += item.surface_detected
    total.rooms_extracted += item.rooms_extracted
    total.rooms_detected += item.rooms_detected
    total.bedrooms_extracted += item.bedrooms_extracted
    total.bedrooms_detected += item.bedrooms_detected
    total.occupancy_extracted += item.occupancy_extracted
    total.occupancy_detected += item.occupancy_detected
    total.risks_detected += item.risks_detected
    total.fact_chunks_analyzed += item.fact_chunks_analyzed
    total.structured_surface_verified += item.structured_surface_verified
    total.calculated_surface_verified += item.calculated_surface_verified
    total.error_messages.extend(item.error_messages)
    total.unavailable = total.unavailable or item.unavailable


def _sale_publication_fingerprints(sales: list[AuctionSale]) -> dict[str, str]:
    return {sale.source_url: _sale_publication_fingerprint(sale) for sale in sales if sale.source_url}


def _sales_changed_since_publication(
    sales: list[AuctionSale],
    fingerprints: dict[str, str],
) -> list[AuctionSale]:
    if not fingerprints:
        return sales
    return [
        sale
        for sale in sales
        if not sale.source_url or fingerprints.get(sale.source_url) != _sale_publication_fingerprint(sale)
    ]


def _sale_publication_fingerprint(sale: AuctionSale) -> str:
    return json.dumps(
        sale.to_storage_dict(exclude_none=False),
        sort_keys=True,
        default=str,
        ensure_ascii=False,
    )


def run_from_options(options: PipelineOptions | None = None) -> int:
    options = options or PipelineOptions()
    if options.llm_backfill:
        return run_llm_description_backfill(options)
    return run_pipeline(options)


def parse_args(argv: list[str] | None = None) -> PipelineOptions:
    parser = argparse.ArgumentParser(description="Collecte et enrichit les ventes aux enchères en France.")
    parser.add_argument("--source", choices=("all", *SOURCE_NAMES), default="all")
    parser.add_argument("--no-llm", action="store_true", help="Désactive les appels LLM Replicate pour ce run.")
    parser.add_argument(
        "--no-heavy-enrichment",
        action="store_true",
        help=(
            "Publie les annonces sans PDF/OCR lourd. La synthèse Qwen courte reste active; "
            "ajoutez --no-llm pour la désactiver explicitement."
        ),
    )
    parser.add_argument("--no-upsert", action="store_true", help="N'écrit pas dans Supabase.")
    parser.add_argument("--limit", type=int, default=None, help="Limite le nombre d'annonces brutes traitées.")
    parser.add_argument(
        "--run-id",
        default=None,
        help="Reprend une ligne auction_runs existante, par exemple une demande créée depuis l'admin.",
    )
    parser.add_argument(
        "--backfill-llm-descriptions",
        action="store_true",
        help="Traite des annonces Supabase existantes sans synthèse IA publique, sans relancer le scrape.",
    )
    parser.add_argument(
        "--backfill-statuses",
        default="active,upcoming",
        help="Statuts ciblés par --backfill-llm-descriptions, séparés par des virgules.",
    )
    args = parser.parse_args(argv)
    return PipelineOptions(
        source=args.source,
        use_llm=not args.no_llm,
        heavy_enrichment=not args.no_heavy_enrichment,
        upsert=not args.no_upsert,
        limit=args.limit,
        run_id=args.run_id,
        llm_backfill=args.backfill_llm_descriptions,
        llm_backfill_statuses=tuple(part.strip() for part in args.backfill_statuses.split(",") if part.strip()),
    )


if __name__ == "__main__":
    sys.exit(run_from_options(parse_args()))
