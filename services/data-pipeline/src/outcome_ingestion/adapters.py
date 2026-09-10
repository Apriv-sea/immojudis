from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from src.official_sources.encheres_publiques_open_data import (
    ENCHERES_PUBLIQUES_DATASET_URL,
)
from src.official_sources.justice_open_data import (
    JUSTICE_COMPETENCES_DATASET_URL,
    JUSTICE_STRUCTURES_DATASET_URL,
)
from src.outcome_ingestion.dvf_adjudication import DvfAdjudicationCandidate
from src.outcome_ingestion.service import JsonSourceRecord

DVF_CONNECTOR_VERSION = "dvf-adjudication/1"
DVF_SCHEMA_VERSION = "dvf_adjudication_candidate_v1"
JUSTICE_CONNECTOR_VERSION = "justice-open-data/1"
JUSTICE_SCHEMA_VERSIONS = {
    "court_competence": "justice_court_competence_v1",
    "justice_court_structure": "justice_court_structure_v1",
}
JUSTICE_RECORD_KINDS = {
    "court_competence": "territorial_jurisdiction",
    "justice_court_structure": "court_reference_candidate",
}
ENCHERES_CONNECTOR_VERSION = "encheres-publiques-open-data/1"
ENCHERES_SCHEMA_VERSIONS = {
    "auction_hearing_candidate": "encheres_publiques_hearing_candidate_v1",
    "court_reference_candidate": "encheres_publiques_court_candidate_v1",
}
LICITOR_RESULTS_SOURCE_NAME = "licitor_public_results"
LICITOR_RESULTS_CONNECTOR_VERSION = "licitor-history/4"
LICITOR_RESULTS_SCHEMA_VERSION = "licitor_auction_result_candidate_v1"


class SourceRecordAdapterError(ValueError):
    """Raised when a parser record cannot enter the provenance pipeline safely."""


def dvf_adjudication_to_json_record(candidate: DvfAdjudicationCandidate) -> JsonSourceRecord:
    normalized = candidate.normalized_data()
    _require_candidate_only(normalized)
    raw_payload = {
        **normalized,
        "external_record_id": candidate.external_record_id,
        "source_content_hash": candidate.content_hash,
        "source_dataset_url": candidate.source_url,
    }
    return JsonSourceRecord(
        source_name="dvf_dgfip",
        external_record_id=candidate.external_record_id,
        requested_url=candidate.source_url,
        canonical_url=candidate.source_url,
        record_kind="auction_result_candidate",
        raw_payload=raw_payload,
        normalized_data=normalized,
        connector_version=DVF_CONNECTOR_VERSION,
        extractor_name="dvf_adjudication_projection",
        extractor_version="1",
        schema_version=DVF_SCHEMA_VERSION,
        capture_transport="local_file",
        http_status=None,
        request_method=None,
        # A mutation date is not a publication timestamp. Keep publication
        # unknown unless the exact data.gouv resource snapshot supplies it.
        published_at=None,
        request_parameters={
            "mutation_nature": "Adjudication",
            "external_record_id": candidate.external_record_id,
        },
    )


def justice_open_data_to_json_record(record: Mapping[str, Any]) -> JsonSourceRecord:
    record_type = _required_text(record, "record_type")
    if record_type not in JUSTICE_RECORD_KINDS:
        raise SourceRecordAdapterError(f"unsupported Justice record_type: {record_type}")
    if _required_text(record, "source_name") != "justice_open_data":
        raise SourceRecordAdapterError("Justice record has an unexpected source_name")

    stable_id = _required_text(record, "stable_id")
    source_url = _required_https_url(record, "source_url")
    expected_url = (
        JUSTICE_COMPETENCES_DATASET_URL if record_type == "court_competence" else JUSTICE_STRUCTURES_DATASET_URL
    )
    if source_url != expected_url:
        raise SourceRecordAdapterError("Justice record has an unexpected dataset URL")

    normalized = _candidate_projection(record)
    normalized["training_eligible"] = False
    normalized["review_status"] = "pending"
    normalized["schema_version"] = JUSTICE_SCHEMA_VERSIONS[record_type]
    return JsonSourceRecord(
        source_name="justice_open_data",
        external_record_id=stable_id,
        requested_url=source_url,
        canonical_url=source_url,
        record_kind=JUSTICE_RECORD_KINDS[record_type],
        raw_payload=dict(record),
        normalized_data=normalized,
        connector_version=JUSTICE_CONNECTOR_VERSION,
        extractor_name=f"justice_open_data_{record_type}",
        extractor_version="1",
        schema_version=JUSTICE_SCHEMA_VERSIONS[record_type],
        capture_transport="local_file",
        http_status=None,
        request_method=None,
        request_parameters={"stable_id": stable_id},
    )


