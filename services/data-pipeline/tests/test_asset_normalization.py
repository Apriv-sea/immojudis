import json
from decimal import Decimal
from pathlib import Path

import pytest

from src.asset_normalization import (
    MAX_NORMALIZATION_TEXT_CHARS,
    AssetNormalizationInputTooLarge,
    build_auction_features_row,
    build_auction_risk_rows,
    build_auction_score_factor_rows,
    build_auction_surfaces_row,
    extract_risk_occurrences_from_text,
    normalize_asset_features,
)
from src.models import AuctionSale
from src.normalize import normalize_sale


def test_asset_normalization_rejects_unbounded_regex_input() -> None:
    sale = AuctionSale(
        source_name="unit",
        source_url="https://example.test/oversized-normalization",
        raw_text="x" * (MAX_NORMALIZATION_TEXT_CHARS + 1),
    )

    with pytest.raises(AssetNormalizationInputTooLarge):
        normalize_asset_features(sale)


def test_build_auction_score_factor_rows_deduplicates_factor_keys() -> None:
    sale = AuctionSale(
        source_name="notaires",
        source_url="https://example.test/merged",
        score_factors=[
            {"factor_key": "occupation", "delta": 3, "reason": "source primaire"},
            {"factor_key": "occupation", "delta": -3, "reason": "source secondaire"},
            {"factor_key": "surface", "delta": 6, "reason": "surface retenue"},
        ],
    )

    rows = build_auction_score_factor_rows(sale)

    assert [row["factor_key"] for row in rows] == ["occupation", "surface"]


def test_normalize_asset_features_extracts_surfaces_features_and_score() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/sadirac",
            "city": "Sadirac",
            "property_type": "Maison",
            "starting_price_eur": "250 000 €",
            "occupancy_status": "occupied",
            "description": (
                "Maison avec surface habitable : 120 m², terrain d'environ 800 m², "
                "2 salles de bains, garage, jardin, terrasse, piscine. "
                "Bien occupé sans bail avec servitude et travaux."
            ),
        }
    )

    normalize_asset_features(sale)

    assert sale.habitable_surface_m2 == Decimal("120")
    assert sale.land_surface_m2 == Decimal("800")
    assert sale.app_surface_m2 == Decimal("120")
    assert sale.app_surface_kind == "habitable"
    assert sale.surface_scope == "total"
    assert sale.bathrooms_count == 2
    assert sale.parking_count == 1
    assert sale.has_garden is True
    assert sale.has_terrace is True
    assert sale.has_garage is True
    assert sale.has_pool is True
    assert sale.investment_score is not None
    assert "occupation" in (sale.investment_summary or "")
    assert "asset_normalization" in sale.raw_payload
    analysis = sale.raw_payload.get("investment_analysis") or {}
    assert analysis["version"] == "premium_due_diligence_v1"
    assert analysis["facts"]
    assert analysis["axes"]
    assert any(item["key"] == "surface" for item in analysis["questions"])


