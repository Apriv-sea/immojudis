from decimal import Decimal

import pytest

from src.asset_normalization import extract_risk_occurrences_from_text
from src.asset_scoring import _score_sale
from src.models import AuctionSale
from src.normalize import normalize_sale


def test_reviewed_risk_without_severity_withholds_old_score_and_analysis() -> None:
    sale = AuctionSale(
        source_name="unit", source_url="https://example.test/reviewed-risk",
        investment_score=Decimal("88"), score_confidence=Decimal("0.9"),
        score_version="old", score_factors=[{"old": True}],
        raw_payload={"investment_analysis": {"old": True}, "score_factors": [{"old": True}]},
    )
    _score_sale(sale, [{"risk_label": "Contrôle parasitaire incomplet", "severity": None}])
    assert sale.investment_score is None
    assert sale.score_confidence is None
    assert sale.score_version is None
    assert sale.score_factors == []
    assert "investment_analysis" not in sale.raw_payload
    assert sale.raw_payload["score_status"] == "withheld_unqualified_risks"
    assert "restent à qualifier" in sale.investment_summary

    _score_sale(sale, [{"risk_label": "travaux", "severity": 3}])
    assert sale.investment_score is not None
    assert "score_status" not in sale.raw_payload


@pytest.mark.parametrize("text, expected", [
    ("État relatif à la présence de termites dans le bâtiment.", False),
    ("Conclusion : absence d'indices d'infestation de termites.", False),
    ("État relatif à la présence de termites. Absence d’indices d’infestation de termites.", False),
    ("Aucun indice de termites dans les pièces visitées.", False),
    ("Dans le cas de la présence de termites, il est rappelé l’obligation de déclaration en mairie de l’infestation.", False),
    ("En cas de présence de termites, une déclaration est obligatoire.", False),
    ("Si des termites sont présents, le propriétaire doit effectuer une déclaration.", False),
    ("La présence de termites ne peut être exclue dans les zones inaccessibles.", False),
    ("Présence de termites : non.", False),
    ("Présence de termites : non. Des termites ont été détectés dans le garage.", True),
    ("En cas de présence de termites, une déclaration est obligatoire. Des termites ont été détectés dans le garage.", True),
    ("Présence de termites dans la charpente.", True),
    ("Des termites ont été détectés dans le garage.", True),
    ("Absence de termites dans le logement. Présence de termites dans le garage.", True),
    ("Absence de termites dans le logement mais présence de termites dans le garage.", True),
])
def test_termite_report_distinguishes_title_negative_and_local_positive(text: str, expected: bool) -> None:
    rows = extract_risk_occurrences_from_text(
        text, "https://example.test/termite-report",
        source_kind="pdf", document_type="diagnostics_techniques",
    )
    assert any(row["risk_label"] == "termites" for row in rows) is expected


@pytest.mark.parametrize("carrez", ["97.16", None])
def test_detailed_apartment_title_prevents_valuing_the_cadastral_parcel_as_a_dwelling(carrez: str | None) -> None:
    sale = normalize_sale({
        "source_name": "avoventes",
        "source_url": "https://example.test/appartement-t5",
        "property_type": "land",
        "title": "Terrain 4 434 m²",
        "app_surface_m2": "4434",
        "app_surface_kind": "land",
        "surface_scope": "land",
        "land_surface_m2": "4434",
        "carrez_surface_m2": carrez,
        "source_blocks": {
            "type_bien": "Terrain",
            "titre_detail": "Appartement T5 avec terrasse, garage en sous-sol et emplacement de stationnement",
            "date_vente": "jeudi 10 septembre 2026 à 14h00",
        },
    })
    assert sale.property_type == "apartment"
    assert sale.title.startswith("Appartement T5")
    assert sale.app_surface_m2 == (Decimal(carrez) if carrez else None)
    assert sale.app_surface_kind == ("carrez" if carrez else None)
    assert sale.surface_scope == ("total" if carrez else None)
    assert sale.land_surface_m2 == Decimal("4434")


def test_land_is_not_reclassified_from_an_incidental_dwelling_reference() -> None:
    sale = normalize_sale({
        "source_name": "avoventes",
        "source_url": "https://example.test/terrain",
        "property_type": "land",
        "source_blocks": {"titre_detail": "Terrain situé près d’une maison"},
    })
    assert sale.property_type == "land"
