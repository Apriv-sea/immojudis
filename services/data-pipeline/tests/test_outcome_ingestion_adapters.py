from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from src.official_sources.encheres_publiques_open_data import (
    ENCHERES_PUBLIQUES_DATASET_URL,
)
from src.official_sources.justice_open_data import JUSTICE_COMPETENCES_DATASET_URL
from src.outcome_ingestion.adapters import (
    SourceRecordAdapterError,
    dvf_adjudication_to_json_record,
    encheres_publiques_to_json_record,
    justice_open_data_to_json_record,
    licitor_historical_to_json_record,
)
from src.outcome_ingestion.dvf_adjudication import DvfAdjudicationCandidate


def test_dvf_adapter_preserves_exact_money_and_training_lock() -> None:
    candidate = DvfAdjudicationCandidate(
        external_record_id="dvf:2025:abc",
        sale_date=date(2025, 5, 6),
        total_price_eur=Decimal("123456.78"),
        property_type="Maison",
        parcel_ids=("33056000AB0012",),
        address="1 rue du Test",
        city="Bordeaux",
        postal_code="33000",
        insee_code="33063",
        department="33",
        source_url="https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres",
        content_hash="a" * 64,
        raw_row_count=2,
        property_count=1,
    )

    record = dvf_adjudication_to_json_record(candidate)

    assert record.source_name == "dvf_dgfip"
    assert record.record_kind == "auction_result_candidate"
    assert record.normalized_data["total_price_eur"] == "123456.78"
    assert record.normalized_data["training_eligible"] is False
    assert record.capture_transport == "local_file"
    assert record.http_status is None
    assert record.request_method is None
    assert record.published_at is None


def test_justice_adapter_maps_competence_to_territorial_jurisdiction() -> None:
    record = justice_open_data_to_json_record(
        {
            "record_type": "court_competence",
            "stable_id": "justice_open_data:competence:33063",
            "source_name": "justice_open_data",
            "source_url": JUSTICE_COMPETENCES_DATASET_URL,
            "source_grade": "A",
            "insee_code": "33063",
            "tj_name": "TRIBUNAL JUDICIAIRE DE BORDEAUX",
            "canonical_hash": "b" * 64,
        }
    )

    assert record.record_kind == "territorial_jurisdiction"
    assert record.normalized_data["training_eligible"] is False
    assert "canonical_hash" not in record.normalized_data
    assert (record.capture_transport, record.http_status, record.request_method) == (
        "local_file",
        None,
        None,
    )


def test_encheres_adapter_keeps_third_party_hearing_candidate_only() -> None:
    hearing_at = datetime(2024, 3, 2, 9, 0, tzinfo=UTC)
    record = encheres_publiques_to_json_record(
        {
            "record_type": "auction_hearing_candidate",
            "stable_id": "encheres_publiques:hearing:abc",
            "source_name": "encheres_publiques_open_data",
            "source_url": "https://www.encheres-publiques.com/encheres/immobilier/test",
            "source_dataset_url": ENCHERES_PUBLIQUES_DATASET_URL,
            "training_eligible": False,
            "candidate_grade": "C",
            "hearing_at": hearing_at,
            "canonical_hash": "c" * 64,
        }
    )

    assert record.record_kind == "auction_hearing_candidate"
    assert record.published_at is None
    assert record.normalized_data["training_eligible"] is False
    assert (record.capture_transport, record.http_status, record.request_method) == (
        "local_file",
        None,
        None,
    )


def test_encheres_adapter_rejects_training_eligible_payload() -> None:
    with pytest.raises(SourceRecordAdapterError, match="must remain non-training"):
        encheres_publiques_to_json_record(
            {
                "record_type": "auction_hearing_candidate",
                "stable_id": "encheres_publiques:hearing:abc",
                "source_name": "encheres_publiques_open_data",
                "source_url": "https://www.encheres-publiques.com/encheres/immobilier/test",
                "source_dataset_url": ENCHERES_PUBLIQUES_DATASET_URL,
                "training_eligible": True,
            }
        )


def test_licitor_adapter_keeps_result_candidate_private_and_non_training() -> None:
    source_page_url = (
        "https://www.licitor.com/annonce/10/90/34/vente-aux-encheres/un-appartement/garches/hauts-de-seine/109034.html"
    )
    record = licitor_historical_to_json_record(
        {
            "source_name": "licitor",
            "source_url": f"{source_page_url}#lot-1",
            "source_page_url": source_page_url,
            "external_id": "109034:lot:1",
            "sale_date": "2026-07-09",
            "starting_price_eur": "500000.00",
            "adjudication_price_eur": "376000.00",
            "candidate_grade": "C",
            "evidence_grade": "C",
            "quality_flags": [
                "third_party_result_candidate",
                "commercial_reuse_rights_pending",
            ],
            "training_eligible": False,
        }
    )

    assert record.source_name == "licitor_public_results"
    assert record.record_kind == "auction_result_candidate"
    assert record.normalized_data["review_status"] == "pending"
    assert record.normalized_data["training_eligible"] is False
    assert record.requested_url == source_page_url
    assert record.canonical_url == f"{source_page_url}#lot-1"
    assert (record.capture_transport, record.http_status, record.request_method) == (
        "http",
        200,
        "GET",
    )


def test_licitor_adapter_rejects_an_untrusted_source_origin() -> None:
    with pytest.raises(SourceRecordAdapterError, match="unexpected origin"):
        licitor_historical_to_json_record(
            {
                "source_name": "licitor",
                "source_url": "https://example.test/109034.html#lot-1",
                "source_page_url": "https://example.test/109034.html",
                "external_id": "109034:lot:1",
                "candidate_grade": "C",
                "evidence_grade": "C",
                "quality_flags": ["commercial_reuse_rights_pending"],
                "training_eligible": False,
            }
        )


def test_justice_adapter_rejects_unregistered_record_kind() -> None:
    with pytest.raises(SourceRecordAdapterError, match="unsupported Justice"):
        justice_open_data_to_json_record(
            {
                "record_type": "judicial_decision",
                "stable_id": "justice:test",
                "source_name": "justice_open_data",
                "source_url": JUSTICE_COMPETENCES_DATASET_URL,
            }
        )
