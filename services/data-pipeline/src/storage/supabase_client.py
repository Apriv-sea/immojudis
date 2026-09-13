from __future__ import annotations

import hashlib
import json
import logging
import time
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
from supabase import Client, create_client

try:
    import psycopg
    from psycopg import sql
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - GitHub Actions installs psycopg on Python 3.11.
    psycopg = None
    sql = None
    Jsonb = None

from src.admission import has_price_or_surface, is_expired, quarantine_reason
from src.asset_normalization import (
    build_auction_features_row,
    build_auction_risk_rows_from_occurrences,
    build_auction_score_factor_rows,
    build_auction_surfaces_row,
    extract_risk_occurrences_from_text,
)
from src.config import LLM_EXTRACTIONS_DIR, PDF_TEXTS_DIR, load_settings
from src.court_competence import tribunal_reference_rows
from src.dedupe import merge_duplicate_sales
from src.enrichment.display_quality import has_current_display
from src.freshness import document_fingerprint, documents_are_current
from src.models import AuctionSale
from src.normalize import make_sale_signature
from src.pdf_enrichment import classify_document_type, sale_storage_id
from src.urban_planning import build_urban_planning_signal_rows

LOGGER = logging.getLogger(__name__)
POSTGREST_TIMEOUT = httpx.Timeout(120.0, connect=30.0)
POSTGREST_UPSERT_RETRIES = 5
POSTGREST_RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504, 520, 522, 524}
POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE = 50
POSTGRES_CONNECT_TIMEOUT = 15
EXPIRED_SALE_DELETE_TABLES = (
    "auction_observations",
    "auction_enrichment_jobs",
    "auction_surface_derivations",
    "auction_surface_measurements",
    "auction_documents",
    "auction_extractions",
    "auction_cadastre_parcels",
    "auction_dpe_diagnostics",
    "auction_risk_occurrences",
    "auction_urban_planning_signals",
    "auction_score_factors",
    "auction_risks",
    "auction_features",
    "auction_surfaces",
    "judicial_sales",
    "properties",
    "auction_sales",
)
POSTGRES_JSON_COLUMNS = {
    "source_urls",
    "visit_dates",
    "documents",
    "score_factors",
    "quality_flags",
    "raw_payload",
    "observations",
    "sale_procedure",
}
UPSERT_COLUMNS = (
    "source_name",
    "source_url",
    "primary_source",
    "source_urls",
    "dedupe_confidence",
    "external_id",
    "tribunal",
    "tribunal_code",
    "sale_venue_type",
    "sale_legal_framework",
    "sale_verification_status",
    "sale_procedure",
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
    "starting_price_eur",
    "sale_date",
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
    "raw_payload",
    "observations",
    "content_hash",
    "last_run_id",
)
PROPERTY_COLUMNS = (
    "source_url",
    "source_name",
    "primary_source",
    "source_urls",
    "external_id",
    "department",
    "city",
    "postal_code",
    "address",
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
    "occupancy_status",
    "latitude",
    "longitude",
    "raw_payload",
)
JUDICIAL_SALE_COLUMNS = (
    "source_url",
    "property_source_url",
    "source_name",
    "primary_source",
    "source_urls",
    "external_id",
    "tribunal",
    "tribunal_code",
    "starting_price_eur",
    "sale_date",
    "visit_dates",
    "status",
    "adjudication_price_eur",
    "source_lawyer_name",
    "source_lawyer_contact",
    "documents_count",
    "investment_score",
    "investment_summary",
    "score_version",
    "score_confidence",
    "score_factors",
    "quality_flags",
    "content_hash",
    "last_run_id",
    "raw_payload",
)
LLM_BACKFILL_SALE_SELECT = ",".join(
    (
        "id",
        *UPSERT_COLUMNS,
        "first_seen_at",
        "last_seen_at",
        "created_at",
        "updated_at",
    )
)
DEDUPLICATION_SALE_SELECT = ",".join(
    (
        *UPSERT_COLUMNS,
        "first_seen_at",
        "last_seen_at",
        "created_at",
        "updated_at",
    )
)


def get_supabase_client() -> Client | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return None
    return create_client(str(url), str(key))


_PUBLICATION_CONNECTION: ContextVar[Any] = ContextVar("publication_connection", default=None)


def _transaction_write(table: str, payload: list[dict[str, object]], on_conflict: str | None = None, *, ignore_conflicts: bool = False) -> None:
    connection = _PUBLICATION_CONNECTION.get()
    if not payload:
        return
    columns = list(dict.fromkeys(key for row in payload for key in row))
    names = sql.SQL(", ").join(sql.Identifier(column) for column in columns)
    statement = sql.SQL("insert into {} ({}) select {} from jsonb_populate_recordset(null::{}, %s)").format(
        sql.Identifier("public", table), names, names, sql.Identifier("public", table)
    )
    if on_conflict:
        keys = on_conflict.split(",")
        updates = [] if ignore_conflicts else [column for column in columns if column not in keys]
        statement += sql.SQL(" on conflict ({}) ").format(sql.SQL(", ").join(sql.Identifier(key) for key in keys))
        statement += (sql.SQL("do update set ") + sql.SQL(", ").join(
            sql.SQL("{} = excluded.{}").format(sql.Identifier(column), sql.Identifier(column)) for column in updates
        )) if updates else sql.SQL("do nothing")
    LOGGER.info("Publication write table=%s rows=%s", table, len(payload))
    connection.execute(statement, (Jsonb(_sanitize_postgrest_payload(payload)),))


def _enqueue_due_enrichment(sales: list[AuctionSale], url: str, key: str) -> None:
    settings = load_settings()
    prompt_version = str(settings.get("llm_prompt_version") or "")
    jobs = []
    for sale in sales:
        if sale.status not in {"active", "unknown", "upcoming", "postponed"} or quarantine_reason(sale):
            continue
        checks = sale.raw_payload.get("source_checks") or {}
        analysis = sale.raw_payload.get("document_analysis") or {}
        revision = hashlib.sha256(json.dumps([
            document_fingerprint(sale.documents),
            sorted((str(profile.get("url") or ""), str(profile.get("sha256") or "")) for profile in analysis.get("profiles", []) if isinstance(profile, dict)),
            prompt_version, str(settings.get("replicate_model") or ""),
            settings.get("llm_fact_prompt_version"), settings.get("llm_display_prompt_version"),
            sorted((url, check.get("fingerprint")) for url, check in checks.items()),
        ], sort_keys=True).encode()).hexdigest()
        kinds = []
        if sale.documents and not documents_are_current(sale):
            analysis = sale.raw_payload.get("document_analysis") or {}
            # A failed document keeps the same retry budget across daily scans.
            last_success = analysis.get("last_successful_check_at") or "initial"
            kinds.append(("pdf", revision + str(last_success), 30))
        if not _has_current_llm_description(sale.raw_payload, prompt_version) or sale.raw_payload.get("source_content_changed"):
            kinds.append(("display_description", revision, 20))
        analysis = sale.raw_payload.get("document_analysis") or {}
        if analysis.get("documents_extracted") and (
            not sale.app_surface_m2 or sale.occupancy_status in {None, "unknown"}
            or sale.raw_payload.get("source_conflicts")
            or (sale.raw_payload.get("surface_analysis") or {}).get("contradictions")
        ):
            kinds.append(("fact_extraction", revision, 25))
        for kind, fingerprint, priority in kinds:
            jobs.append({"source_url": sale.source_url, "job_type": kind,
                         "input_hash": "pipeline_v2:" + fingerprint,
                         # Queue ordering applies age and urgency to every generation.
                         "priority": priority})
    if jobs:
        if _PUBLICATION_CONNECTION.get() is not None:
            _transaction_write("auction_enrichment_jobs", jobs, "source_url,job_type,input_hash", ignore_conflicts=True)
        else:
            _postgrest_upsert(url, key, "auction_enrichment_jobs", jobs, "source_url,job_type,input_hash")