def test_normalize_asset_features_reads_thousands_surfaces_directly() -> None:
    sale = AuctionSale(
        source_name="unit",
        source_url="https://example.test/asset-thousands",
        property_type="house",
        raw_text="Maison. Surface habitable : 2 464,70 m². Terrain d'environ 3 587,40 m².",
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("2464.70")
    assert sale.habitable_surface_m2 == Decimal("2464.70")
    assert sale.land_surface_m2 == Decimal("3587.40")
    assert sale.app_surface_m2 == Decimal("2464.70")
    assert "2 464,70 m²" in (sale.surface_evidence or "")


def test_asset_normalization_resolves_structured_surface_outlier_from_corroborated_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "unit",
            "source_url": "https://example.test/surface-conflict",
            "property_type": "Maison",
            "title": "Un ensemble immobilier de 187 m² situé rue Gâte-Bourse",
            "description": (
                "Un ensemble immobilier de 10 pièces de 187 m² avec un garage de 18 m², "
                "édifié sur une parcelle de 1 110 m²."
            ),
            "surface_m2": 1877,
            "habitable_surface_m2": 1877,
            "land_surface_m2": 110,
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("187")
    assert sale.habitable_surface_m2 is None
    assert sale.app_surface_kind == "built"
    assert sale.land_surface_m2 == Decimal("1110")
    assert sale.app_surface_m2 == Decimal("187")
    assert sale.surface_source == "corroborated_source_text"
    assert sale.surface_confidence == Decimal("0.92")
    assert "surface_conflict_resolved" in sale.quality_flags
    assert sale.raw_payload["surface_reconciliation"] == {
        "status": "resolved",
        "rejected_surface_m2": "1877",
        "resolved_built_surface_m2": "187",
        "basis": "matching_title_and_description",
    }
    assert sale.raw_payload["land_surface_reconciliation"] == {
        "status": "resolved",
        "rejected_land_surface_m2": "110",
        "resolved_land_surface_m2": "1110",
        "basis": "explicit_land_text_over_stored_value",
    }


def test_asset_normalization_resolves_apartment_surface_outlier_from_corroborated_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "unit",
            "source_url": "https://example.test/apartment-surface-conflict",
            "property_type": "Appartement",
            "title": "Appartement de 187 m²",
            "description": "Appartement de 187 m² avec balcon, édifié sur une parcelle de 1 110 m².",
            "surface_m2": 1877,
            "habitable_surface_m2": 1877,
            "carrez_surface_m2": 1877,
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("187")
    assert sale.habitable_surface_m2 is None
    assert sale.app_surface_kind == "built"
    assert sale.carrez_surface_m2 is None
    assert sale.land_surface_m2 is None
    assert sale.app_surface_m2 == Decimal("187")
    assert sale.raw_payload["surface_reconciliation"]["rejected_surface_m2"] == "1877"


def test_asset_normalization_prefers_value_before_carrez_label() -> None:
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://example.test/apartment-balcony-conflict",
            "property_type": "Appartement",
            "title": "Appartement 9 m²",
            "description": (
                "L'appartement de 40 m² habitables (39,67 m² Loi Carrez) "
                "avec 9 m² de balcon se compose d'une chambre et d'un séjour."
            ),
            "surface_m2": 9,
            "habitable_surface_m2": 39.67,
            "carrez_surface_m2": 40,
            "app_surface_m2": 40,
        }
    )

    normalize_asset_features(sale)

    assert sale.carrez_surface_m2 == Decimal("39.67")
    assert sale.app_surface_m2 == Decimal("39.67")
    assert sale.app_surface_kind == "carrez"
    assert sale.raw_payload["carrez_surface_reconciliation"] == {
        "status": "resolved",
        "rejected_carrez_surface_m2": "40",
        "resolved_carrez_surface_m2": "39.67",
        "basis": "explicit_decimal_carrez_text",
    }


def test_asset_normalization_corrects_truncated_stored_land_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "unit",
            "source_url": "https://example.test/truncated-land-surface",
            "property_type": "Maison",
            "surface_m2": 187,
            "habitable_surface_m2": 187,
            "land_surface_m2": 110,
            "description": "Maison de 187 m² édifiée sur une parcelle de 1 110 m².",
            "risk_notes": "Risques physiques: DPE F | DPE F",
        }
    )

    normalize_asset_features(sale)

    assert sale.land_surface_m2 == Decimal("1110")
    assert "land_surface_conflict_resolved" in sale.quality_flags


def test_asset_normalization_keeps_document_backed_land_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "unit",
            "source_url": "https://example.test/documented-land-surface",
            "property_type": "Maison",
            "surface_m2": 187,
            "habitable_surface_m2": 187,
            "land_surface_m2": 110,
            "description": "Maison de 187 m² édifiée sur une parcelle annoncée de 1 110 m².",
            "land_surface_extraction": {"source": "pdf", "value_m2": 110},
        }
    )

    normalize_asset_features(sale)

    assert sale.land_surface_m2 == Decimal("110")
    assert "land_surface_conflict_resolved" not in sale.quality_flags


