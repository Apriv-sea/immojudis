from decimal import Decimal

from src.asset_normalization import normalize_asset_features
from src.enrichment.surface_reasoning import (
    ExtractedAsset,
    SurfaceCandidate,
    SurfaceEvidence,
    SurfaceMeasurement,
    apply_surface_reasoning_to_sale,
    extract_surface_facts_from_text,
    reason_about_surfaces,
)
from src.models import AuctionSale
from src.sources.encheres_immobilieres import _extract_surface


def test_brouilla_room_measurements_produce_verified_calculated_surface() -> None:
    text = (
        "Le bien se compose d'une entrée (0,92m2), séjour (19,56m2), cuisine (5,22m2), "
        "2 chambres (10,29m2+10,35m2), bureau (7,29m2), salle d’eau (4,11m2)."
    )
    asset = extract_surface_facts_from_text(text)

    assert asset is not None
    result = reason_about_surfaces([asset], context=text, property_type="house")

    assert result.selected is not None
    assert result.selected.kind == "calculated_room_sum"
    assert result.selected.value_m2 == Decimal("57.74")
    assert result.selected.validation_status == "verified"
    assert len(result.selected.operand_measurement_ids) == 7


def test_beauregard_arithmetic_reconciles_obvious_m3_unit_typo() -> None:
    text = (
        "Le bien comprend une entrée 8,92 m², séjour 13,08 m², WC 0,48 m², "
        "salon 27,19 m², chambre 11,45 m², salle d'eau 3,68 m². "
        "Surface habitable de 64.80 m³ (Loi Carrez)."
    )
    asset = extract_surface_facts_from_text(text)

    assert asset is not None
    result = reason_about_surfaces([asset], context=text, property_type="apartment")

    assert result.selected is not None
    assert result.selected.value_m2 == Decimal("64.80")
    assert result.selected.kind == "explicit_carrez"
    assert "unit_m3_reconciled_as_area_from_room_sum" in result.selected.warnings


def test_pouzols_prefers_explicit_total_over_first_garage_measurement() -> None:
    text = "Garage 12.04 m². SURFACE habitable totale (Loi Carrez hors garage): 98.06 m²."

    assert _extract_surface(text) == "98.06"

    sale = AuctionSale(
        source_name="encheres_immobilieres",
        source_url="https://example.test/pouzols",
        property_type="house",
        surface_m2=Decimal("12.04"),
        habitable_surface_m2=Decimal("12.04"),
        raw_text=text,
    )
    asset = extract_surface_facts_from_text(text)
    assert asset is not None
    apply_surface_reasoning_to_sale(sale, [asset], context=text, source="test")
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("98.06")
    assert sale.habitable_surface_m2 == Decimal("98.06")
    assert sale.app_surface_m2 == Decimal("98.06")


def test_multi_lot_sale_keeps_assets_separate_then_calculates_auction_total() -> None:
    context = "Lot 14 : logement de 11,47 m². Lot 15 : logement de 12 m². Les deux lots sont vendus ensemble."
    assets = [
        _explicit_asset("asset-lot-14", "lot 14", Decimal("11.47"), "Lot 14 : logement de 11,47 m²."),
        _explicit_asset("asset-lot-15", "lot 15", Decimal("12"), "Lot 15 : logement de 12 m²."),
    ]

    result = reason_about_surfaces(assets, context=context, property_type="building")

    assert result.selected is not None
    assert result.selected.kind == "calculated_sale_sum"
    assert result.selected.value_m2 == Decimal("23.47")
    assert {item.asset_id for item in result.derivations if item.asset_id != "sale-total"} == {
        "asset-lot-14",
        "asset-lot-15",
    }


def test_annexes_are_excluded_from_room_sum() -> None:
    text = (
        "Le bien se compose d'un séjour 25 m², cuisine 8 m², chambre 12 m², "
        "salle d'eau 4 m², garage 18 m², terrasse 10 m²."
    )
    asset = extract_surface_facts_from_text(text)
    assert asset is not None

    result = reason_about_surfaces([asset], context=text, property_type="house")

    assert result.selected is not None
    assert result.selected.value_m2 == Decimal("49.00")
    included = {
        item.space_label
        for item in result.measurements
        if item.measurement_id in result.selected.operand_measurement_ids
    }
    assert "garage" not in included
    assert "terrasse" not in included


def test_repeated_room_set_across_documents_is_not_double_counted() -> None:
    asset = ExtractedAsset(
        asset_id="asset-main",
        measurement_completeness="complete",
        spaces=[
            _measurement("séjour", "20", "PV", "Séjour 20 m²"),
            _measurement("chambre", "10", "PV", "Chambre 10 m²"),
            _measurement("séjour", "20", "diagnostic", "Séjour 20 m²"),
            _measurement("chambre", "10", "diagnostic", "Chambre 10 m²"),
        ],
    )
    context = "PV Séjour 20 m² Chambre 10 m² diagnostic Séjour 20 m² Chambre 10 m²"

    result = reason_about_surfaces([asset], context=context, property_type="apartment")

    assert result.selected is not None
    assert result.selected.value_m2 == Decimal("30.00")
    assert len(result.selected.operand_measurement_ids) == 2


def test_unsupported_llm_measurement_is_rejected() -> None:
    asset = ExtractedAsset(
        spaces=[
            SurfaceMeasurement(
                space_label="séjour",
                category="habitable",
                value_m2="90",
                included_in_habitable_sum=True,
                confidence=0.99,
                evidence=SurfaceEvidence(quote="Séjour 90 m²"),
            )
        ]
    )

    result = reason_about_surfaces([asset], context="Le document ne donne aucune mesure.", property_type="house")

    assert result.selected is None
    assert result.rejected_measurements[0]["reason"] == "evidence_quote_not_found"


def test_zero_surface_candidate_is_ignored_without_losing_valid_pdf_evidence() -> None:
    text = (
        "Surface habitable : 0,00 m². Loi Carrez 72,50 m². "
        "Le bien comprend séjour 20 m² et chambre 10 m²."
    )
    asset = extract_surface_facts_from_text(text, document_label="PV descriptif")

    assert asset is not None
    assert [candidate.value_m2 for candidate in asset.explicit_surfaces] == [Decimal("72.50")]
    assert "Loi Carrez" in (asset.explicit_surfaces[0].evidence.quote or "")

    result = reason_about_surfaces([asset], context=text, property_type="apartment")

    assert result.selected is not None
    assert result.selected.value_m2 == Decimal("72.50")
    assert result.contradictions


def _explicit_asset(asset_id: str, lot: str, value: Decimal, quote: str) -> ExtractedAsset:
    return ExtractedAsset(
        asset_id=asset_id,
        lot_labels=[lot],
        property_type="apartment",
        measurement_completeness="complete",
        explicit_surfaces=[
            SurfaceCandidate(
                asset_id=asset_id,
                value_m2=value,
                kind="explicit_habitable",
                scope="lot",
                confidence=0.97,
                evidence=SurfaceEvidence(quote=quote),
            )
        ],
    )


def _measurement(label: str, value: str, document_label: str, quote: str) -> SurfaceMeasurement:
    return SurfaceMeasurement(
        space_label=label,
        category="habitable",
        value_m2=value,
        included_in_habitable_sum=True,
        confidence=0.95,
        evidence=SurfaceEvidence(quote=quote, document_label=document_label),
    )