def upsert_sales_to_supabase(
    sales: list[AuctionSale],
    *,
    refresh_last_seen: bool = True,
) -> int:
    sales = [sale for sale in sales if has_price_or_surface(sale) and not is_expired(sale)]
    if not sales:
        return 0
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    if not url or not key:
        LOGGER.info("Supabase variables are missing; skipping upsert")
        return 0
    if db_url and _PUBLICATION_CONNECTION.get() is None and len(sales) > 25:
        committed = 0
        for offset in range(0, len(sales), 25):
            committed += upsert_sales_to_supabase(sales[offset:offset + 25], refresh_last_seen=refresh_last_seen)
            LOGGER.info("Publication committed %s/%s sales", committed, len(sales))
        return committed
    if db_url and _PUBLICATION_CONNECTION.get() is None:
        # All product tables for each bounded batch commit together. A failed transaction never falls
        # back to partially committed REST writes.
        with _postgres_connect(str(db_url)) as connection:
            connection.execute("select set_config('app.pipeline_queue_owner', 'python', true)")
            connection.execute("set local lock_timeout = '15s'")
            connection.execute("set local statement_timeout = '120s'")
            connection.execute("select pg_advisory_xact_lock(hashtextextended('immojudis:outcome_catalogue_bridge:v1',0))")
            if refresh_last_seen:
                from src.publication_identity import resolve_publication_identities
                sales = resolve_publication_identities(connection, sales)
                if not sales:
                    return 0
            if not refresh_last_seen:
                sales = _guard_enrichment_revision(connection, sales)
                if not sales:
                    return 0
            token = _PUBLICATION_CONNECTION.set(connection)
            try:
                result = upsert_sales_to_supabase(sales, refresh_last_seen=refresh_last_seen)
                return result
            finally:
                _PUBLICATION_CONNECTION.reset(token)
    return _write_sale_revisions(sales, settings, refresh_last_seen=refresh_last_seen)


def _write_sale_revisions(sales: list[AuctionSale], settings: dict, *, refresh_last_seen: bool) -> int:
    """Write all catalogue tables inside the caller's admission/version boundary."""
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    now = datetime.now(UTC).isoformat()
    payload = []
    for sale in sales:
        reason = quarantine_reason(sale)
        if reason:
            sale.raw_payload["publication_quarantine"] = reason
            sale.status = "quarantined"
        else:
            sale.raw_payload.pop("publication_quarantine", None)
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in UPSERT_COLUMNS}
        row["last_seen_at"] = now if refresh_last_seen else data.get("last_seen_at") or now
        row["updated_at"] = now
        payload.append(row)
    if not payload:
        return 0
    tribunal_rows = [{**row, "updated_at": now} for row in tribunal_reference_rows(sales)]
    if tribunal_rows:
        # The FK target must exist before auction_sales and judicial_sales are
        # written. Only evidence-gated Ministry assignments produce rows here.
        _postgrest_upsert(
            str(url),
            str(key),
            "tribunals",
            tribunal_rows,
            on_conflict="code",
        )
    if _PUBLICATION_CONNECTION.get() is not None:
        _transaction_write("auction_sales", payload, "source_url")
    else:
        _upsert_with_rest(str(url), str(key), payload)
    _sync_normalized_sale_tables_with_rest(
        str(url),
        str(key),
        sales,
        now,
        refresh_last_seen=refresh_last_seen,
    )
    _upsert_asset_tables_with_rest(str(url), str(key), sales, now)
    _enqueue_due_enrichment(sales, str(url), str(key))
    if refresh_last_seen and _PUBLICATION_CONNECTION.get() is not None:
        from src.collection_evidence import record_sale_decisions
        for run_id in {sale.last_run_id for sale in sales if sale.last_run_id}:
            run_sales = [sale for sale in sales if sale.last_run_id == run_id]
            record_sale_decisions(str(run_id), [sale for sale in run_sales if not quarantine_reason(sale)],
                                  decision="published", connection=_PUBLICATION_CONNECTION.get())
            for sale in (sale for sale in run_sales if quarantine_reason(sale)):
                record_sale_decisions(str(run_id), [sale], decision="quarantined",
                                      reason=quarantine_reason(sale), connection=_PUBLICATION_CONNECTION.get())
    return sum(not quarantine_reason(sale) for sale in sales)


def _guard_enrichment_revision(connection, sales: list[AuctionSale]) -> list[AuctionSale]:
    """Lock and compare before *any* parent/child write; never recreate a deleted sale."""
    retained = []
    for sale in sorted(sales, key=lambda item: item.source_url):
        current = connection.execute(
            "select updated_at from public.auction_sales where source_url=%s for update",
            (sale.source_url,),
        ).fetchone()
        if current is None or sale.updated_at is None or current[0] != sale.updated_at:
            LOGGER.warning("Discarding obsolete enrichment for %s", sale.source_url)
            continue
        retained.append(sale)
    return retained


def delete_secondary_sales_in_supabase(sales: list[AuctionSale]) -> int:
    """Delete merged source rows only from the post-bridge cleanup phase.

    ``upsert_sales_to_supabase`` deliberately performs no deletion: callers
    must first preserve every catalogue row in the Outcome Graph. The database
    deletion guard remains the final fail-closed protection.
    """
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    if not url or not key or not _secondary_source_urls(sales):
        return 0

    if db_url:
        try:
            return _delete_secondary_sale_rows_with_postgres(str(db_url), sales)
        except Exception as exc:
            LOGGER.warning(
                "Direct Postgres secondary sale cleanup failed; falling back to REST: %s",
                exc,
            )
    return _delete_secondary_sale_rows(str(url), str(key), sales)


def upsert_cadastre_parcels_to_supabase(rows: list[dict[str, object]]) -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        LOGGER.info("Supabase variables are missing; skipping cadastre upsert")
        return 0

    now = datetime.now(UTC).isoformat()
    payload = [
        _timestamped(dict(row), now)
        for row in rows
        if row.get("source_url") and row.get("parcel_key")
    ]
    if not payload:
        return 0

    _postgrest_upsert(
        str(url),
        str(key),
        "auction_cadastre_parcels",
        payload,
        on_conflict="source_url,parcel_key",
    )
    return len(payload)


def upsert_dpe_diagnostics_to_supabase(rows: list[dict[str, object]]) -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        LOGGER.info("Supabase variables are missing; skipping DPE upsert")
        return 0

    now = datetime.now(UTC).isoformat()
    payload = [
        _timestamped(dict(row), now)
        for row in rows
        if row.get("source_url") and row.get("diagnostic_number")
    ]
    if not payload:
        return 0

    _postgrest_upsert(
        str(url),
        str(key),
        "auction_dpe_diagnostics",
        payload,
        on_conflict="source_url,diagnostic_number",
    )
    return len(payload)