def test_asset_normalization_removes_built_surface_misclassified_as_land() -> None:
    sale = normalize_sale(
        {
            "source_name": "unit",
            "source_url": "https://example.test/built-duplicated-as-land",
            "property_type": "Maison",
            "title": "Maison de 125,05 m²",
            "surface_m2": 125.05,
            "habitable_surface_m2": 125.05,
            "land_surface_m2": 125.05,
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("125.05")
    assert sale.app_surface_m2 == Decimal("125.05")
    assert sale.land_surface_m2 is None
    assert sale.raw_payload["land_surface_reconciliation"] == {
        "status": "removed",
        "rejected_land_surface_m2": "125.05",
        "resolved_land_surface_m2": None,
        "basis": "duplicated_built_surface_without_land_evidence",
    }


def test_asset_normalization_replaces_duplicated_built_land_with_explicit_terrain() -> None:
    sale = normalize_sale(
        {
            "source_name": "unit",
            "source_url": "https://example.test/explicit-land-replacement",
            "property_type": "Maison",
            "surface_m2": 125,
            "habitable_surface_m2": 125,
            "land_surface_m2": 125,
            "description": "Maison de 125 m² édifiée sur un terrain d'environ 500 m².",
        }
    )

    normalize_asset_features(sale)

    assert sale.land_surface_m2 == Decimal("500")
    assert sale.raw_payload["land_surface_reconciliation"]["basis"] == (
        "explicit_land_text_over_stored_value"
    )


def test_asset_normalization_keeps_structured_surface_when_textual_values_disagree() -> None:
    sale = normalize_sale(
        {
            "source_name": "unit",
            "source_url": "https://example.test/surface-conflict-unresolved",
            "property_type": "Maison",
            "title": "Maison de 180 m²",
            "description": "Maison de 170 m² selon une ancienne annonce.",
            "surface_m2": 175,
            "habitable_surface_m2": 175,
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("175")
    assert sale.habitable_surface_m2 == Decimal("175")
    assert "surface_conflict_resolved" not in sale.quality_flags


def test_asset_normalization_keeps_document_backed_surface_over_editorial_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "unit",
            "source_url": "https://example.test/documented-surface",
            "property_type": "Maison",
            "title": "Maison de 180 m²",
            "description": "Maison de 180 m² selon l'annonce.",
            "surface_m2": 175,
            "habitable_surface_m2": 175,
            "surface_source": "pdf",
            "surface_extraction": {"source": "pdf", "value_m2": 175},
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("175")
    assert sale.habitable_surface_m2 == Decimal("175")
    assert sale.surface_source == "pdf"
    assert "surface_conflict_resolved" not in sale.quality_flags


def test_notaires_short_house_code_promotes_surface_to_app_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://www.immobilier.notaires.fr/fr/annonce-immo/adjudication/maison/le-bouscat-33/1741074",
            "property_type": "MAI",
            "title": "Maison 5 pièces (R+1)de 106 m² env avec jardin",
            "surface_m2": 106,
        }
    )

    normalize_asset_features(sale)

    assert sale.property_type == "house"
    assert sale.habitable_surface_m2 is None
    assert sale.app_surface_m2 == Decimal("106")
    assert sale.app_surface_kind == "built"
    assert "ambiguous_surface" not in sale.quality_flags


def test_notaires_cadastral_surface_does_not_become_habitable_area() -> None:
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://www.immobilier.notaires.fr/fr/annonce-immo/adjudication/maison/bordeaux-33/1963348",
            "property_type": "MAI",
            "surface_m2": 1,
            "habitable_surface_m2": 1,
            "description": "Une maison à réhabiliter. Cadastrée section CT n°363 pour un total de 44 m².",
        }
    )

    normalize_asset_features(sale)

    assert sale.property_type == "house"
    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 is None
    assert sale.land_surface_m2 == Decimal("44")
    assert sale.app_surface_m2 is None
    assert sale.surface_scope == "land"
    assert "ambiguous_surface" not in sale.quality_flags


def test_normalize_asset_features_prefers_explicit_land_surface_over_tiny_ui_ratio() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/une-maison-dhabitation-a-valserhone",
            "property_type": "Maison",
            "raw_text": (
                "Une maison a usage d'habitation avec terrain attenant, cadastrée Section AM "
                "numéro 23, pour 02 ares 20 centiares. Surface habitable de 89,58 m². "
                "Terrain : 0.22 m². Informations complémentaires : Surface terrain d'environ "
                "220 m²."
            ),
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("89.58")
    assert sale.land_surface_m2 == Decimal("220")


