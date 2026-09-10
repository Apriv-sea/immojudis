from __future__ import annotations

from decimal import Decimal

from src.models import AuctionSale
from src.sale_procedure import (
    JUDICIAL_RULES_SOURCE_URL,
    SALE_PROCEDURE_SCHEMA_VERSION,
    classify_sale_procedure,
)

VERIFIED_AT = "2026-08-20T09:30:00+00:00"


def test_preserves_online_notarial_window_but_not_judicial_audience_slot() -> None:
    schedule = {"opens_at": "2026-09-16T13:00:00+00:00", "closes_at": "2026-09-17T13:00:00+00:00"}
    notary = make_sale(
        source_name="notaires", tribunal=None, tribunal_code=None,
        description="Vente notariale en ligne", raw_payload={"source_sale_schedule": schedule},
    )
    classified = classify_sale_procedure(notary, verified_at=VERIFIED_AT)
    assert classified.sale_procedure["sale_window"] == {**schedule, "source_url": notary.source_url}
    assert classify_sale_procedure(classified, verified_at=VERIFIED_AT).sale_procedure["sale_window"] == {
        **schedule, "source_url": notary.source_url,
    }
    judicial = make_sale(raw_payload={"source_sale_schedule": schedule})
    judicial_procedure = classify_sale_procedure(judicial).sale_procedure
    assert "sale_window" not in judicial_procedure
    assert judicial_procedure["sale_session"]["closes_at"] == schedule["closes_at"]


def test_rejects_unzoned_source_window() -> None:
    sale = make_sale(
        source_name="notaires", tribunal=None, tribunal_code=None,
        description="Vente notariale en ligne",
        raw_payload={"source_sale_schedule": {
            "opens_at": "2026-09-16T13:00:00", "closes_at": "2026-09-17T13:00:00",
        }},
    )
    assert "sale_window" not in classify_sale_procedure(sale).sale_procedure


def make_sale(**overrides: object) -> AuctionSale:
    payload: dict[str, object] = {
        "source_name": "avoventes",
        "source_url": "https://avoventes.fr/vente/123",
        "title": "Maison à Bordeaux",
        "description": "Audience d'adjudication au Tribunal judiciaire de Bordeaux.",
        "starting_price_eur": Decimal("80000"),
        "tribunal": "TJ Bordeaux",
        "tribunal_code": "bordeaux",
        "raw_payload": {
            "tribunal_assignment": {
                "status": "verified",
                "mapping_method": "justice_competence_insee_exact",
                "court_code": "bordeaux",
                "court_name": "TJ Bordeaux",
                "court_city": "Bordeaux",
                "court_address": "30 rue des Frères Bonie, 33000, BORDEAUX",
                "insee_code": "33063",
                "source_url": "https://www.data.gouv.fr/fr/datasets/competence-territoriale/",
                "reference_sha256": "a" * 64,
            }
        },
    }
    payload.update(overrides)
    return AuctionSale.model_validate(payload)


def test_classifies_and_cross_checks_judicial_sale() -> None:
    sale = classify_sale_procedure(make_sale(), verified_at=VERIFIED_AT)

    assert sale.sale_venue_type == "tribunal"
    assert sale.sale_verification_status == "cross_checked"
    assert sale.sale_procedure["schema_version"] == SALE_PROCEDURE_SCHEMA_VERSION
    assert sale.sale_procedure["eligible_bar"] == "Barreau de Bordeaux"
    assert sale.sale_procedure["venue_address"] == "30 rue des Frères Bonie, 33000, BORDEAUX"
    assert sale.sale_procedure["rules"]["lawyer_required"] is True
    assert sale.sale_procedure["rules"]["guarantee"]["amount_eur"] == 8000.0
    assert sale.sale_procedure["rules"]["overbid"] == {
        "allowed": True,
        "minimum_increase_pct": 10,
        "window_days": 10,
        "note": "La surenchère est formée par acte d'avocat.",
    }
    assert sale.sale_procedure["verification"]["case_source_count"] == 2
    assert sale.sale_procedure["verification"]["regulatory_sources"][0]["url"] == (JUDICIAL_RULES_SOURCE_URL)


def test_judicial_guarantee_observes_legal_minimum() -> None:
    sale = classify_sale_procedure(
        make_sale(starting_price_eur=Decimal("12000")),
        verified_at=VERIFIED_AT,
    )

    assert sale.sale_procedure["rules"]["guarantee"]["amount_eur"] == 3000.0