def create_run_in_supabase(source: str, use_llm: bool, run_id: str | None = None) -> str | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return None
    if run_id:
        return start_existing_run_in_supabase(run_id, source, use_llm)
    payload = {
        "status": "running",
        "source": source,
        "use_llm": use_llm,
        "started_at": datetime.now(UTC).isoformat(),
    }
    response = httpx.post(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        headers=_rest_headers(str(key), prefer="return=representation"),
        json=payload,
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase run creation failed: %s", response.text)
        return None
    rows = response.json()
    return rows[0]["id"] if rows else None


def start_existing_run_in_supabase(run_id: str, source: str, use_llm: bool) -> str | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return run_id
    payload = {
        "status": "running",
        "source": source,
        "use_llm": use_llm,
        "started_at": datetime.now(UTC).isoformat(),
        "finished_at": None,
    }
    response = httpx.patch(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={"id": f"eq.{run_id}"},
        headers=_rest_headers(str(key), prefer="return=minimal"),
        json=payload,
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase run start failed: %s", response.text)
        return None
    return run_id


def fetch_next_queued_run_from_supabase() -> dict[str, Any] | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        LOGGER.info("Supabase variables are missing; no queued run can be fetched")
        return None
    response = httpx.get(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={
            "select": "id,status,source,use_llm,started_at,created_at,summary,errors",
            "status": "eq.queued",
            "order": "created_at.asc",
            "limit": "1",
        },
        headers=_rest_headers(str(key), prefer="return=representation"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase queued run fetch failed: %s", response.text)
        return None
    rows = response.json()
    if not rows:
        return None
    return rows[0]


def claim_auction_enrichment_jobs_from_supabase(limit: int = 10) -> list[dict[str, Any]]:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return []
    response = httpx.post(
        f"{str(url).rstrip('/')}/rest/v1/rpc/claim_auction_enrichment_jobs",
        headers=_rest_headers(str(key), prefer="return=representation"),
        json={"p_limit": max(1, min(100, int(limit)))},
        timeout=30,
    )
    if response.is_error:
        response.raise_for_status()
    rows = response.json()
    return [row for row in rows if isinstance(row, dict)]


def finish_auction_enrichment_job_in_supabase(
    job_id: str,
    *,
    succeeded: bool,
    error_message: str | None = None,
    attempt_count: int | None = None,
) -> None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key or not job_id:
        return
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "status": "completed" if succeeded else "failed",
        "completed_at": now.isoformat() if succeeded else None,
        "locked_at": None,
        "last_error": None if succeeded else (error_message or "enrichment failed")[:1000],
        "updated_at": now.isoformat(),
    }
    if not succeeded:
        payload["next_attempt_at"] = (now + timedelta(minutes=30)).isoformat()
    response = httpx.patch(
        f"{str(url).rstrip('/')}/rest/v1/auction_enrichment_jobs",
        params={"id": f"eq.{job_id}", "status": "eq.running",
                **({"attempt_count": f"eq.{attempt_count}"} if attempt_count is not None else {})},
        headers=_rest_headers(str(key), prefer="return=minimal"),
        json=payload,
        timeout=30,
    )
    if response.is_error:
        response.raise_for_status()


def fetch_next_data_refresh_request_from_supabase() -> dict[str, Any] | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        LOGGER.info("Supabase variables are missing; no data refresh request can be fetched")
        return None
    endpoint = f"{str(url).rstrip('/')}/rest/v1/data_refresh_requests"
    response = httpx.get(
        endpoint,
        params={
            "select": "id,user_id,sale_id,source_url,request_kind,status,priority,requested_payload,created_at",
            "status": "eq.queued",
            "order": "priority.desc,created_at.asc",
            "limit": "1",
        },
        headers=_rest_headers(str(key), prefer="return=representation"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase data refresh request fetch failed: %s", response.text)
        return None
    rows = response.json()
    if not rows:
        return None

    request = rows[0]
    started_at = datetime.now(UTC).isoformat()
    patch = httpx.patch(
        endpoint,
        params={"id": f"eq.{request['id']}", "status": "eq.queued"},
        headers=_rest_headers(str(key), prefer="return=representation"),
        json={
            "status": "running",
            "started_at": started_at,
            "updated_at": started_at,
        },
        timeout=30,
    )
    if patch.is_error:
        LOGGER.warning("Supabase data refresh request lock failed: %s", patch.text)
        return None
    locked_rows = patch.json()
    return locked_rows[0] if locked_rows else {**request, "status": "running", "started_at": started_at}


def finish_data_refresh_request_in_supabase(
    request_id: str | None,
    status: str,
    result_summary: dict[str, Any] | None = None,
    error_message: str | None = None,
) -> None:
    if not request_id:
        return
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return
    now = datetime.now(UTC).isoformat()
    payload = {
        "status": status,
        "result_summary": result_summary or {},
        "error_message": error_message,
        "completed_at": now if status in {"completed", "failed", "cancelled"} else None,
        "updated_at": now,
    }
    response = httpx.patch(
        f"{str(url).rstrip('/')}/rest/v1/data_refresh_requests",
        params={"id": f"eq.{request_id}"},
        headers=_rest_headers(str(key), prefer="return=minimal"),
        json=_sanitize_postgrest_payload(payload),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase data refresh request finish failed: %s", response.text)


def fail_stale_running_runs_in_supabase(max_age_minutes: int = 190) -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return 0

    cutoff = datetime.now(UTC) - timedelta(minutes=max_age_minutes)
    response = httpx.get(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={
            "select": "id,summary,errors,started_at",
            "status": "eq.running",
            "started_at": f"lt.{cutoff.isoformat()}",
        },
        headers=_rest_headers(str(key), prefer="count=none"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase stale run fetch failed: %s", response.text)
        return 0

    rows = response.json()
    for row in rows:
        run_id = str(row.get("id") or "")
        if not run_id:
            continue
        summary = row.get("summary") if isinstance(row.get("summary"), dict) else {}
        errors = row.get("errors") if isinstance(row.get("errors"), dict) else {}
        runner_errors = errors.get("runner") if isinstance(errors.get("runner"), list) else []
        runner_errors = [
            *runner_errors,
            f"Run marqué failed automatiquement après {max_age_minutes} min sans fin GitHub Actions.",
        ]
        summary = {
            **summary,
            "stale_cleanup": {
                "max_age_minutes": max_age_minutes,
                "started_at": row.get("started_at"),
                "cleaned_at": datetime.now(UTC).isoformat(),
            },
        }
        finish_run_in_supabase(run_id, "failed", summary, {**errors, "runner": runner_errors})
    return len(rows)


def has_active_running_run_in_supabase(max_age_minutes: int = 190) -> bool:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return False

    cutoff = datetime.now(UTC) - timedelta(minutes=max_age_minutes)
    response = httpx.get(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={
            "select": "id",
            "status": "eq.running",
            "started_at": f"gte.{cutoff.isoformat()}",
            "limit": "1",
        },
        headers=_rest_headers(str(key), prefer="count=none"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase active run fetch failed: %s", response.text)
        return False
    return bool(response.json())


def finish_run_in_supabase(
    run_id: str | None,
    status: str,
    summary: dict[str, Any],
    errors: dict[str, list[str]] | None = None,
) -> None:
    if not run_id:
        return
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return
    payload = {
        "status": status,
        "finished_at": datetime.now(UTC).isoformat(),
        "summary": summary,
        "errors": errors or {},
    }
    response = httpx.patch(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={"id": f"eq.{run_id}"},
        headers=_rest_headers(str(key), prefer="return=minimal"),
        json=_sanitize_postgrest_payload(payload),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase run finish failed: %s", response.text)


def update_run_progress_in_supabase(
    run_id: str | None,
    summary: dict[str, Any],
    errors: dict[str, list[str]] | None = None,
) -> None:
    if not run_id:
        return
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return
    payload: dict[str, Any] = {"summary": summary}
    if errors is not None:
        payload["errors"] = errors
    response = httpx.patch(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={"id": f"eq.{run_id}", "status": "eq.running"},
        headers=_rest_headers(str(key), prefer="return=minimal"),
        json=_sanitize_postgrest_payload(payload),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase run progress update failed: %s", response.text)


def upsert_documents_to_supabase(sales: list[AuctionSale]) -> int:
    sales = [sale for sale in sales if has_price_or_surface(sale) and not is_expired(sale)]
    if not sales:
        return 0
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return 0
    rows = [row for sale in sales for row in _document_rows_for_sale(sale)]
    if not rows:
        return 0
    rows = _unique_rows_by_key(rows, "document_url")
    _postgrest_upsert(str(url), str(key), "auction_documents", rows, on_conflict="document_url")
    return len(rows)


def upsert_extractions_to_supabase(sales: list[AuctionSale]) -> int:
    sales = [sale for sale in sales if has_price_or_surface(sale) and not is_expired(sale)]
    if not sales:
        return 0
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return 0
    rows = [row for sale in sales for row in _extraction_rows_for_sale(sale)]
    if not rows:
        return 0
    _postgrest_upsert(str(url), str(key), "auction_extractions", rows, on_conflict="source_url,provider,input_hash")
    return len(rows)


def upsert_observations_to_supabase(sales: list[AuctionSale]) -> int:
    sales = [sale for sale in sales if has_price_or_surface(sale) and not is_expired(sale)]
    if not sales:
        return 0
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    if not url or not key:
        return 0
    now = datetime.now(UTC).isoformat()
    payload = []
    for sale in sales:
        observations = sale.observations or [
            {
                "source_name": sale.source_name,
                "source_url": sale.source_url,
                "external_id": sale.external_id,
                "raw_payload": sale.raw_payload,
            }
        ]
        for observation in observations:
            if not isinstance(observation, dict) or not observation.get("source_url"):
                continue
            payload.append(
                {
                    "source_name": observation.get("source_name") or sale.source_name,
                    "source_url": observation.get("source_url"),
                    "external_id": observation.get("external_id"),
                    "content_hash": sale.content_hash,
                    "canonical_source_url": sale.source_url,
                    "raw_payload": observation.get("raw_payload") or observation,
                    "observed_at": now,
                    "updated_at": now,
                }
            )
    if not payload:
        return 0
    if db_url:
        try:
            _postgres_upsert(str(db_url), "auction_observations", payload, on_conflict="source_url")
            return len(payload)
        except Exception as exc:
            LOGGER.warning("Direct Postgres auction_observations upsert failed; falling back to REST: %s", exc)
    _postgrest_upsert(str(url), str(key), "auction_observations", payload, on_conflict="source_url")
    return len(payload)


def fetch_enriched_content_hashes(
    content_hashes: list[str],
    *,
    require_llm_description: bool = False,
    require_document_analysis: bool = False,
    prompt_version: str | None = None,
) -> set[str]:
    """Return the subset of content_hashes already present and enriched in DB.

    Used for incremental runs: an unchanged listing (same content_hash) that was
    already scored does not need to be re-downloaded / re-OCR'd / re-sent to the
    LLM. We require score_version IS NOT NULL so partially-failed rows are
    re-processed. When LLM descriptions are required, a row is only considered
    current if the public display summary exists and was produced with the
    current prompt version.
    """
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    unique = [h for h in {h for h in content_hashes if h}]
    if not url or not key or not unique:
        return set()

    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    found: set[str] = set()
    for index in range(0, len(unique), 150):
        batch = unique[index : index + 150]
        try:
            response = httpx.get(
                endpoint,
                params={
                    "select": "content_hash,raw_payload",
                    "content_hash": _postgrest_in_filter(batch),
                    "score_version": "not.is.null",
                },
                headers=_rest_headers(str(key), prefer="count=none"),
                timeout=30,
            )
            if response.is_error:
                LOGGER.warning(
                    "Could not fetch enriched hashes (%s): %s", response.status_code, response.text[:200]
                )
                continue
            for row in response.json():
                value = row.get("content_hash")
                if value and (
                    (not require_llm_description or _has_current_llm_description(row.get("raw_payload"), prompt_version))
                    and (not require_document_analysis or _has_current_document_analysis(row.get("raw_payload")))
                ):
                    found.add(str(value))
        except httpx.HTTPError as exc:
            LOGGER.warning("Enriched-hash lookup failed: %s", exc)
    return found


def _has_current_document_analysis(raw_payload: object) -> bool:
    if not isinstance(raw_payload, dict):
        return False
    analysis = raw_payload.get("document_analysis")
    if not isinstance(analysis, dict):
        return False
    try:
        listed = int(analysis.get("documents_listed") or 0)
        extracted = int(analysis.get("documents_extracted") or 0)
    except (TypeError, ValueError):
        return False
    if listed > 0:
        return extracted > 0
    return analysis.get("coverage_status") == "source_only"


def fetch_sales_needing_llm_descriptions(
    *,
    limit: int,
    prompt_version: str,
    statuses: tuple[str, ...] = ("active", "upcoming"),
) -> list[AuctionSale]:
    """Fetch existing DB rows whose public LLM description needs backfill.

    Regular scrape runs only see listings collected during that run. This helper
    lets a bounded worker gradually cover older active/upcoming rows without
    making the main scrape run longer.
    """
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key or limit <= 0:
        return []

    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    page_size = max(50, min(250, limit * 4))
    selected: list[AuctionSale] = []
    offset = 0
    failure_cooldown_hours = float(settings.get("pipeline_llm_failure_cooldown_hours") or 24)

    while len(selected) < limit:
        params: dict[str, str] = {
            "select": LLM_BACKFILL_SALE_SELECT,
            "order": "sale_date.asc.nullslast,updated_at.desc.nullslast",
            "limit": str(page_size),
            "offset": str(offset),
        }
        if statuses:
            params["status"] = _postgrest_in_filter(list(statuses))

        try:
            response = httpx.get(
                endpoint,
                params=params,
                headers=_rest_headers(str(key), prefer="count=none"),
                timeout=POSTGREST_TIMEOUT,
            )
        except httpx.HTTPError as exc:
            LOGGER.warning("LLM backfill sale fetch failed: %s", exc)
            break
        if response.is_error:
            LOGGER.warning("LLM backfill sale fetch failed (%s): %s", response.status_code, response.text[:300])
            break

        rows = response.json()
        if not rows:
            break
        for row in rows:
            if _has_current_llm_description(row.get("raw_payload"), prompt_version):
                continue
            if _has_recent_llm_description_failure(
                row.get("raw_payload"),
                prompt_version=prompt_version,
                cooldown_hours=failure_cooldown_hours,
            ):
                continue
            sale = _auction_sale_from_row(row)
            if sale is not None and has_price_or_surface(sale) and not is_expired(sale):
                selected.append(sale)
            if len(selected) >= limit:
                break
        if len(rows) < page_size:
            break
        offset += page_size

    return selected[:limit]


def _auction_sale_from_row(row: dict[str, Any]) -> AuctionSale | None:
    try:
        return AuctionSale.model_validate(row)
    except Exception as exc:
        LOGGER.warning("Could not hydrate auction sale %s for LLM backfill: %s", row.get("source_url"), exc)
        return None


def reconcile_duplicate_sales_in_supabase(
    *,
    statuses: tuple[str, ...] = ("active", "upcoming", "unknown"),
    limit: int | None = None,
) -> int:
    """Merge historical duplicate rows that are not necessarily in today's scrape.

    The in-run dedupe only sees the current source payload. If a source no
    longer republishes a listing detail, an older duplicate row can remain in
    Supabase. This bounded sweep reuses the same merge rules on existing
    active/upcoming rows, updates the canonical row, then deletes secondary
    source URLs.
    """
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    if not url or not key:
        return 0
    max_rows = limit if limit is not None else int(settings.get("dedupe_reconcile_max_rows") or 2000)
    if max_rows <= 0:
        return 0

    sales = _fetch_dedupe_candidate_sales(str(url), str(key), statuses=statuses, limit=max_rows)
    if len(sales) < 2:
        return 0

    merged = merge_duplicate_sales(sales)
    secondary_urls = _secondary_source_urls(merged)
    if not secondary_urls:
        return 0

    impacted_urls = set(secondary_urls)
    impacted_sales = [
        sale
        for sale in merged
        if any(source_url in impacted_urls for source_url in sale.source_urls if source_url)
    ]
    if not impacted_sales:
        return 0

    now = datetime.now(UTC).isoformat()
    payload = []
    for sale in impacted_sales:
        reason = quarantine_reason(sale)
        if reason:
            sale.raw_payload["publication_quarantine"] = reason
            sale.status = "quarantined"
        else:
            sale.raw_payload.pop("publication_quarantine", None)
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in UPSERT_COLUMNS}
        row["updated_at"] = now
        row["last_seen_at"] = data.get("last_seen_at") or now
        payload.append(row)

    if db_url:
        try:
            _postgres_upsert(str(db_url), "auction_sales", payload, on_conflict="source_url")
            deleted = _delete_secondary_sale_rows_with_postgres(str(db_url), impacted_sales)
            _sync_normalized_sale_tables_with_rest(str(url), str(key), impacted_sales, now)
            _upsert_asset_tables_with_rest(str(url), str(key), impacted_sales, now)
            return deleted
        except Exception as exc:
            LOGGER.warning("Direct Postgres duplicate reconciliation failed; falling back to REST: %s", exc)

    _upsert_with_rest(str(url), str(key), payload)
    deleted = _delete_secondary_sale_rows(str(url), str(key), impacted_sales)
    _sync_normalized_sale_tables_with_rest(str(url), str(key), impacted_sales, now)
    _upsert_asset_tables_with_rest(str(url), str(key), impacted_sales, now)
    return deleted


def _fetch_dedupe_candidate_sales(
    supabase_url: str,
    api_key: str,
    *,
    statuses: tuple[str, ...],
    limit: int,
) -> list[AuctionSale]:
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/auction_sales"
    rows: list[dict[str, Any]] = []
    offset = 0
    page_size = min(1000, max(100, limit))
    while len(rows) < limit:
        params: dict[str, str] = {
            "select": DEDUPLICATION_SALE_SELECT,
            "order": "sale_date.asc.nullslast,updated_at.desc.nullslast",
            "limit": str(min(page_size, limit - len(rows))),
            "offset": str(offset),
        }
        if statuses:
            params["status"] = _postgrest_in_filter(list(statuses))
        try:
            response = httpx.get(
                endpoint,
                params=params,
                headers=_rest_headers(api_key, prefer="count=none"),
                timeout=POSTGREST_TIMEOUT,
            )
        except httpx.HTTPError as exc:
            LOGGER.warning("Supabase duplicate reconciliation fetch failed: %s", exc)
            break
        if response.is_error:
            LOGGER.warning(
                "Supabase duplicate reconciliation fetch failed (%s): %s",
                response.status_code,
                response.text[:300],
            )
            break
        page_rows = response.json()
        if not page_rows:
            break
        rows.extend(row for row in page_rows if isinstance(row, dict))
        if len(page_rows) < page_size:
            break
        offset += page_size

    sales: list[AuctionSale] = []
    for row in rows[:limit]:
        sale = _auction_sale_from_row(row)
        if sale is not None:
            sales.append(sale)
    return sales


def _has_current_llm_description(raw_payload: Any, prompt_version: str | None) -> bool:
    return has_current_display(raw_payload, prompt_version)


def _has_recent_llm_description_failure(
    raw_payload: Any,
    *,
    prompt_version: str,
    cooldown_hours: float,
) -> bool:
    if cooldown_hours <= 0 or not isinstance(raw_payload, dict):
        return False
    if raw_payload.get("llm_display_error_prompt_version") != prompt_version:
        return False
    error_at = raw_payload.get("llm_display_error_at")
    if not isinstance(error_at, str) or not error_at.strip():
        return False
    try:
        parsed = datetime.fromisoformat(error_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return datetime.now(UTC) - parsed.astimezone(UTC) < timedelta(hours=cooldown_hours)


KNOWN_SALE_DETAIL_SELECT = ",".join(
    (
        "source_url",
        "source_urls",
        "sale_date",
        "starting_price_eur",
        "visit_dates",
        "lawyer_name",
        "lawyer_contact",
        "status",
        "adjudication_price_eur",
        "score_version",
        "score_confidence",
        "score_factors",
        "quality_flags",
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
        "occupancy_status",
        "documents",
        "raw_text",
        "raw_payload",
    )
)
# Enrichment writes the full record back: a partial SELECT would erase price,
# procedure, dates and other facts that the worker did not actually re-extract.
DATA_REFRESH_SALE_SELECT = ",".join(dict.fromkeys((
    "id", "created_at", "updated_at", "first_seen_at", "last_seen_at", *UPSERT_COLUMNS,
)))

KNOWN_SALE_DETAIL_PAGE_SIZE = 100


def fetch_sale_for_data_refresh(source_url: str) -> AuctionSale | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key or not source_url:
        return None

    response = httpx.get(
        f"{str(url).rstrip('/')}/rest/v1/auction_sales",
        params={
            "select": DATA_REFRESH_SALE_SELECT,
            "source_url": f"eq.{source_url}",
            "limit": "1",
        },
        headers=_rest_headers(str(key), prefer="count=none"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase data refresh sale lookup failed: %s", response.text[:200])
        return None
    rows = response.json()
    if not rows:
        return None
    row = rows[0]
    if not row.get("source_name") or not row.get("source_url"):
        return None
    return AuctionSale(**row)


def fetch_known_sale_details() -> dict[str, dict[str, Any]]:
    """Map every known source URL to DB fields available for fallback."""
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return {}

    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    details: dict[str, dict[str, Any]] = {}
    offset = 0
    while True:
        try:
            response = httpx.get(
                endpoint,
                params={
                    "select": KNOWN_SALE_DETAIL_SELECT,
                    "limit": str(KNOWN_SALE_DETAIL_PAGE_SIZE),
                    "offset": str(offset),
                },
                headers=_rest_headers(str(key), prefer="count=none"),
                timeout=30,
            )
            if response.is_error:
                raise RuntimeError(
                    f"Could not fetch known sale details ({response.status_code}): {response.text[:200]}"
                )
            rows = response.json()
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Known sale detail lookup failed: {exc}") from exc
        for row in rows:
            row["_signature"] = make_sale_signature(row.get("sale_date"), row.get("starting_price_eur"))
            for source_url in _known_source_urls(row):
                details.setdefault(source_url, row)
        if len(rows) < KNOWN_SALE_DETAIL_PAGE_SIZE:
            break
        offset += KNOWN_SALE_DETAIL_PAGE_SIZE
    return details


def fetch_known_sale_signatures() -> dict[str, str]:
    """Map source_url → change-signature for already-enriched listings."""
    return {
        source_url: str(row["_signature"])
        for source_url, row in fetch_known_sale_details().items()
        if row.get("_signature") and row.get("score_version")
    }


def _known_source_urls(row: dict[str, Any]) -> list[str]:
    urls = [row.get("source_url")]
    if isinstance(row.get("source_urls"), list):
        urls.extend(row["source_urls"])
    elif isinstance(row.get("source_urls"), dict):
        urls.extend(row["source_urls"].values())
    return [str(url) for url in urls if url]


def touch_last_seen_for_source_urls(source_urls: list[str]) -> int:
    """Refresh last_seen_at for listings whose detail fetch was skipped. Best effort."""
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    unique = [u for u in {u for u in source_urls if u}]
    if not url or not key or not unique:
        return 0

    now = datetime.now(UTC).isoformat()
    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    touched = 0
    for index in range(0, len(unique), 150):
        batch = unique[index : index + 150]
        try:
            response = httpx.patch(
                endpoint,
                params={"source_url": _postgrest_in_filter(batch)},
                headers=_rest_headers(str(key), prefer="return=minimal"),
                json={"last_seen_at": now},
                timeout=30,
            )
            if not response.is_error:
                touched += len(batch)
        except httpx.HTTPError as exc:
            LOGGER.warning("last_seen touch (source_url) failed: %s", exc)
    return touched


def touch_last_seen_for_content_hashes(content_hashes: list[str]) -> int:
    """Refresh last_seen_at for listings skipped by the incremental run, so they
    are not considered stale even though they were not re-upserted. Best effort."""
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    unique = [h for h in {h for h in content_hashes if h}]
    if not url or not key or not unique:
        return 0

    now = datetime.now(UTC).isoformat()
    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    touched = 0
    for index in range(0, len(unique), 150):
        batch = unique[index : index + 150]
        try:
            response = httpx.patch(
                endpoint,
                params={"content_hash": _postgrest_in_filter(batch)},
                headers=_rest_headers(str(key), prefer="return=minimal"),
                json={"last_seen_at": now},
                timeout=30,
            )
            if not response.is_error:
                touched += len(batch)
        except httpx.HTTPError as exc:
            LOGGER.warning("last_seen touch failed: %s", exc)
    return touched


def mark_past_sales_in_supabase() -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return 0
    response = httpx.post(
        f"{str(url).rstrip('/')}/rest/v1/rpc/mark_elapsed_auction_sales",
        headers=_rest_headers(str(key), prefer="return=representation"),
        json={}, timeout=30,
    )
    response.raise_for_status()
    return int(response.json() or 0)


def delete_expired_sales_in_supabase(now: datetime | None = None) -> int:
    """Use the same atomic 24-hour policy as the independent scheduled job."""
    settings = load_settings()
    url, key = settings["supabase_url"], settings["supabase_service_role_key"]
    if not url or not key:
        return 0
    current = now or datetime.now(UTC)
    if current.tzinfo is None:
        current = current.replace(tzinfo=UTC)
    deleted = 0
    for _ in range(40):
        response = httpx.post(
            f"{str(url).rstrip('/')}/rest/v1/rpc/purge_expired_auction_sales",
            headers=_rest_headers(str(key), prefer="return=representation"),
            json={"p_now": current.isoformat(), "p_limit": 25}, timeout=120,
        )
        response.raise_for_status()
        result = response.json()
        deleted += int(result["deleted"])
        if result.get("busy") or not result.get("remaining") or not result["deleted"]:
            break
    return deleted


def delete_vench_sales_without_surface_in_supabase() -> int:
    """Compatibility shim: admission replaces destructive source-specific cleanup."""
    return 0


def _delete_sale_rows_by_source_urls(supabase_url: str, api_key: str, source_urls: list[str]) -> int:
    unique = _unique_source_urls(source_urls)
    if not unique:
        return 0
    for table in EXPIRED_SALE_DELETE_TABLES:
        _postgrest_delete_by_source_urls(supabase_url, api_key, table, unique)
    return len(unique)



def _upsert_with_rest(supabase_url: str, api_key: str, payload: list[dict[str, object]]) -> None:
    _postgrest_upsert(supabase_url, api_key, "auction_sales", payload, on_conflict="source_url")


def _delete_secondary_sale_rows(supabase_url: str, api_key: str, sales: list[AuctionSale]) -> int:
    secondary_urls = _secondary_source_urls(sales)
    if not secondary_urls:
        return 0
    return _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_sales", secondary_urls)


def _delete_secondary_sale_rows_with_postgres(db_url: str, sales: list[AuctionSale]) -> int:
    if psycopg is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    secondary_urls = _secondary_source_urls(sales)
    if not secondary_urls:
        return 0
    with _postgres_connect(db_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "delete from public.auction_observations where source_url = any(%s)",
                (secondary_urls,),
            )
            cursor.execute(
                "delete from public.auction_sales where source_url = any(%s)",
                (secondary_urls,),
            )
    return len(secondary_urls)


def _postgres_upsert(
    db_url: str,
    table: str,
    payload: list[dict[str, object]],
    on_conflict: str,
) -> None:
    if psycopg is None or sql is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    if not payload:
        return
    columns = list(payload[0].keys())
    insert_statement = sql.SQL(
        "insert into {} ({}) values ({}) on conflict ({}) do update set {}"
    ).format(
        sql.Identifier("public", table),
        sql.SQL(", ").join(sql.Identifier(column) for column in columns),
        sql.SQL(", ").join(sql.Placeholder() for _ in columns),
        sql.Identifier(on_conflict),
        sql.SQL(", ").join(
            sql.SQL("{} = excluded.{}").format(sql.Identifier(column), sql.Identifier(column))
            for column in columns
            if column != on_conflict
        ),
    )
    rows = [tuple(_postgres_value(column, row.get(column)) for column in columns) for row in payload]
    with _postgres_connect(db_url) as connection:
        with connection.cursor() as cursor:
            cursor.executemany(insert_statement, rows)


def _postgres_connect(db_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    return psycopg.connect(
        db_url,
        connect_timeout=POSTGRES_CONNECT_TIMEOUT,
        prepare_threshold=None,
    )


def _postgres_value(column: str, value: object) -> object:
    value = _sanitize_postgrest_payload(value)
    if value is None:
        return None
    if column in POSTGRES_JSON_COLUMNS:
        return Jsonb(value) if Jsonb is not None else value
    return value


def _secondary_source_urls(sales: list[AuctionSale]) -> list[str]:
    primary_urls = {sale.source_url for sale in sales if sale.source_url}
    urls: list[str] = []
    seen: set[str] = set()
    for sale in sales:
        for source_url in sale.source_urls:
            if source_url in primary_urls or source_url in seen:
                continue
            seen.add(source_url)
            urls.append(source_url)
    return urls


def _sync_normalized_sale_tables_with_rest(
    supabase_url: str,
    api_key: str,
    sales: list[AuctionSale],
    now: str,
    *,
    refresh_last_seen: bool = True,
) -> None:
    properties = [
        _timestamped(row, now)
        for row in _property_rows_for_sales(sales, now, refresh_last_seen=refresh_last_seen)
    ]
    judicial_sales = [
        _timestamped(row, now)
        for row in _judicial_sale_rows_for_sales(sales, now, refresh_last_seen=refresh_last_seen)
    ]
    if properties:
        _postgrest_upsert(supabase_url, api_key, "properties", properties, on_conflict="source_url")
    if judicial_sales:
        _postgrest_upsert(supabase_url, api_key, "judicial_sales", judicial_sales, on_conflict="source_url")


def _property_rows_for_sales(
    sales: list[AuctionSale],
    now: str,
    *,
    refresh_last_seen: bool = True,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for sale in sales:
        reason = quarantine_reason(sale)
        if reason:
            sale.raw_payload["publication_quarantine"] = reason
            sale.status = "quarantined"
        else:
            sale.raw_payload.pop("publication_quarantine", None)
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in PROPERTY_COLUMNS}
        row["primary_source"] = row.get("primary_source") or row.get("source_name")
        row["source_urls"] = _normalized_source_urls(sale, data)
        row["raw_payload"] = data.get("raw_payload") if isinstance(data.get("raw_payload"), dict) else {}
        row["last_seen_at"] = now if refresh_last_seen else data.get("last_seen_at") or now
        rows.append(row)
    return rows


def _judicial_sale_rows_for_sales(
    sales: list[AuctionSale],
    now: str,
    *,
    refresh_last_seen: bool = True,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for sale in sales:
        reason = quarantine_reason(sale)
        if reason:
            sale.raw_payload["publication_quarantine"] = reason
            sale.status = "quarantined"
        else:
            sale.raw_payload.pop("publication_quarantine", None)
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in JUDICIAL_SALE_COLUMNS}
        row["property_source_url"] = data.get("source_url")
        row["primary_source"] = row.get("primary_source") or row.get("source_name")
        row["source_urls"] = _normalized_source_urls(sale, data)
        row["visit_dates"] = data.get("visit_dates") if isinstance(data.get("visit_dates"), list) else []
        row["status"] = data.get("status") or "upcoming"
        row["source_lawyer_name"] = data.get("lawyer_name")
        row["source_lawyer_contact"] = data.get("lawyer_contact")
        documents = data.get("documents")
        row["documents_count"] = len(documents) if isinstance(documents, list) else 0
        row["score_factors"] = data.get("score_factors") if isinstance(data.get("score_factors"), list) else []
        row["quality_flags"] = data.get("quality_flags") if isinstance(data.get("quality_flags"), list) else []
        row["raw_payload"] = data.get("raw_payload") if isinstance(data.get("raw_payload"), dict) else {}
        row["last_seen_at"] = now if refresh_last_seen else data.get("last_seen_at") or now
        rows.append(row)
    return rows


def _normalized_source_urls(sale: AuctionSale, data: dict[str, Any]) -> list[str]:
    values = data.get("source_urls")
    source_urls = values if isinstance(values, list) else []
    urls = [data.get("source_url"), *source_urls, *sale.source_urls]
    normalized: list[str] = []
    seen: set[str] = set()
    for url in urls:
        if not isinstance(url, str) or not url or url in seen:
            continue
        normalized.append(url)
        seen.add(url)
    return normalized


def _upsert_asset_tables_with_rest(supabase_url: str, api_key: str, sales: list[AuctionSale], now: str) -> None:
    features = [_timestamped(build_auction_features_row(sale), now) for sale in sales]
    surfaces = [_timestamped(build_auction_surfaces_row(sale), now) for sale in sales]
    if features:
        _postgrest_upsert(supabase_url, api_key, "auction_features", features, on_conflict="source_url")
    if surfaces:
        _postgrest_upsert(supabase_url, api_key, "auction_surfaces", surfaces, on_conflict="source_url")
    source_urls = [sale.source_url for sale in sales]
    if source_urls:
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_surface_derivations", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_surface_measurements", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_risks", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_risk_occurrences", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_urban_planning_signals", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_score_factors", source_urls)
    risk_occurrences_by_source = {sale.source_url: _risk_occurrence_rows_for_sale(sale) for sale in sales}
    risk_rows = [
        _timestamped(row, now)
        for sale in sales
        for row in build_auction_risk_rows_from_occurrences(
            sale.source_url,
            risk_occurrences_by_source.get(sale.source_url, []),
        )
    ]
    if risk_rows:
        _postgrest_insert(supabase_url, api_key, "auction_risks", risk_rows)
    risk_occurrences = [_timestamped(row, now) for rows in risk_occurrences_by_source.values() for row in rows]
    if risk_occurrences:
        _postgrest_insert(supabase_url, api_key, "auction_risk_occurrences", risk_occurrences)
    urban_planning_signals = [
        _timestamped(row, now)
        for sale in sales
        for row in build_urban_planning_signal_rows(sale, pdf_texts=_load_pdf_texts(sale))
    ]
    if urban_planning_signals:
        _postgrest_insert(
            supabase_url,
            api_key,
            "auction_urban_planning_signals",
            urban_planning_signals,
        )
    surface_measurements = [
        _timestamped(row, now)
        for sale in sales
        for row in _surface_measurement_rows_for_sale(sale)
    ]
    if surface_measurements:
        _postgrest_insert(
            supabase_url,
            api_key,
            "auction_surface_measurements",
            surface_measurements,
        )
    surface_derivations = [
        _timestamped(row, now)
        for sale in sales
        for row in _surface_derivation_rows_for_sale(sale)
    ]
    if surface_derivations:
        _postgrest_insert(
            supabase_url,
            api_key,
            "auction_surface_derivations",
            surface_derivations,
        )
    score_factors = [
        _timestamped(row, now)
        for sale in sales
        for row in build_auction_score_factor_rows(
            sale,
            risk_occurrences_by_source.get(sale.source_url, []),
        )
    ]
    if score_factors:
        _postgrest_insert(supabase_url, api_key, "auction_score_factors", score_factors)
    upsert_documents_to_supabase(sales)
    upsert_extractions_to_supabase(sales)


def _postgrest_upsert(
    supabase_url: str,
    api_key: str,
    table: str,
    payload: list[dict[str, object]],
    on_conflict: str,
) -> None:
    if _PUBLICATION_CONNECTION.get() is not None:
        _transaction_write(table, payload, on_conflict)
        return
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/{table}"
    for batch in _postgrest_batches(payload, _postgrest_batch_size(table)):
        response = _postgrest_upsert_batch(
            endpoint,
            api_key,
            table,
            batch,
            on_conflict,
        )
        if response.is_error:
            raise httpx.HTTPStatusError(
                f"{response.status_code} response from Supabase {table}: {response.text}",
                request=response.request,
                response=response,
            )


def _postgrest_upsert_batch(
    endpoint: str,
    api_key: str,
    table: str,
    payload: list[dict[str, object]],
    on_conflict: str,
) -> httpx.Response:
    last_timeout: httpx.TimeoutException | None = None
    for attempt in range(1, POSTGREST_UPSERT_RETRIES + 1):
        try:
            response = httpx.post(
                endpoint,
                params={"on_conflict": on_conflict},
                headers=_rest_headers(api_key, prefer="resolution=merge-duplicates,return=minimal"),
                json=_sanitize_postgrest_payload(payload),
                timeout=POSTGREST_TIMEOUT,
            )
            if response.status_code not in POSTGREST_RETRYABLE_STATUS_CODES or attempt == POSTGREST_UPSERT_RETRIES:
                return response
            LOGGER.warning(
                "Supabase %s upsert returned %s on attempt %s/%s for %s rows; retrying",
                table,
                response.status_code,
                attempt,
                POSTGREST_UPSERT_RETRIES,
                len(payload),
            )
        except httpx.TimeoutException as exc:
            last_timeout = exc
            if attempt == POSTGREST_UPSERT_RETRIES:
                raise
            LOGGER.warning(
                "Supabase %s upsert timed out on attempt %s/%s for %s rows; retrying",
                table,
                attempt,
                POSTGREST_UPSERT_RETRIES,
                len(payload),
            )
        time.sleep(2 * attempt)
    if last_timeout is not None:
        raise last_timeout
    raise RuntimeError(f"Supabase {table} upsert failed before request")


def _postgrest_insert(supabase_url: str, api_key: str, table: str, payload: list[dict[str, object]]) -> None:
    if _PUBLICATION_CONNECTION.get() is not None:
        _transaction_write(table, payload)
        return
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/{table}"
    for batch in _postgrest_batches(payload, _postgrest_batch_size(table)):
        response = _postgrest_request_with_retries(
            "POST",
            endpoint,
            table=table,
            headers=_rest_headers(api_key, prefer="return=minimal"),
            json=_sanitize_postgrest_payload(batch),
            timeout=POSTGREST_TIMEOUT,
        )
        if response.is_error:
            raise httpx.HTTPStatusError(
                f"{response.status_code} response from Supabase {table}: {response.text}",
                request=response.request,
                response=response,
            )


def _postgrest_delete(supabase_url: str, api_key: str, table: str, params: dict[str, str]) -> None:
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/{table}"
    response = _postgrest_request_with_retries(
        "DELETE",
        endpoint,
        table=table,
        params=params,
        headers=_rest_headers(api_key, prefer="return=minimal"),
        timeout=30,
    )
    if response.is_error:
        raise httpx.HTTPStatusError(
            f"{response.status_code} response from Supabase {table}: {response.text}",
            request=response.request,
            response=response,
        )


def _postgrest_delete_by_source_urls(supabase_url: str, api_key: str, table: str, source_urls: list[str]) -> int:
    connection = _PUBLICATION_CONNECTION.get()
    if connection is not None:
        connection.execute(sql.SQL("delete from {} where source_url = any(%s)").format(sql.Identifier("public", table)), (source_urls,))
        return len(set(source_urls))
    unique = _unique_source_urls(source_urls)
    for index in range(0, len(unique), POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE):
        batch = unique[index : index + POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE]
        _postgrest_delete(
            supabase_url,
            api_key,
            table,
            {"source_url": _postgrest_in_filter(batch)},
        )
    return len(unique)


def _unique_source_urls(source_urls: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for source_url in source_urls:
        if not source_url or source_url in seen:
            continue
        seen.add(source_url)
        unique.append(source_url)
    return unique


def _postgrest_request_with_retries(method: str, endpoint: str, table: str, **kwargs: Any) -> httpx.Response:
    last_timeout: httpx.TimeoutException | None = None
    for attempt in range(1, POSTGREST_UPSERT_RETRIES + 1):
        try:
            response = httpx.request(method, endpoint, **kwargs)
            if response.status_code not in POSTGREST_RETRYABLE_STATUS_CODES or attempt == POSTGREST_UPSERT_RETRIES:
                return response
            LOGGER.warning(
                "Supabase %s %s returned %s on attempt %s/%s; retrying",
                table,
                method,
                response.status_code,
                attempt,
                POSTGREST_UPSERT_RETRIES,
            )
        except httpx.TimeoutException as exc:
            last_timeout = exc
            if attempt == POSTGREST_UPSERT_RETRIES:
                raise
            LOGGER.warning(
                "Supabase %s %s timed out on attempt %s/%s; retrying",
                table,
                method,
                attempt,
                POSTGREST_UPSERT_RETRIES,
            )
        time.sleep(2 * attempt)
    if last_timeout is not None:
        raise last_timeout
    raise RuntimeError(f"Supabase {table} {method} failed before request")


def _postgrest_in_filter(values: list[str]) -> str:
    quoted = []
    for value in values:
        escaped = value.replace('"', '\\"')
        quoted.append(f'"{escaped}"')
    return f"in.({','.join(quoted)})"


def _postgrest_batch_size(table: str) -> int:
    if table in {"auction_sales", "auction_extractions"}:
        return 5
    if table == "auction_observations":
        return 10
    if table in {"auction_documents", "auction_score_factors", "auction_risk_occurrences"}:
        return 25
    return 100


def _postgrest_batches(payload: list[dict[str, object]], batch_size: int) -> list[list[dict[str, object]]]:
    return [payload[index : index + batch_size] for index in range(0, len(payload), batch_size)]


def _rest_headers(api_key: str, prefer: str) -> dict[str, str]:
    return {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def _timestamped(row: dict[str, object], now: str) -> dict[str, object]:
    row["updated_at"] = now
    return row


def _sanitize_postgrest_payload(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, list):
        return [_sanitize_postgrest_payload(item) for item in value]
    if isinstance(value, dict):
        return {key: _sanitize_postgrest_payload(item) for key, item in value.items()}
    return value


def _risk_occurrence_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    seen: set[tuple[object, ...]] = set()
    for item in _load_pdf_texts(sale):
        if not isinstance(item, dict):
            continue
        document_url = str(item.get("url") or "")
        document_type = str(item.get("document_type") or "") or classify_document_type(str(item.get("label") or ""), document_url)
        pages = item.get("pages")
        has_page_text = isinstance(pages, list) and any(
            isinstance(page, dict) and page.get("text") for page in pages
        )
        page_items = pages if has_page_text else [{"page": None, "text": item.get("text")}]
        for page in page_items:
            if not isinstance(page, dict):
                continue
            page_number = page.get("page") if isinstance(page.get("page"), int) else None
            for occurrence in extract_risk_occurrences_from_text(
                str(page.get("text") or ""),
                sale.source_url,
                source_kind="pdf",
                document_url=document_url or None,
                document_label=str(item.get("label") or "") or None,
                document_type=document_type,
                page_number=page_number,
            ):
                key = (
                    occurrence.get("risk_label"),
                    occurrence.get("document_url"),
                    occurrence.get("page_number"),
                    str(occurrence.get("excerpt") or "")[:120],
                )
                if key in seen:
                    continue
                seen.add(key)
                rows.append(_public_occurrence_row(occurrence))

    if rows:
        return rows[:100]

    fallback_text = " ".join(filter(None, [sale.title, sale.description, sale.raw_text]))
    return [
        _public_occurrence_row(occurrence)
        for occurrence in extract_risk_occurrences_from_text(
            fallback_text,
            sale.source_url,
            source_kind="sale_text",
        )
    ][:50]


def _public_occurrence_row(occurrence: dict[str, object]) -> dict[str, object]:
    return {
        "source_url": occurrence["source_url"],
        "risk_type": occurrence["risk_type"],
        "risk_label": occurrence["risk_label"],
        "severity": occurrence["severity"],
        "document_url": occurrence.get("document_url"),
        "document_label": occurrence.get("document_label"),
        "document_type": occurrence.get("document_type"),
        "page_number": occurrence.get("page_number"),
        "excerpt": occurrence["excerpt"],
        "confidence": occurrence.get("confidence"),
        "detector": occurrence.get("detector"),
        "detector_version": occurrence.get("detector_version"),
        "matched_terms": occurrence.get("matched_terms") or [],
        "is_negated": occurrence.get("is_negated") or False,
        "score_impact": occurrence.get("score_impact"),
    }


def _document_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    pdf_texts = _load_pdf_texts(sale)
    text_by_url = {item.get("url"): item for item in pdf_texts if isinstance(item, dict)}
    rows = []
    for document in sale.documents:
        url = document.get("url")
        if not url:
            continue
        extracted = text_by_url.get(url, {})
        pages = extracted.get("pages") if isinstance(extracted, dict) else None
        page_count = len(pages) if isinstance(pages, list) else None
        text_chars = int(extracted.get("text_chars") or len(str(extracted.get("text") or ""))) if extracted else 0
        extraction_confidence = extracted.get("confidence") if isinstance(extracted, dict) else None
        raw_payload = dict(document)
        if isinstance(extracted, dict):
            raw_payload["extraction"] = {
                "cache_version": extracted.get("cache_version"),
                "extraction_method": extracted.get("extraction_method"),
                "page_count": page_count,
                "ocr_pages": extracted.get("ocr_pages"),
                "empty_pages": extracted.get("empty_pages"),
                "page_text_chars": extracted.get("page_text_chars"),
                "confidence": extraction_confidence,
            }
        rows.append(
            {
                "source_url": sale.source_url,
                "document_url": url,
                "label": document.get("label"),
                "document_type": classify_document_type(
                    str(document.get("label") or extracted.get("label") or ""),
                    str(url),
                ),
                "file_path": extracted.get("file_path"),
                "sha256": extracted.get("sha256"),
                "download_status": "downloaded" if extracted.get("file_path") else "unknown",
                "text_chars": text_chars,
                "extraction_status": "extracted" if extracted.get("text") else "pending",
                "docling_status": extracted.get("extraction_method"),
                "raw_payload": raw_payload,
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
    return rows


def _unique_rows_by_key(rows: list[dict[str, object]], key: str) -> list[dict[str, object]]:
    unique: dict[str, dict[str, object]] = {}
    for row in rows:
        value = row.get(key)
        if value is None:
            continue
        unique[str(value)] = row
    return list(unique.values())


def _extraction_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    rows = []
    sale_id = sale_storage_id(sale)
    pdf_path = PDF_TEXTS_DIR / f"{sale_id}.json"
    if pdf_path.exists():
        payload = _read_json_file(pdf_path)
        input_hash = sale.content_hash or sale.source_url
        rows.append(
            {
                "source_url": sale.source_url,
                "provider": "pdf_text",
                "model": "docling+pymupdf+tesseract",
                "input_hash": input_hash,
                "schema_version": "pdf_text_v2_page_level",
                "result": payload,
                "confidence": _pdf_extraction_confidence(payload),
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
    llm_payload = sale.raw_payload.get("llm_extraction")
    if isinstance(llm_payload, dict):
        cache = _read_json_file(LLM_EXTRACTIONS_DIR / f"{sale_id}.json") or {}
        input_hash = str(cache.get("_cache", {}).get("key") or sale.content_hash or sale.source_url)
        rows.append(
            {
                "source_url": sale.source_url,
                "provider": "replicate",
                "model": str(cache.get("_cache", {}).get("model") or "zsxkib/qwen2-7b-instruct"),
                "input_hash": input_hash,
                "schema_version": "llm_extraction_v2_structured_assets",
                "result": llm_payload,
                "confidence": llm_payload.get("confidence") or {},
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
    return rows


def _surface_measurement_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    analysis = sale.raw_payload.get("surface_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict):
        return []
    version = str(analysis.get("version") or "surface_reasoning_v1")
    measurements = analysis.get("measurements")
    if not isinstance(measurements, list):
        return []
    rows: list[dict[str, object]] = []
    for index, measurement in enumerate(measurements):
        if not isinstance(measurement, dict):
            continue
        evidence = measurement.get("evidence") if isinstance(measurement.get("evidence"), dict) else {}
        quote = str(evidence.get("quote") or "").strip()
        value = measurement.get("value_m2")
        if not quote or value is None:
            continue
        local_key = str(measurement.get("measurement_id") or index)
        rows.append(
            {
                "measurement_key": _surface_row_key(sale.source_url, local_key),
                "source_url": sale.source_url,
                "asset_id": str(measurement.get("asset_id") or "asset-main"),
                "lot_label": measurement.get("lot_label"),
                "level_label": measurement.get("level"),
                "space_label": str(measurement.get("space_label") or "pièce"),
                "category": str(measurement.get("category") or "unknown"),
                "value_m2": value,
                "included_in_habitable_sum": measurement.get("included_in_habitable_sum"),
                "confidence": measurement.get("confidence") or 0,
                "evidence_quote": quote,
                "document_url": evidence.get("document_url"),
                "document_label": evidence.get("document_label"),
                "page_number": evidence.get("page_number"),
                "extraction_method": str(measurement.get("extraction_method") or "unknown"),
                "reasoning_version": version,
            }
        )
    return rows


def _surface_derivation_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    analysis = sale.raw_payload.get("surface_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict):
        return []
    version = str(analysis.get("version") or "surface_reasoning_v1")
    selected_id = str(analysis.get("selected_derivation_id") or "")
    derivations = analysis.get("derivations")
    candidates = analysis.get("candidates") if isinstance(analysis.get("candidates"), list) else []
    candidates_by_id = {
        str(item.get("candidate_id")): item
        for item in candidates
        if isinstance(item, dict) and item.get("candidate_id")
    }
    if not isinstance(derivations, list):
        return []
    rows: list[dict[str, object]] = []
    for index, derivation in enumerate(derivations):
        if not isinstance(derivation, dict):
            continue
        local_key = str(derivation.get("derivation_id") or index)
        operands = derivation.get("operand_measurement_ids")
        operand_keys = [
            _surface_row_key(sale.source_url, str(value))
            for value in operands
            if value
        ] if isinstance(operands, list) else []
        explicit_id = str(derivation.get("explicit_candidate_id") or "")
        rows.append(
            {
                "derivation_key": _surface_row_key(sale.source_url, local_key),
                "source_url": sale.source_url,
                "asset_id": str(derivation.get("asset_id") or "asset-main"),
                "kind": str(derivation.get("kind") or "unknown"),
                "value_m2": derivation.get("value_m2"),
                "operand_measurement_keys": operand_keys,
                "formula": str(derivation.get("formula") or "surface explicitement indiquée"),
                "validation_status": str(derivation.get("validation_status") or "rejected"),
                "confidence": derivation.get("confidence") or 0,
                "explicit_candidate": candidates_by_id.get(explicit_id),
                "warnings": derivation.get("warnings") or [],
                "is_selected": local_key == selected_id,
                "reasoning_version": version,
            }
        )
    return rows


def _surface_row_key(source_url: str, local_key: str) -> str:
    return hashlib.sha256(f"{source_url}\0{local_key}".encode()).hexdigest()


def _pdf_extraction_confidence(payload: Any) -> dict[str, object]:
    if not isinstance(payload, list):
        return {}
    document_confidences = []
    page_confidences = []
    ocr_pages = 0
    empty_pages = 0
    page_count = 0
    for item in payload:
        if not isinstance(item, dict):
            continue
        confidence = item.get("confidence")
        if isinstance(confidence, (int, float)):
            document_confidences.append(float(confidence))
        pages = item.get("pages")
        if isinstance(pages, list):
            page_count += len(pages)
            for page in pages:
                if not isinstance(page, dict):
                    continue
                method = str(page.get("method") or "")
                if method.startswith("ocr_"):
                    ocr_pages += 1
                if not page.get("text"):
                    empty_pages += 1
                page_confidence = page.get("confidence")
                if isinstance(page_confidence, (int, float)):
                    page_confidences.append(float(page_confidence))
    confidence = document_confidences or page_confidences
    average = round(sum(confidence) / len(confidence), 3) if confidence else None
    return {
        "document_count": len(payload),
        "page_count": page_count,
        "ocr_pages": ocr_pages,
        "empty_pages": empty_pages,
        "average_confidence": average,
    }


def _load_pdf_texts(sale: AuctionSale) -> list[dict[str, object]]:
    path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
    payload = _read_json_file(path)
    return payload if isinstance(payload, list) else []


def _read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