def test_asset_rows_are_storage_ready() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/appartement",
            "property_type": "Appartement",
            "surface_m2": "39,82 m2",
            "description": "Appartement loi Carrez 39,82 m² avec double vitrage. DPE classe G mentionné.",
        }
    )

    normalize_asset_features(sale)

    features = build_auction_features_row(sale)
    surfaces = build_auction_surfaces_row(sale)
    risks = build_auction_risk_rows(sale)

    assert features["has_double_glazing"] is True
    assert features["investment_score"] is not None
    assert surfaces["carrez_surface_m2"] == 39.82
    assert surfaces["app_surface_m2"] == 39.82
    assert surfaces["app_surface_kind"] == "carrez"
    assert any(row["risk_label"] == "DPE" for row in risks)
    assert sale.score_confidence is not None
    assert build_auction_score_factor_rows(sale)
    price_factor = next(row for row in sale.score_factors if row["factor_key"] == "prix_m2")
    assert price_factor["normalized_value"]["axis"] == "financial_attractiveness"
    assert price_factor["normalized_value"]["question"]


def test_risk_occurrences_keep_pdf_provenance_and_skip_negated_servitude() -> None:
    text = (
        "Le cahier précise qu'aucune servitude connue n'est mentionnée. "
        "Le procès-verbal décrit une toiture en mauvais état avec gros travaux à prévoir."
    )

    rows = extract_risk_occurrences_from_text(
        text,
        "https://example.test/provenance",
        source_kind="pdf",
        document_url="https://example.test/pv.pdf",
        document_label="PV descriptif",
        document_type="pv_huissier",
        page_number=7,
    )

    assert not any(row["risk_label"] == "servitude" for row in rows)
    travaux = next(row for row in rows if row["risk_label"] == "travaux")
    assert travaux["document_label"] == "PV descriptif"
    assert travaux["document_type"] == "pv_huissier"
    assert travaux["page_number"] == 7
    assert travaux["confidence"] > 0.7


def test_risk_detection_rejects_generic_cahier_conditions_clauses() -> None:
    text = (
        "ARTICLE 27 - IMMEUBLES EN COPROPRIETE. "
        "Dans le cas où l'immeuble vendu dépend d'un ensemble en copropriété, "
        "l'adjudicataire est tenu de notifier au syndic. "
        "Le dossier comprend un constat de repérage amiante et un constat de risque "
        "d'exposition au plomb annexés au cahier."
    )

    rows = extract_risk_occurrences_from_text(
        text,
        "https://example.test/ccv",
        source_kind="pdf",
        document_type="cahier_conditions_vente",
    )

    assert rows == []


def test_risk_detection_requires_positive_diagnostic_result() -> None:
    inventory_text = "Diagnostics annexés : DPE, constat amiante, CREP plomb, état termites."
    negative_lead_text = (
        "Constat de risque d'exposition au plomb. Ce document ne constate pas "
        "de revêtements dégradés contenant du plomb. La quantité relevée ne dépasse pas "
        "le plafond fixé par arrêté."
    )
    ocr_negative_lead_text = (
        "Ce document prouve l'absence de revetements contenant du plomb ou de l'existence "
        "de revetement contenant du plomb en quantite telle qu'elle ne depassepas le plafond "
        "fixe par l'arrete du 25 avril 2006."
    )
    positive_text = (
        "Diagnostic technique. Présence d'amiante repérée dans les dalles de sol. "
        "Le CREP indique des revêtements contenant du plomb."
    )

    assert (
        extract_risk_occurrences_from_text(
            inventory_text,
            "https://example.test/diag-inventory",
            source_kind="pdf",
            document_type="diagnostics_techniques",
        )
        == []
    )
    assert (
        extract_risk_occurrences_from_text(
            negative_lead_text,
            "https://example.test/diag-lead-negative",
            source_kind="pdf",
            document_type="diagnostics_techniques",
        )
        == []
    )
    assert (
        extract_risk_occurrences_from_text(
            ocr_negative_lead_text,
            "https://example.test/diag-lead-ocr-negative",
            source_kind="pdf",
            document_type="diagnostics_techniques",
        )
        == []
    )

    rows = extract_risk_occurrences_from_text(
        positive_text,
        "https://example.test/diag-positive",
        source_kind="pdf",
        document_type="diagnostics_techniques",
    )

    assert {row["risk_label"] for row in rows} == {"amiante", "plomb"}