def encheres_publiques_to_json_record(record: Mapping[str, Any]) -> JsonSourceRecord:
    record_type = _required_text(record, "record_type")
    if record_type not in ENCHERES_SCHEMA_VERSIONS:
        raise SourceRecordAdapterError(f"unsupported Encheres Publiques record_type: {record_type}")
    if _required_text(record, "source_name") != "encheres_publiques_open_data":
        raise SourceRecordAdapterError("Encheres Publiques record has an unexpected source_name")
    if record.get("training_eligible") is not False:
        raise SourceRecordAdapterError("Encheres Publiques candidates must remain non-training")

    stable_id = _required_text(record, "stable_id")
    canonical_url = _required_https_url(record, "source_url")
    dataset_url = _required_https_url(record, "source_dataset_url")
    if dataset_url != ENCHERES_PUBLIQUES_DATASET_URL:
        raise SourceRecordAdapterError("Encheres Publiques record has an unexpected dataset URL")

    normalized = _candidate_projection(record)
    normalized["training_eligible"] = False
    normalized["review_status"] = "pending"
    normalized["schema_version"] = ENCHERES_SCHEMA_VERSIONS[record_type]
    hearing_at = record.get("hearing_at") if record_type == "auction_hearing_candidate" else None
    if hearing_at is not None and not isinstance(hearing_at, datetime):
        raise SourceRecordAdapterError("hearing_at must be a timezone-aware datetime")
    if isinstance(hearing_at, datetime) and hearing_at.utcoffset() is None:
        raise SourceRecordAdapterError("hearing_at must be a timezone-aware datetime")

    return JsonSourceRecord(
        source_name="encheres_publiques_open_data",
        external_record_id=stable_id,
        requested_url=dataset_url,
        canonical_url=canonical_url,
        record_kind=record_type,
        raw_payload=dict(record),
        normalized_data=normalized,
        connector_version=ENCHERES_CONNECTOR_VERSION,
        extractor_name=f"encheres_publiques_{record_type}",
        extractor_version="1",
        schema_version=ENCHERES_SCHEMA_VERSIONS[record_type],
        capture_transport="local_file",
        http_status=None,
        request_method=None,
        # The hearing time is not the publication time of the CSV resource.
        published_at=None,
        request_parameters={"stable_id": stable_id},
    )


def licitor_historical_to_json_record(record: Mapping[str, Any]) -> JsonSourceRecord:
    """Prepare a private provenance record without bypassing the DB rights gate.

    The registered source remains disabled until a reviewed agreement enables
    it. This adapter only makes the post-authorization ingestion path explicit.
    """

    if _required_text(record, "source_name") != "licitor":
        raise SourceRecordAdapterError("Licitor result has an unexpected source_name")
    if record.get("training_eligible") is not False:
        raise SourceRecordAdapterError("Licitor candidates must remain non-training")
    if record.get("candidate_grade") != "C" or record.get("evidence_grade") != "C":
        raise SourceRecordAdapterError("Licitor candidates must remain grade C before review")
    quality_flags = record.get("quality_flags")
    reported_authorization = record.get("authorization_basis") in {
        "operator_reported_verbal_consent",
        "written_source_consent",
    } and bool(record.get("authorization_reference"))
    if not isinstance(quality_flags, list) or not (
        "commercial_reuse_rights_pending" in quality_flags
        or (reported_authorization and "source_authorization_reported_by_operator" in quality_flags)
    ):
        raise SourceRecordAdapterError("Licitor candidate must preserve its authorization provenance")

    external_record_id = _required_text(record, "external_id")
    source_url = _required_licitor_url(record, "source_url")
    source_page_url = _required_licitor_url(record, "source_page_url")
    if source_url != source_page_url and not source_url.startswith(f"{source_page_url}#"):
        raise SourceRecordAdapterError("Licitor lot URL must belong to its source page")

    normalized = _candidate_projection(record)
    normalized.update(
        {
            "source_name": LICITOR_RESULTS_SOURCE_NAME,
            "review_status": "pending",
            "rights_status": record.get("authorization_basis")
            if reported_authorization
            else "pending_source_authorization",
            "publication_eligible": False,
            "schema_version": LICITOR_RESULTS_SCHEMA_VERSION,
            "training_eligible": False,
        }
    )
    return JsonSourceRecord(
        source_name=LICITOR_RESULTS_SOURCE_NAME,
        external_record_id=external_record_id,
        requested_url=source_page_url,
        canonical_url=source_url,
        record_kind="auction_result_candidate",
        raw_payload=dict(record),
        normalized_data=normalized,
        connector_version=LICITOR_RESULTS_CONNECTOR_VERSION,
        extractor_name="licitor_historical_result",
        extractor_version="1",
        schema_version=LICITOR_RESULTS_SCHEMA_VERSION,
        capture_transport="http",
        http_status=200,
        request_method="GET",
        request_parameters={"external_record_id": external_record_id},
    )


def _candidate_projection(record: Mapping[str, Any]) -> dict[str, object]:
    # Parser hashes remain provenance metadata, not predictive inputs.
    return {str(key): value for key, value in record.items() if key not in {"canonical_hash", "phone", "email"}}


def _require_candidate_only(record: Mapping[str, object]) -> None:
    if record.get("training_eligible") is not False:
        raise SourceRecordAdapterError("source candidates must remain non-training")


def _required_text(record: Mapping[str, Any], key: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SourceRecordAdapterError(f"source record is missing {key}")
    return value.strip()


def _required_https_url(record: Mapping[str, Any], key: str) -> str:
    value = _required_text(record, key)
    if not value.startswith("https://"):
        raise SourceRecordAdapterError(f"source record {key} must use HTTPS")
    return value


def _required_licitor_url(record: Mapping[str, Any], key: str) -> str:
    value = _required_https_url(record, key)
    parsed = urlsplit(value)
    if parsed.hostname != "www.licitor.com" or parsed.username is not None or parsed.password is not None:
        raise SourceRecordAdapterError(f"Licitor record {key} has an unexpected origin")
    return value