def test_classifies_verified_notarial_sale_and_extracts_deposit() -> None:
    sale = make_sale(
        source_name="notaires",
        source_url="https://www.immobilier.notaires.fr/fr/annonce/123",
        description=("Vente notariale devant Maître Martin. Consignation de 20 % de la mise à prix."),
        tribunal=None,
        tribunal_code=None,
        raw_payload={},
    )

    classified = classify_sale_procedure(sale, verified_at=VERIFIED_AT)

    assert classified.sale_venue_type == "notary"
    assert classified.sale_verification_status == "cross_checked"
    assert classified.sale_procedure["venue_name"] == "Me Martin"
    assert classified.sale_procedure["rules"]["lawyer_required"] is False
    assert classified.sale_procedure["rules"]["guarantee"]["rate_pct"] == 20.0
    assert classified.sale_procedure["rules"]["guarantee"]["status"] == "case_verified"


def test_uses_structured_notarial_details_as_case_evidence() -> None:
    sale = make_sale(
        source_name="notaires",
        source_url="https://www.immobilier.notaires.fr/fr/annonce/456",
        description="Vente notariale aux enchères.",
        lawyer_name="Me Durand",
        tribunal=None,
        tribunal_code=None,
        raw_payload={
            "source_blocks": {
                "consignation": 60000,
                "auction_location": "6 rue Mably, 33000 BORDEAUX",
            }
        },
    )

    classified = classify_sale_procedure(sale, verified_at=VERIFIED_AT)

    assert classified.sale_procedure["venue_address"] == "6 rue Mably, 33000 BORDEAUX"
    assert classified.sale_procedure["rules"]["guarantee"]["amount_eur"] == 60000.0
    assert classified.sale_procedure["rules"]["guarantee"]["status"] == "case_verified"


def test_uses_verified_source_organizer_category_for_notarial_venue() -> None:
    sale = make_sale(
        source_name="encheres_publiques",
        source_url="https://www.encheres-publiques.com/encheres/immobilier/lot_123",
        description="Vente volontaire organisée par Office du Parc.",
        lawyer_name="Office du Parc",
        tribunal=None,
        tribunal_code=None,
        raw_payload={
            "source_blocks": {
                "organisateur": "Office du Parc",
                "organisateur_categorie": "notaire",
            }
        },
    )

    classified = classify_sale_procedure(sale, verified_at=VERIFIED_AT)

    assert classified.sale_venue_type == "notary"
    assert classified.sale_verification_status == "verified"
    assert classified.sale_procedure["organizer_name"] == "Office du Parc"
    assert classified.sale_procedure["rules"]["lawyer_required"] is False


def test_does_not_present_address_only_court_as_verified_venue() -> None:
    sale = make_sale(description="Maison proposée aux enchères publiques.")

    classified = classify_sale_procedure(sale, verified_at=VERIFIED_AT)

    assert classified.sale_venue_type == "tribunal"
    assert classified.sale_verification_status == "pending"
    assert classified.sale_procedure["rules"]["lawyer_required"] is None
    assert classified.sale_procedure["venue_address"] is None
    assert classified.sale_procedure["verification"]["regulatory_sources"] == []
    assert "sale_procedure_unverified" in classified.quality_flags
    assert "n'est pas encore confirmé" in classified.sale_procedure["verification"]["issues"][0]


def test_reclassification_never_uses_derived_procedure_as_source_evidence() -> None:
    sale = make_sale(description="Maison proposée aux enchères publiques.")

    first = classify_sale_procedure(sale, verified_at=VERIFIED_AT)
    second = classify_sale_procedure(first, verified_at="2026-08-20T10:30:00+00:00")

    assert first.sale_verification_status == "pending"
    assert second.sale_verification_status == "pending"
    assert second.sale_procedure["rules"]["lawyer_required"] is None


def test_conflicting_explicit_venues_are_not_silently_resolved() -> None:
    sale = make_sale(
        description=(
            "Vente notariale organisée par la Chambre des notaires. "
            "Audience d'adjudication au Tribunal judiciaire de Bordeaux."
        )
    )

    classified = classify_sale_procedure(sale, verified_at=VERIFIED_AT)

    assert classified.sale_venue_type == "unknown"
    assert classified.sale_verification_status == "conflict"
    assert "sale_procedure_conflict" in classified.quality_flags
    assert classified.sale_procedure["rules"]["lawyer_required"] is None