def test_document_consistency_corrects_studio_type_and_uncertain_occupation() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/studio-conflict",
            "city": "Bordeaux",
            "property_type": "Immeuble",
            "occupancy_status": "vacant",
            "description": "Studio vendu libre selon l'annonce.",
            "raw_text": (
                "Le bien correspond à un appartement de type studio situé en rez-de-chaussée. "
                "Le logement est actuellement occupé suivant un bail meublé en date du 13/07/2025 "
                "pour un loyer mensuel de 745 euros charges comprises. "
                "Surfacehabitable : 21 m2."
            ),
        }
    )

    normalize_asset_features(sale)

    assert sale.property_type == "apartment"
    assert sale.occupancy_status == "unknown"
    assert sale.habitable_surface_m2 == Decimal("21")
    assert sale.app_surface_m2 == Decimal("21")
    rules = sale.raw_payload.get("business_rules") or []
    rule_ids = {rule["rule_id"] for rule in rules}
    assert "property_type_from_specific_asset" in rule_ids
    assert "occupation_conflict_requires_confirmation" in rule_ids
    occupation_factor = next(row for row in sale.score_factors if row["factor_key"] == "occupation")
    assert "bail ou locataire" in occupation_factor["reason"]
    assert occupation_factor["evidence_refs"]


def test_risk_detection_accepts_property_specific_copropriete() -> None:
    rows = extract_risk_occurrences_from_text(
        "Le lot numéro 12 dépend d'un ensemble immobilier soumis au régime de la copropriété "
        "avec 320 tantièmes des parties communes.",
        "https://example.test/copro",
        source_kind="pdf",
        document_type="annonce_vente",
    )

    assert [row["risk_label"] for row in rows] == ["copropriété"]


def test_asset_normalization_drops_apartment_land_surface_without_ambiguous_flag() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/surface-ambiguous",
            "property_type": "Appartement",
            "surface_m2": "50 m2",
            "land_surface_m2": "600 m2",
            "description": "Appartement avec parcelle de terrain.",
        }
    )

    normalize_asset_features(sale)

    assert sale.land_surface_m2 is None
    assert "missing_gps" in sale.quality_flags
    assert "ambiguous_surface" not in sale.quality_flags


def test_asset_normalization_ignores_apartment_cadastral_surface_for_ambiguity() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/un-appartement-et-cave-a-chenove",
            "property_type": "Appartement",
            "raw_text": (
                "1 pièces 34.52 m² superficie À propos du bien CHENOVE (21300), "
                "54 Boulevard Edouard Branly, Cadastré section AI, numéro 125 pour "
                "11a 92ca Lots 7 et 103. Un appartement comprenant : entrée, cuisine, séjour."
            ),
        }
    )

    normalize_asset_features(sale)

    assert sale.rooms_count == 1
    assert sale.app_surface_m2 == Decimal("34.52")
    assert sale.land_surface_m2 is None
    assert "ambiguous_surface" not in sale.quality_flags


def test_asset_normalization_infers_rooms_from_composition_summary() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/composition",
            "property_type": "Maison",
            "description": "Maison comprenant séjour, cuisine, 3 chambres, mezzanine avec deux pièces.",
        }
    )

    normalize_asset_features(sale)

    assert sale.bedrooms_count == 3
    assert sale.rooms_count == 6


def test_scoring_truthset_risk_context_rules() -> None:
    truthset_path = Path(__file__).parent / "fixtures" / "scoring_truthset.json"
    cases = json.loads(truthset_path.read_text(encoding="utf-8"))

    for case in cases:
        rows = extract_risk_occurrences_from_text(
            case["text"],
            f"https://example.test/truthset/{case['name']}",
            source_kind="pdf",
            document_type=case["document_type"],
        )
        labels = {row["risk_label"] for row in rows}
        assert set(case["expected_risks"]).issubset(labels), case["name"]
        assert not (set(case["unexpected_risks"]) & labels), case["name"]
        for row in rows:
            assert row["confidence"] > 0
            assert row["risk_status"] in {
                "confirmed",
                "probable",
                "to_verify",
                "to_quantify",
                "property_specific_clause",
            }


def test_asset_normalization_does_not_double_count_repeated_mezzanine_mentions() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/repeated-composition",
            "property_type": "Maison",
            "description": (
                "Maison comprenant salon, salle à manger, 3 chambres, mezzanine avec deux pièces. "
                "Le cahier rappelle: salon, salle à manger, 3 chambres, mezzanine avec deux pièces."
            ),
        }
    )

    normalize_asset_features(sale)

    assert sale.rooms_count == 7


def test_asset_normalization_clears_impossible_room_bedroom_conflict() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/room-conflict",
            "property_type": "Maison",
            "rooms_count": 2,
            "bedrooms_count": 3,
            "description": "Maison avec trois chambres.",
        }
    )

    normalize_asset_features(sale)

    assert sale.rooms_count is None
    assert sale.bedrooms_count == 3
    assert "room_count_conflict" in sale.quality_flags
    contradictions = sale.raw_payload["investment_analysis"]["contradictions"]
    assert any(item["key"] == "room_count_conflict" for item in contradictions)


def test_asset_normalization_uses_built_surface_for_commercial_assets() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/local",
            "property_type": "Local commercial",
            "description": "Un bâtiment d'une superficie au sol de 846,22 m² dont 426,07 m² loi Carrez.",
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("846.22")
    assert sale.carrez_surface_m2 == Decimal("426.07")
    assert sale.app_surface_m2 == Decimal("846.22")
    assert sale.app_surface_kind == "built"
    assert sale.surface_scope == "total"
    assert sale.surface_evidence is not None


def test_asset_normalization_uses_built_surface_for_buildings() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-immeuble-158.html",
            "property_type": "Immeuble",
            "description": "Immeuble d'une surface totale bâtie de 158,95 m².",
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("158.95")
    assert sale.app_surface_m2 == Decimal("158.95")
    assert sale.app_surface_kind == "built"
    assert sale.surface_scope == "total"


def test_asset_normalization_repairs_legacy_truncated_thousands_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/109084.html",
            "property_type": "Immeuble",
            "surface_m2": "612",
            "description": (
                "Un immeuble de 2.612 m², consistant en un grand espace vert "
                "incorporé dans une ruche d'entreprises."
            ),
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("2612")
    assert sale.app_surface_m2 == Decimal("2612")
    assert sale.app_surface_kind == "built"
    assert sale.surface_scope == "total"


def test_asset_normalization_keeps_supported_large_mixed_surface_and_specific_title() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/batiment-agricole-haut-valromey",
            "title": "Autres",
            "property_type": "Autres",
            "address": "01260 Haut-Valromey, France",
            "starting_price_eur": "35 000,00 €",
            "sale_date": "mardi 30 juin 2026 à 14h00",
            "raw_text": (
                "Vente aux enchères Autres UN BATIMENT D'EXPLOITATION AGRICOLE ET DIVERSES "
                "PARCELLES DE TERRAIN AGRICOLE EN NATURE DE PRE A HAUT-VALROMEY "
                "01260 Haut-Valromey, France Mise à prix : 35 000 euros. "
                "Surface totale : 2.464,70 m². Stabulation libre : 811 m². "
                "Salle de traite : 45,30 m². Stockage : 1183 m². Hangar : 25 m². "
                "Le bâtiment agricole est libre de toute occupation."
            ),
        }
    )

    normalize_asset_features(sale)

    assert sale.title.startswith("UN BATIMENT D'EXPLOITATION AGRICOLE")
    assert sale.property_type == "mixed"
    assert sale.surface_m2 == Decimal("2464.70")
    assert sale.app_surface_m2 == Decimal("2464.70")
    assert sale.app_surface_kind == "built"
    assert sale.surface_scope == "total"
    assert "ambiguous_surface" not in sale.quality_flags


def test_asset_normalization_prefers_source_description_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/maison-dhabitation-124",
            "property_type": "Maison",
            "surface_m2": "50",
            "raw_text": (
                "Une maison d'habitation d’une superficie de 110 m2 composée de 3 chambres, "
                "grand séjour, salle d'eau, cuisine, chaufferie. "
                "Une ancienne maison de 2 pièces principales à usage de dépendance."
            ),
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("110")
    assert sale.habitable_surface_m2 is None
    assert sale.app_surface_kind == "built"
    assert sale.app_surface_m2 == Decimal("110")
    assert sale.rooms_count == 4


def test_asset_normalization_reads_surface_value_before_surface_label() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/maison-a-biganos-2",
            "property_type": "Maison",
            "raw_text": "5 pièces 3 chambres 93.16 m² superficie.",
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("93.16")
    assert sale.habitable_surface_m2 is None
    assert sale.app_surface_kind == "built"


def test_asset_normalization_reads_licitor_apartment_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/un-appartement/pau/109107.html",
            "property_type": "Appartement",
            "raw_text": "Un appartement de 79,06 m², de trois pièces deux places de parking.",
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("79.06")
    assert sale.habitable_surface_m2 is None
    assert sale.carrez_surface_m2 is None
    assert sale.app_surface_kind == "built"
    assert sale.rooms_count == 3
    assert sale.parking_count == 2


def test_asset_normalization_recovers_licitor_surface_with_missing_m_symbol() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/109135.html",
            "property_type": "Un bâtiment à usage de bureaux",
            "description": (
                "Un bâtiment à usage de bureaux. de 636,70 ², comprenant vingt bureaux, "
                "une cuisine et des salles de réunion."
            ),
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("636.70")
    assert sale.app_surface_m2 == Decimal("636.70")
    assert sale.app_surface_kind == "built"
    assert sale.surface_scope == "total"


def test_asset_normalization_rejects_room_surface_as_app_surface_for_house() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/room-surface",
            "property_type": "Maison",
            "description": "Maison avec garage d'une superficie d'environ 15,17 m2 sur terrain de 597 m2.",
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_scope == "room_or_annex"
    assert sale.app_surface_m2 is None
    assert "ambiguous_surface" in sale.quality_flags


def test_asset_normalization_rejects_large_uncertain_surface_as_app_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/large-surface",
            "property_type": "Local commercial",
            "description": "Ensemble immobilier avec mentions cadastrales d'une superficie au sol de 1111,81 m2.",
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_scope == "unknown"
    assert sale.app_surface_m2 is None
    assert "ambiguous_surface" in sale.quality_flags


def test_asset_normalization_restores_partial_scope_from_pdf_extraction() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-6009.html",
            "property_type": "Appartement",
            "title": "Appartement 4 m²",
            "surface_m2": "3.78",
            "carrez_surface_m2": "3.78",
            "app_surface_m2": "3.78",
            "app_surface_kind": "carrez",
            "surface_scope": "total",
            "surface_source": "pdf",
            "surface_extraction": {
                "source": "pdf",
                "value_m2": "3.78",
                "surface_scope": "partial",
            },
        }
    )

    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("3.78")
    assert sale.carrez_surface_m2 == Decimal("3.78")
    assert sale.app_surface_m2 is None
    assert sale.app_surface_kind is None
    assert sale.surface_scope == "partial"
    assert sale.title == "Appartement"
    assert "partial_surface_scope_restored" in sale.quality_flags
    assert sale.raw_payload["surface_scope_reconciliation"] == {
        "status": "restored",
        "previous_scope": "total",
        "rejected_app_surface_m2": "3.78",
        "documented_partial_surface_m2": "3.78",
        "basis": "structured_pdf_extraction_scope",
    }


def test_partial_pdf_scope_does_not_override_a_distinct_total_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-with-total.html",
            "property_type": "Appartement",
            "surface_m2": "87",
            "carrez_surface_m2": "87",
            "app_surface_m2": "87",
            "app_surface_kind": "carrez",
            "surface_scope": "total",
            "surface_extraction": {
                "source": "pdf",
                "value_m2": "3.78",
                "surface_scope": "partial",
            },
        }
    )

    normalize_asset_features(sale)

    assert sale.app_surface_m2 == Decimal("87")
    assert sale.surface_scope == "total"
    assert "partial_surface_scope_restored" not in sale.quality_flags


def test_scoring_rewards_solid_free_discounted_asset() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/solid-score",
            "city": "Bordeaux",
            "department": "33",
            "property_type": "Appartement",
            "starting_price_eur": "80 000 €",
            "occupancy_status": "vacant",
            "latitude": 44.8378,
            "longitude": -0.5792,
            "rooms_count": 2,
            "bedrooms_count": 1,
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
            "description": "Appartement libre. Surface loi Carrez 50 m². Bon état. Terrasse et parking.",
        }
    )

    normalize_asset_features(sale)

    assert sale.investment_score is not None
    assert sale.investment_score >= Decimal("75")
    assert "prix_m2: mise à prix attractive" in (sale.investment_summary or "")
    assert "qualité: données exploitables" in (sale.investment_summary or "")


def test_scoring_penalizes_ambiguous_missing_core_data() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/weak-score",
            "city": "Village",
            "department": "24",
            "property_type": "Maison",
            "description": "Maison avec garage d'une superficie d'environ 15,17 m2. Travaux à prévoir.",
        }
    )

    normalize_asset_features(sale)

    assert sale.app_surface_m2 is None
    assert sale.investment_score is not None
    assert sale.investment_score <= Decimal("35")
    assert "surface: surface ambiguë" in (sale.investment_summary or "")
    assert "qualité:" in (sale.investment_summary or "")


def test_scoring_penalizes_occupied_risky_asset_despite_amenities() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/risky-score",
            "city": "Pau",
            "department": "64",
            "property_type": "Maison",
            "starting_price_eur": "300 000 €",
            "occupancy_status": "occupied",
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
            "description": (
                "Maison occupée sans bail. Surface habitable : 100 m². Jardin, garage. "
                "Présence amiante, plomb, servitude et gros travaux."
            ),
        }
    )

    normalize_asset_features(sale)

    assert sale.investment_score is not None
    assert sale.investment_score < Decimal("55")
    assert "occupation: occupé" in (sale.investment_summary or "")
    assert "risques:" in (sale.investment_summary or "")


def test_scoring_treats_renovation_source_listing_as_works_not_good_condition() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://example.test/encheres-publiques-renovation",
            "city": "Bordeaux",
            "department": "33",
            "property_type": "Appartements",
            "title": "Appartement T4 en duplex à rénover 103,19 m² carrez",
            "starting_price_eur": "340 000 €",
            "surface_m2": "103.16",
            "description": (
                "Type de vente: En ligne - Vente volontaire. OFFICE NOTARIAL DU JEU DE PAUME. "
                "Appartement de type T4 au rez-de-chaussée côté cour intérieure. "
                "PREVOIR TRAVAUX DE RENOVATION. Diagnostic: DPE C, GES C."
            ),
            "documents": [],
        }
    )

    normalize_asset_features(sale)

    condition = next(row for row in sale.score_factors if row["factor_key"] == "état")
    risks = sale.raw_payload["asset_normalization"]["risks"]
    analysis = sale.raw_payload["investment_analysis"]

    assert any(risk["risk_label"] == "travaux" for risk in risks)
    assert condition["delta"] < 0
    assert "travaux" in condition["reason"]
    assert "bon état" not in (sale.investment_summary or "")
    assert analysis["headline"].startswith("Pré-tri uniquement")
    assert any(fact["key"] == "type_de_vente" for fact in analysis["facts"])
    assert "source_page_only" in sale.quality_flags


def test_scoring_never_presents_missing_documents_as_absence_of_risk() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://example.test/no-documents",
            "city": "Bordeaux",
            "department": "33",
            "property_type": "Appartement",
            "starting_price_eur": "200 000 €",
            "surface_m2": "60",
            "description": "Appartement avec terrasse. Type de vente: En ligne - Vente volontaire.",
            "documents": [],
        }
    )

    normalize_asset_features(sale)

    risks_factor = next(row for row in sale.score_factors if row["factor_key"] == "risques")
    quality_factor = next(row for row in sale.score_factors if row["factor_key"] == "qualité")
    analysis = sale.raw_payload["investment_analysis"]

    assert "pièces officielles absentes" in risks_factor["reason"]
    assert "absence de risque" in risks_factor["normalized_value"]["calculation"]
    assert quality_factor["delta"] <= -6
    assert "analyse_source_uniquement" in analysis["confidence_gates"]["weak_points"]
