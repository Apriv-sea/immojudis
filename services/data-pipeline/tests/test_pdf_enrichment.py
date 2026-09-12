import socket
import unicodedata
import zipfile
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from urllib.parse import unquote, urlparse

import pytest

from src.asset_normalization import normalize_asset_features
from src.normalize import normalize_sale
from src.pdf_enrichment import (
    DOCUMENT_FACTS_VERSION,
    PdfEnrichmentStats,
    PublicDocumentTarget,
    _adaptive_docling_timeout,
    _bounded_document_content,
    _download_document_response,
    _PinnedNetworkBackend,
    _read_document_text_cache,
    _resolve_public_document_target,
    _select_documents_for_extraction,
    _store_document_analysis_status,
    _write_document_text_cache,
    classify_document_type,
    download_documents,
    enrich_sale_from_pdf_text,
    extract_attached_document,
    extract_pdf_document,
)


def test_bounded_document_content_rejects_declared_and_actual_oversize_payloads() -> None:
    declared = SimpleNamespace(headers={"content-length": "11"}, content=b"%PDF")
    actual = SimpleNamespace(headers={}, content=b"x" * 11)

    try:
        _bounded_document_content(declared, max_bytes=10)
        raise AssertionError("declared oversize payload should be rejected")
    except ValueError as exc:
        assert "download limit" in str(exc)

    try:
        _bounded_document_content(actual, max_bytes=10)
        raise AssertionError("actual oversize payload should be rejected")
    except ValueError as exc:
        assert "download limit" in str(exc)


def test_resolve_public_document_target_rejects_any_non_public_answer() -> None:
    def resolver_for(*addresses: str):
        def resolve(host: str, port: int, *, type: int):
            assert host == "documents.example"
            assert port == 443
            assert type == socket.SOCK_STREAM
            return [
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, port))
                for address in addresses
            ]

        return resolve

    target = _resolve_public_document_target(
        "https://documents.example/pv.pdf",
        resolver=resolver_for("93.184.216.34"),
    )
    assert target.addresses == ("93.184.216.34",)

    with pytest.raises(ValueError, match="outside the public network"):
        _resolve_public_document_target(
            "https://documents.example/pv.pdf",
            resolver=resolver_for("93.184.216.34", "127.0.0.1"),
        )
    with pytest.raises(ValueError, match="outside the public network"):
        _resolve_public_document_target(
            "https://documents.example/pv.pdf",
            resolver=resolver_for("10.0.0.5"),
        )


def test_pinned_document_backend_dials_only_an_approved_address() -> None:
    calls: list[tuple[str, int]] = []
    expected_stream = object()

    class RecordingBackend:
        def connect_tcp(self, host: str, port: int, **kwargs):
            calls.append((host, port))
            return expected_stream

        def sleep(self, seconds: float) -> None:
            return None

    target = PublicDocumentTarget(
        url="https://documents.example/pv.pdf",
        hostname="documents.example",
        port=443,
        addresses=("93.184.216.34",),
    )
    backend = _PinnedNetworkBackend(target, backend=RecordingBackend())

    assert backend.connect_tcp("documents.example", 443) is expected_stream
    assert calls == [("93.184.216.34", 443)]
    with pytest.raises(ValueError, match="unexpected destination"):
        backend.connect_tcp("other.example", 443)


def test_document_redirect_reenters_the_public_destination_boundary(monkeypatch) -> None:
    calls: list[str] = []

    class RedirectResponse:
        status_code = 302
        headers = {"location": "http://127.0.0.1/private.pdf"}

    def send(url: str, **kwargs):
        calls.append(url)
        if url.startswith("http://127.0.0.1"):
            raise ValueError("blocked redirect destination")
        return RedirectResponse()

    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", send)

    with pytest.raises(ValueError, match="blocked redirect destination"):
        _download_document_response(
            "https://documents.example/pv.pdf",
            headers={},
            timeout_seconds=5,
        )
    assert calls == [
        "https://documents.example/pv.pdf",
        "http://127.0.0.1/private.pdf",
    ]


def test_classify_document_type_prioritizes_known_pdf_labels() -> None:
    assert classify_document_type("PV descriptif anonyme.pdf") == "pv_huissier"
    assert classify_document_type("Cahier des conditions de vente.pdf") == "cahier_conditions_vente"
    assert classify_document_type("Cahier des charges.pdf") == "cahier_conditions_vente"
    assert classify_document_type("CAHIER LIQUIDATION 20260415.pdf") == "cahier_conditions_vente"
    assert classify_document_type("Dossier de consultation") == "cahier_conditions_vente"
    assert classify_document_type("Dossier de présentation") == "cahier_conditions_vente"
    assert classify_document_type("Diagnostics techniques DPE.pdf") == "diagnostics_techniques"
    assert classify_document_type("Dossier diag (1).pdf") == "diagnostics_techniques"
    assert classify_document_type("Avis simplifié.pdf") == "annonce_vente"
    assert classify_document_type("PLACARD PUBLICITE .pdf") == "annonce_vente"
    assert classify_document_type("PV de notaire.pdf") == "pv_notaire"


def test_classify_document_type_normalizes_common_non_pdf_french_labels() -> None:
    assert classify_document_type("Procès verbal", "https://example.test/download?id=1") == "proces_verbal"
    assert classify_document_type("Proces verbal de description", "https://example.test/download?id=2") == "pv_huissier"
    assert (
        classify_document_type("Procès verbal descriptif", "https://example.test/telechargement?id=3") == "pv_huissier"
    )


def test_enrich_sale_from_pdf_text_extracts_fields() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf",
            "property_type": "other",
        }
    )
    text = """
    Désignation : Une maison comprenant séjour et chambres.
    Surface habitable : 87,5 m².
    Nombre de pièces principales : 4.
    Le bien comprend 3 chambres.
    Le bien est occupé par un locataire selon bail.
    Diagnostic de performance énergétique, amiante, plomb et servitude.
    """

    enrich_sale_from_pdf_text(sale, [text])

    assert sale.surface_m2 == Decimal("87.5")
    assert sale.habitable_surface_m2 == Decimal("87.5")
    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 3
    assert sale.occupancy_status == "rented"
    assert sale.property_type == "house"
    assert "amiante" in (sale.risk_notes or "")
    assert "PDF TEXT ENRICHMENT" in (sale.raw_text or "")


def test_enrich_sale_from_ccv_replaces_implausible_source_starting_price() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-6008.html",
            "property_type": "Maison",
            "starting_price_eur": "11 €",
        }
    )
    pdf_text = {
        "label": "Cahier des conditions de la vente",
        "url": "https://www.info-encheres.com/upload/cahier-6008.pdf",
        "document_type": "cahier_conditions_vente",
        "text": (
            "Avant de porter les enchères, l'avocat reçoit un chèque représentant 10% du montant "
            "de la mise à prix, avec un minimum de 3.000 euros. "
            "Mise à prix adjudication. L'adjudication aura lieu en un seul lot sur la mise à prix "
            "ci-après indiquée : 10.500 € (dix mille cinq cents euros)."
        ),
        "pages": [
            {
                "page": 4,
                "text": ("Le chèque représente 10% du montant de la mise à prix, avec un minimum de 3.000 euros."),
                "confidence": 0.99,
                "method": "pymupdf",
            },
            {
                "page": 17,
                "text": (
                    "Mise à prix adjudication. L'adjudication aura lieu en un seul lot sur la mise à prix "
                    "ci-après indiquée : 10.500 € (dix mille cinq cents euros)."
                ),
                "confidence": 0.98,
                "method": "pymupdf",
            },
        ],
    }

    enrich_sale_from_pdf_text(sale, [pdf_text])

    assert sale.starting_price_eur == Decimal("10500")
    assert "starting_price_conflict_resolved" in sale.quality_flags
    assert sale.raw_payload["document_facts_version"] == DOCUMENT_FACTS_VERSION
    assert sale.raw_payload["starting_price_extraction"] == {
        "version": DOCUMENT_FACTS_VERSION,
        "source": "pdf",
        "status": "resolved",
        "value_eur": 10500.0,
        "rejected_source_price_eur": 11.0,
        "selected_value_eur": 10500.0,
        "document_label": "Cahier des conditions de la vente",
        "document_url": "https://www.info-encheres.com/upload/cahier-6008.pdf",
        "document_type": "cahier_conditions_vente",
        "page_number": 17,
        "page_confidence": 0.98,
        "extraction_method": "pymupdf",
        "evidence": (
            "Mise à prix adjudication. L'adjudication aura lieu en un seul lot sur la mise à prix "
            "ci-après indiquée : 10.500 € (dix mille cinq cents euros)."
        ),
    }


def test_enrich_sale_from_ccv_ignores_bid_guarantee_minimum() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-guarantee.html",
            "property_type": "Maison",
            "starting_price_eur": "11 €",
        }
    )
    pdf_text = {
        "label": "Cahier des conditions de la vente",
        "document_type": "cahier_conditions_vente",
        "text": (
            "Avant de porter les enchères, l'avocat reçoit un chèque représentant 10% du montant "
            "de la mise à prix, avec un minimum de 3.000 euros."
        ),
    }

    enrich_sale_from_pdf_text(sale, [pdf_text])

    assert sale.starting_price_eur == Decimal("11")
    assert "starting_price_extraction" not in sale.raw_payload
    assert sale.raw_payload["document_facts_version"] == DOCUMENT_FACTS_VERSION


def test_enrich_sale_from_ccv_keeps_plausible_current_price_on_conflict() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-current-price.html",
            "property_type": "Maison",
            "starting_price_eur": "100 000 €",
        }
    )
    pdf_text = {
        "label": "Cahier des conditions de la vente",
        "document_type": "cahier_conditions_vente",
        "text": "Mise à prix : 10.500 €.",
    }

    enrich_sale_from_pdf_text(sale, [pdf_text])

    assert sale.starting_price_eur == Decimal("100000")
    assert "starting_price_conflict" in sale.quality_flags
    assert sale.raw_payload["starting_price_extraction"]["status"] == "conflict_unresolved"
    assert sale.raw_payload["starting_price_extraction"]["selected_value_eur"] == 100000.0


def test_enrich_sale_from_pdf_text_does_not_treat_no_lease_as_rented() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-no-lease",
            "property_type": "Maison",
        }
    )

    enrich_sale_from_pdf_text(sale, ["Procès-verbal descriptif : maison occupée sans bail écrit."])

    assert sale.occupancy_status == "occupied"


def test_enrich_sale_from_pdf_text_detects_occupation_without_right_or_title() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/pdf-occupation-sans-droit.html",
            "property_type": "Appartement",
        }
    )

    enrich_sale_from_pdf_text(sale, ["Procès-verbal descriptif : le bien est occupé sans droit ni titre."])

    assert sale.occupancy_status == "squatted"


def test_enrich_sale_from_pdf_text_detects_squatted_occupation() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/pdf-logement-squatte.html",
            "property_type": "Maison",
        }
    )

    enrich_sale_from_pdf_text(sale, ["Constat d'huissier : logement squatté depuis plusieurs mois."])

    assert sale.occupancy_status == "squatted"


def test_enrich_sale_from_pdf_text_extracts_energy_diagnostics_with_provenance() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/pdf-diagnostics/109999.html",
            "property_type": "Appartement",
            "documents": [{"label": "Diagnostics techniques", "url": "https://example.test/diagnostics"}],
        }
    )
    pdf_texts = [
        {
            "label": "Diagnostics techniques",
            "url": "https://example.test/diagnostics",
            "document_type": "diagnostics_techniques",
            "text": (
                "Diagnostic de performance énergétique. "
                "Classe énergie : F. GES : C. "
                "Consommation énergétique : 394 kWhEP/m²/an. "
                "Émissions de gaz à effet de serre : 12 kg CO2/m²/an."
            ),
            "pages": [
                {"page": 1, "text": "Sommaire des diagnostics.", "confidence": 0.88, "method": "pymupdf_text"},
                {
                    "page": 2,
                    "text": (
                        "Diagnostic de performance énergétique. Classe énergie : F. GES : C. "
                        "Consommation énergétique : 394 kWhEP/m²/an. "
                        "Émissions de gaz à effet de serre : 12 kg CO2/m²/an."
                    ),
                    "confidence": 0.94,
                    "method": "pymupdf_text",
                },
            ],
            "extraction_method": "pymupdf_pages",
        }
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    diagnostics = sale.raw_payload["pdf_energy_diagnostics"]
    assert diagnostics["dpe_class"] == "F"
    assert diagnostics["ges_class"] == "C"
    assert diagnostics["energy_consumption_kwh_m2_year"] == 394
    assert diagnostics["emissions_kg_co2_m2_year"] == 12
    assert diagnostics["document_label"] == "Diagnostics techniques"
    assert diagnostics["document_url"] == "https://example.test/diagnostics"
    assert diagnostics["document_type"] == "diagnostics_techniques"
    assert diagnostics["page_number"] == 2
    assert "DPE F" in (sale.risk_notes or "")


def test_enrich_sale_from_pdf_text_extracts_compact_energy_diagnostics() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-dpe-compact",
            "property_type": "Maison",
        }
    )

    enrich_sale_from_pdf_text(sale, ["DPE G - Gaz à effet de serre classe D - 520 kWh/m2/an - 32 kg CO2/m2/an."])

    diagnostics = sale.raw_payload["pdf_energy_diagnostics"]
    assert diagnostics["dpe_class"] == "G"
    assert diagnostics["ges_class"] == "D"
    assert diagnostics["energy_consumption_kwh_m2_year"] == 520
    assert diagnostics["emissions_kg_co2_m2_year"] == 32
    assert "DPE G" in (sale.risk_notes or "")


def test_enrich_sale_from_pdf_text_extracts_visit_dates_with_provenance() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/pdf-visite/109998.html",
            "property_type": "Maison",
            "documents": [{"label": "Procès-verbal descriptif", "url": "https://example.test/pv"}],
        }
    )
    pdf_texts = [
        {
            "label": "Procès-verbal descriptif",
            "url": "https://example.test/pv",
            "document_type": "pv_huissier",
            "text": (
                "Conditions de visite. Aucune visite virtuelle disponible. "
                "Visite sur place le mardi 26 mai 2026 de 10h à 12h."
            ),
            "pages": [
                {
                    "page": 1,
                    "text": "Sommaire. Aucune visite virtuelle disponible.",
                    "confidence": 0.88,
                    "method": "pymupdf_text",
                },
                {
                    "page": 2,
                    "text": "Conditions de visite. Visite sur place le mardi 26 mai 2026 de 10h à 12h.",
                    "confidence": 0.93,
                    "method": "pymupdf_text",
                },
            ],
            "extraction_method": "pymupdf_pages",
        }
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.visit_dates == ["Visite sur place le mardi 26 mai 2026 de 10h à 12h"]
    extraction = sale.raw_payload["pdf_visit_dates_extraction"]
    assert extraction["document_label"] == "Procès-verbal descriptif"
    assert extraction["document_url"] == "https://example.test/pv"
    assert extraction["document_type"] == "pv_huissier"
    assert extraction["page_number"] == 2
    assert "visite virtuelle" not in " ".join(extraction["visit_dates"]).lower()


def test_enrich_sale_from_pdf_text_extracts_sale_date_with_provenance() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/pdf-audience-document.html",
            "property_type": "Appartement",
            "documents": [{"label": "Cahier des conditions de vente", "url": "https://example.test/ccv"}],
        }
    )
    pdf_texts = [
        {
            "label": "Cahier des conditions de vente",
            "url": "https://example.test/ccv",
            "document_type": "cahier_conditions_vente",
            "text": (
                "Sommaire du cahier. "
                "Audience d'adjudication le jeudi 15 octobre 2026 à 15h00 au tribunal judiciaire de Bordeaux."
            ),
            "pages": [
                {
                    "page": 1,
                    "text": "Sommaire du cahier sans calendrier.",
                    "confidence": 0.87,
                    "method": "pymupdf_text",
                },
                {
                    "page": 2,
                    "text": (
                        "Audience d'adjudication le jeudi 15 octobre 2026 à 15h00 au tribunal judiciaire de Bordeaux."
                    ),
                    "confidence": 0.94,
                    "method": "pymupdf_text",
                },
            ],
            "extraction_method": "pymupdf_pages",
        }
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.sale_date == datetime(2026, 10, 15, 13, 0, tzinfo=UTC)
    extraction = sale.raw_payload["pdf_sale_date_extraction"]
    assert extraction["sale_date"] == "2026-10-15T13:00:00+00:00"
    assert extraction["document_label"] == "Cahier des conditions de vente"
    assert extraction["document_url"] == "https://example.test/ccv"
    assert extraction["document_type"] == "cahier_conditions_vente"
    assert extraction["page_number"] == 2
    assert "Audience d'adjudication" in extraction["evidence"]


def test_enrich_sale_from_pdf_text_extracts_rooms_and_carrez_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-rooms",
            "property_type": "Appartement",
        }
    )
    text = """
    Le diagnostic affiche 210 kWhEP/m2/an.
    La superficie Carrez du lot est de 39,82m2.
    Appartement de 3 pièces 2 chambres.
    """

    enrich_sale_from_pdf_text(sale, [text])

    assert sale.surface_m2 == Decimal("39.82")
    assert sale.rooms_count == 3
    assert sale.bedrooms_count == 2


def test_enrich_sale_from_pdf_text_extracts_mesurage_loi_carrez_with_provenance() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/pdf-mesurage-carrez.html",
            "property_type": "Appartement",
            "documents": [{"label": "Procès verbal de description", "url": "https://example.test/download?id=pv"}],
        }
    )
    pdf_texts = [
        {
            "label": "Procès verbal de description",
            "url": "https://example.test/download?id=pv",
            "document_type": "pv_huissier",
            "text": "Constat. Mesurage loi Carrez : 39,82 m². Appartement de 2 pièces.",
            "pages": [
                {"page": 1, "text": "Constat sans métrage exploitable.", "confidence": 0.88, "method": "pymupdf_text"},
                {
                    "page": 2,
                    "text": "Mesurage loi Carrez : 39,82 m². Appartement de 2 pièces.",
                    "confidence": 0.93,
                    "method": "pymupdf_text",
                },
            ],
            "extraction_method": "pymupdf_pages",
        }
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.surface_m2 == Decimal("39.82")
    assert sale.carrez_surface_m2 == Decimal("39.82")
    surface_extraction = sale.raw_payload["surface_extraction"]
    assert surface_extraction["document_label"] == "Procès verbal de description"
    assert surface_extraction["document_url"] == "https://example.test/download?id=pv"
    assert surface_extraction["document_type"] == "pv_huissier"
    assert surface_extraction["page_number"] == 2
    assert "Mesurage loi Carrez" in surface_extraction["evidence"]


def test_info_encheres_diagnostics_prefers_reference_surface_over_technical_components() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/maison-surface-reference.html",
            "property_type": "Maison",
        }
    )
    document_text = """
    Type de bien : Maison individuelle. Surface de référence : 116,72 m².
    N° cadastre : ZI 40, ZI 43.
    Détail des travaux : mur est, surface : 77 m². Plafond, surface : 60 m².
    """
    pdf_texts = [
        {
            "label": "Diagnostics techniques",
            "url": "https://example.test/diagnostics.pdf",
            "document_type": "diagnostics_techniques",
            "text": document_text,
            "pages": [
                {
                    "page": 114,
                    "text": "Maison individuelle. Surface de référence : 116,72 m². N° cadastre : ZI 40, ZI 43.",
                    "confidence": 0.92,
                    "method": "pymupdf_text",
                },
                {
                    "page": 130,
                    "text": "Isolation du mur est, surface : 77 m². Plafond, surface : 60 m².",
                    "confidence": 0.92,
                    "method": "pymupdf_text",
                },
            ],
        }
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("116.72")
    assert sale.habitable_surface_m2 is None
    assert sale.land_surface_m2 is None
    assert sale.app_surface_m2 == Decimal("116.72")
    assert sale.raw_payload["surface_extraction"]["page_number"] == 114


def test_info_encheres_keeps_incomplete_carrez_measurement_as_partial_evidence() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/appartement-mesurage-partiel.html",
            "property_type": "Appartement",
        }
    )
    document_text = """
    Le calcul de superficie n'a pas pu être réalisé dans son intégralité.
    Cuisine, séjour et chambres : encombrement trop important.
    Surface loi Carrez totale : 3,78 m².
    """
    pdf_texts = [
        {
            "label": "Diagnostics techniques",
            "url": "https://example.test/diagnostics-partiels.pdf",
            "document_type": "diagnostics_techniques",
            "text": document_text,
            "pages": [
                {
                    "page": 3,
                    "text": "Superficie privative. Surface loi Carrez totale : 3,78 m².",
                    "confidence": 0.92,
                    "method": "pymupdf_text",
                }
            ],
        }
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("3.78")
    assert sale.carrez_surface_m2 == Decimal("3.78")
    assert sale.surface_scope == "partial"
    assert sale.surface_confidence == Decimal("0.45")
    assert sale.app_surface_m2 is None
    assert "partial_surface_measurement" in sale.quality_flags
    assert sale.raw_payload["surface_extraction"]["surface_scope"] == "partial"
    assert sale.title == "Appartement"


def test_enrich_sale_from_pdf_text_extracts_cadastral_land_surface_with_provenance() -> None:
    sale = normalize_sale(
        {
            "source_name": "cessions_etat",
            "source_url": "https://cessions.immobilier-etat.gouv.fr/biens/terrain-cadastre",
            "property_type": "Terrain",
            "documents": [{"label": "Dossier de consultation", "url": "https://example.test/dossier"}],
        }
    )
    pdf_texts = [
        {
            "label": "Dossier de consultation",
            "url": "https://example.test/dossier",
            "document_type": "cahier_conditions_vente",
            "text": "Désignation. Parcelle cadastrée section AB n°12 pour une contenance de 12 a 34 ca.",
            "pages": [
                {"page": 1, "text": "Désignation générale sans surface.", "confidence": 0.86, "method": "pymupdf_text"},
                {
                    "page": 2,
                    "text": "Parcelle cadastrée section AB n°12 pour une contenance de 12 a 34 ca.",
                    "confidence": 0.91,
                    "method": "pymupdf_text",
                },
            ],
            "extraction_method": "pymupdf_pages",
        }
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.land_surface_m2 == Decimal("1234")
    assert sale.surface_m2 == Decimal("1234")
    extraction = sale.raw_payload["land_surface_extraction"]
    assert extraction["document_label"] == "Dossier de consultation"
    assert extraction["document_url"] == "https://example.test/dossier"
    assert extraction["document_type"] == "cahier_conditions_vente"
    assert extraction["page_number"] == 2
    assert extraction["kind"] == "land_surface_m2"


def test_enrich_sale_from_pdf_text_adds_land_surface_without_overwriting_built_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/maison-terrain-pdf.html",
            "property_type": "Maison",
            "surface_m2": "80 m2",
            "documents": [{"label": "Procès verbal descriptif", "url": "https://example.test/pv"}],
        }
    )
    pdf_texts = [
        {
            "label": "Procès verbal descriptif",
            "url": "https://example.test/pv",
            "document_type": "pv_huissier",
            "text": "Maison avec parcelle cadastrée section AC pour une contenance totale de 4 a 20 ca.",
            "pages": [
                {
                    "page": 3,
                    "text": "Maison avec parcelle cadastrée section AC pour une contenance totale de 4 a 20 ca.",
                    "confidence": 0.9,
                    "method": "pymupdf_text",
                },
            ],
            "extraction_method": "pymupdf_pages",
        }
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.surface_m2 == Decimal("80")
    assert sale.land_surface_m2 == Decimal("420")
    assert sale.raw_payload["land_surface_extraction"]["page_number"] == 3


def test_enrich_sale_from_pdf_text_maps_studio_to_one_room() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-studio",
        }
    )

    enrich_sale_from_pdf_text(sale, ["Désignation : studio libre d'occupation."])

    assert sale.rooms_count == 1


def test_enrich_sale_from_pdf_text_replaces_stale_pdf_context() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-stale-context",
            "raw_text": "Annonce initiale --- PDF TEXT ENRICHMENT --- ancien OCR",
        }
    )

    enrich_sale_from_pdf_text(sale, ["Surface habitable : 31 m²."])

    assert "ancien OCR" not in (sale.raw_text or "")
    assert "Surface habitable" in (sale.raw_text or "")


def test_select_documents_for_extraction_prioritizes_useful_documents(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    documents = [
        {"label": "Autre.pdf", "document_type": "pdf"},
        {"label": "Diagnostics.pdf", "document_type": "diagnostics_techniques"},
        {"label": "PV descriptif.pdf", "document_type": "pv_huissier"},
        {"label": "Cahier.pdf", "document_type": "cahier_conditions_vente"},
    ]

    selected = _select_documents_for_extraction(documents)

    assert [item["document_type"] for item in selected] == ["pv_huissier", "diagnostics_techniques"]


def test_select_documents_for_extraction_accepts_legacy_document_type_aliases(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/legacy-doc-types.html",
            "property_type": "Appartement",
        }
    )
    documents = [
        {"label": "Diagnostics.pdf", "document_type": "diagnostics"},
        {"label": "PV descriptif.pdf", "document_type": "pv_descriptif"},
        {"label": "Cahier.pdf", "document_type": "cahier_conditions"},
    ]

    selected = _select_documents_for_extraction(documents, sale=sale)

    assert [item["label"] for item in selected] == [
        "PV descriptif.pdf",
        "Diagnostics.pdf",
        "Cahier.pdf",
    ]


def test_select_documents_for_extraction_uses_legacy_type_when_label_is_vague(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-legacy-type.html",
            "property_type": "Appartement",
        }
    )
    documents = [
        {"label": "Document 1.pdf", "url": "https://example.test/doc1.pdf", "type": "pv_descriptif"},
        {"label": "Document 2.pdf", "url": "https://example.test/doc2.pdf", "type": "diagnostics"},
        {"label": "Document 3.pdf", "url": "https://example.test/doc3.pdf", "type": "cahier_conditions"},
    ]

    selected = _select_documents_for_extraction(documents, sale=sale)

    assert [item["url"] for item in selected] == [
        "https://example.test/doc1.pdf",
        "https://example.test/doc2.pdf",
        "https://example.test/doc3.pdf",
    ]


def test_select_documents_for_extraction_uses_label_when_type_is_generic(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/generic-pdf-type.html",
            "property_type": "Maison",
        }
    )
    documents = [
        {"label": "Autre document.pdf", "url": "https://example.test/other.pdf", "type": "pdf"},
        {"label": "Diagnostics techniques.pdf", "url": "https://example.test/diag.pdf", "type": "pdf"},
        {"label": "PV descriptif.pdf", "url": "https://example.test/pv.pdf", "type": "pdf"},
        {"label": "Cahier des charges.pdf", "url": "https://example.test/ccv.pdf", "type": "document"},
    ]

    selected = _select_documents_for_extraction(documents, sale=sale)

    assert [item["url"] for item in selected] == [
        "https://example.test/pv.pdf",
        "https://example.test/diag.pdf",
        "https://example.test/ccv.pdf",
    ]


def test_select_documents_for_extraction_prioritizes_non_pdf_download_labels(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/non-pdf-download-labels.html",
            "property_type": "Appartement",
        }
    )
    documents = [
        {"label": "Autre document", "url": "https://example.test/download?id=other", "type": "pdf"},
        {"label": "Procès verbal de description", "url": "https://example.test/download?id=pv", "type": "pdf"},
        {"label": "Règlement de consultation", "url": "https://example.test/telechargement?id=ccv", "type": "document"},
    ]

    selected = _select_documents_for_extraction(documents, sale=sale)

    assert [item["url"] for item in selected] == [
        "https://example.test/download?id=pv",
        "https://example.test/telechargement?id=ccv",
    ]


def test_select_documents_for_extraction_classifies_avoventes_generic_pdf_labels(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/agricultural-document-labels",
            "property_type": "Autres",
        }
    )
    documents = [
        {"label": "PLACARD PUBLICITE .pdf", "url": "https://example.test/placard.pdf", "type": "pdf"},
        {"label": "CAHIER LIQUIDATION 20260415.pdf", "url": "https://example.test/cahier.pdf", "type": "pdf"},
        {"label": "PV Description (5).pdf", "url": "https://example.test/pv.pdf", "type": "pdf"},
        {"label": "Dossier diag (1).pdf", "url": "https://example.test/diag.pdf", "type": "pdf"},
    ]

    selected = _select_documents_for_extraction(documents, sale=sale)

    assert [item["url"] for item in selected] == [
        "https://example.test/pv.pdf",
        "https://example.test/diag.pdf",
        "https://example.test/cahier.pdf",
    ]


def test_select_documents_for_extraction_expands_when_surface_is_missing(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/missing-source-surface",
            "property_type": "Maison",
        }
    )
    documents = [
        {"label": "Autre.pdf", "document_type": "pdf"},
        {"label": "Diagnostics.pdf", "document_type": "diagnostics_techniques"},
        {"label": "PV descriptif.pdf", "document_type": "pv_huissier"},
        {"label": "Cahier des conditions.pdf", "document_type": "cahier_conditions_vente"},
    ]

    selected = _select_documents_for_extraction(documents, sale=sale)

    assert [item["document_type"] for item in selected] == [
        "pv_huissier",
        "diagnostics_techniques",
        "cahier_conditions_vente",
    ]


def test_select_documents_for_extraction_includes_bail_when_occupancy_is_missing(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/missing-occupancy",
            "property_type": "Appartement",
            "surface_m2": "45 m2",
            "rooms_count": 2,
        }
    )
    documents = [
        {"label": "Diagnostics.pdf", "document_type": "diagnostics_techniques"},
        {"label": "Bail.pdf", "document_type": "bail"},
        {"label": "PV descriptif.pdf", "document_type": "pv_huissier"},
        {"label": "Cahier des conditions.pdf", "document_type": "cahier_conditions_vente"},
    ]

    selected = _select_documents_for_extraction(documents, sale=sale)

    assert [item["document_type"] for item in selected] == [
        "pv_huissier",
        "cahier_conditions_vente",
        "bail",
        "diagnostics_techniques",
    ]


def test_select_documents_for_extraction_includes_diagnostics_when_energy_missing(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "1")
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/missing-energy-diagnostics.html",
            "property_type": "Appartement",
            "surface_m2": "45 m2",
            "rooms_count": 2,
            "occupancy_status": "Libre de toute occupation",
        }
    )
    documents = [
        {"label": "PV descriptif.pdf", "document_type": "pv_huissier"},
        {"label": "Diagnostics techniques.pdf", "document_type": "diagnostics_techniques"},
        {"label": "Cahier des conditions.pdf", "document_type": "cahier_conditions_vente"},
    ]

    selected = _select_documents_for_extraction(documents, sale=sale)

    assert [item["document_type"] for item in selected] == [
        "diagnostics_techniques",
        "cahier_conditions_vente",
    ]


def test_select_documents_for_extraction_does_not_force_diagnostics_when_dpe_exempt(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "1")
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://www.immobilier.notaires.fr/fr/annonce-immo/dpe-non-soumis",
            "property_type": "Terrain",
            "surface_m2": "500 m2",
            "risk_notes": "DPE non soumis",
        }
    )
    documents = [
        {"label": "PV descriptif.pdf", "document_type": "pv_huissier"},
        {"label": "Diagnostics techniques.pdf", "document_type": "diagnostics_techniques"},
    ]

    selected = _select_documents_for_extraction(documents, sale=sale)

    assert [item["document_type"] for item in selected] == ["pv_huissier"]


def test_expanded_document_selection_allows_ccv_only_surface_extraction(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/ccv-only-surface",
            "property_type": "Maison",
        }
    )
    documents = [
        {"label": "PV descriptif.pdf", "url": "https://example.test/pv.pdf", "document_type": "pv_huissier"},
        {
            "label": "Diagnostics.pdf",
            "url": "https://example.test/diag.pdf",
            "document_type": "diagnostics_techniques",
        },
        {
            "label": "Cahier des conditions.pdf",
            "url": "https://example.test/ccv.pdf",
            "document_type": "cahier_conditions_vente",
        },
    ]
    text_by_url = {
        "https://example.test/pv.pdf": "Proces-verbal descriptif sans surface exploitable.",
        "https://example.test/diag.pdf": "Diagnostic de performance energetique : 210 kWhEP/m2/an.",
        "https://example.test/ccv.pdf": "Designation. Surface habitable : 72,4 m2. Occupation a verifier.",
    }
    selected = _select_documents_for_extraction(documents, sale=sale)
    pdf_texts = [
        {
            **document,
            "text": text_by_url[document["url"]],
            "pages": [
                {
                    "page": 1,
                    "text": text_by_url[document["url"]],
                    "confidence": 0.9,
                    "method": "pymupdf_text",
                }
            ],
        }
        for document in selected
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)
    normalize_asset_features(sale)

    assert [item["document_type"] for item in selected] == [
        "pv_huissier",
        "diagnostics_techniques",
        "cahier_conditions_vente",
    ]
    assert sale.surface_m2 == Decimal("72.4")
    assert sale.habitable_surface_m2 == Decimal("72.4")
    surface_extraction = sale.raw_payload["surface_extraction"]
    assert surface_extraction["document_label"] == "Cahier des conditions.pdf"
    assert surface_extraction["document_url"] == "https://example.test/ccv.pdf"
    assert surface_extraction["document_type"] == "cahier_conditions_vente"
    assert surface_extraction["page_number"] == 1
    assert "Surface habitable" in surface_extraction["evidence"]


def test_document_analysis_status_normalizes_legacy_extracted_document_types() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/legacy-analysis.html",
        }
    )
    documents = [
        {"label": "PV descriptif", "url": "https://example.test/pv.pdf", "document_type": "pv_descriptif"},
        {"label": "Diagnostics", "url": "https://example.test/diag.pdf", "document_type": "diagnostics"},
        {"label": "Cahier", "url": "https://example.test/ccv.pdf", "document_type": "cahier_conditions"},
    ]
    pdf_texts = [
        {
            "label": "PV descriptif",
            "url": "https://example.test/pv.pdf",
            "document_type": "pv_descriptif",
            "text": "Surface habitable : 50 m2.",
        },
        {
            "label": "Diagnostics",
            "url": "https://example.test/diag.pdf",
            "document_type": "diagnostics",
            "text": "DPE classe D.",
        },
        {
            "label": "Cahier",
            "url": "https://example.test/ccv.pdf",
            "document_type": "cahier_conditions",
            "text": "Cahier des conditions de vente.",
        },
    ]

    _store_document_analysis_status(sale, documents, pdf_texts)

    analysis = sale.raw_payload["document_analysis"]
    assert analysis["coverage_status"] == "rich"
    assert analysis["missing_core_documents"] == []
    assert analysis["document_types"] == {
        "cahier_conditions_vente": 1,
        "diagnostics_techniques": 1,
        "pv_huissier": 1,
    }
    assert analysis["extracted_document_types"] == {
        "cahier_conditions_vente": 1,
        "diagnostics_techniques": 1,
        "pv_huissier": 1,
    }


def test_document_analysis_does_not_count_empty_pdf_payload_as_extracted() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/scanned-empty-pdf.html",
        }
    )
    documents = [{"label": "PV descriptif", "url": "https://example.test/pv.pdf", "document_type": "pv_huissier"}]
    pdf_texts = [
        {
            "label": "PV descriptif",
            "url": "https://example.test/pv.pdf",
            "document_type": "pv_huissier",
            "text": "",
            "pages": [{"page": 1, "text": "", "confidence": 0.0, "method": "fallback_text"}],
        }
    ]

    _store_document_analysis_status(sale, documents, pdf_texts)

    analysis = sale.raw_payload["document_analysis"]
    assert analysis["coverage_status"] == "documents_not_extracted"
    assert analysis["documents_extracted"] == 0
    assert analysis["extracted_document_types"] == {}
    assert analysis["profiles"][0]["extraction_status"] == "empty"


def test_enrich_sale_from_pdf_text_does_not_sum_repeated_document_surfaces() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-repeated-surface",
            "property_type": "Appartement",
        }
    )
    pdf_texts = [
        {
            "label": "PV descriptif",
            "document_type": "pv_huissier",
            "text": "Désignation : appartement. Surface habitable : 42 m².",
        },
        {
            "label": "Diagnostics",
            "document_type": "diagnostics_techniques",
            "text": "Rapport diagnostic. Surface habitable : 42 m².",
        },
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.surface_m2 == Decimal("42")
    assert sale.surface_m2 != Decimal("84")
    assert sale.surface_evidence and "Diagnostics" in sale.surface_evidence


def test_enrich_sale_from_pdf_text_extracts_document_only_surface_with_page_provenance() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/document-only-surface",
            "property_type": "Maison",
            "description": "Maison vendue aux enchères avec documents officiels joints.",
            "documents": [{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
        }
    )
    long_intro = "Constatations générales sans métrage exploitable. " * 40
    pdf_texts = [
        {
            "label": "PV descriptif",
            "url": "https://example.test/pv.pdf",
            "document_type": "pv_huissier",
            "text": long_intro + "Deuxième page. Surface habitable : 87,5 m². Le bien comprend un séjour.",
            "pages": [
                {"page": 1, "text": long_intro, "confidence": 0.92, "method": "pymupdf_text"},
                {
                    "page": 2,
                    "text": "Désignation du bien. Surface habitable : 87,5 m². Le bien comprend un séjour.",
                    "confidence": 0.94,
                    "method": "pymupdf_text",
                },
            ],
            "extraction_method": "pymupdf_pages",
        }
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("87.5")
    assert sale.habitable_surface_m2 == Decimal("87.5")
    assert sale.app_surface_m2 == Decimal("87.5")
    assert sale.surface_source == "pdf"
    surface_extraction = sale.raw_payload["surface_extraction"]
    assert surface_extraction["document_label"] == "PV descriptif"
    assert surface_extraction["document_url"] == "https://example.test/pv.pdf"
    assert surface_extraction["document_type"] == "pv_huissier"
    assert surface_extraction["page_number"] == 2
    assert "Surface habitable" in surface_extraction["evidence"]


def test_enrich_sale_from_pdf_text_keeps_thousands_surface_with_page_provenance() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/document-thousands-surface",
            "property_type": "Propriété",
            "documents": [{"label": "Cahier des conditions", "url": "https://example.test/ccv.pdf"}],
        }
    )
    pdf_texts = [
        {
            "label": "Cahier des conditions",
            "url": "https://example.test/ccv.pdf",
            "document_type": "cahier_conditions_vente",
            "text": "Désignation du bien. Surface totale : 2 464,70 m². Le bien est libre.",
            "pages": [
                {"page": 1, "text": "Désignation du bien sans métrage.", "confidence": 0.91, "method": "pymupdf_text"},
                {
                    "page": 2,
                    "text": "Surface totale : 2 464,70 m². Le bien est libre.",
                    "confidence": 0.93,
                    "method": "pymupdf_text",
                },
            ],
            "extraction_method": "pymupdf_pages",
        }
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.surface_m2 == Decimal("2464.70")
    surface_extraction = sale.raw_payload["surface_extraction"]
    assert surface_extraction["document_label"] == "Cahier des conditions"
    assert surface_extraction["document_url"] == "https://example.test/ccv.pdf"
    assert surface_extraction["document_type"] == "cahier_conditions_vente"
    assert surface_extraction["page_number"] == 2
    assert "2 464,70 m²" in surface_extraction["evidence"]


def test_extract_pdf_document_preserves_page_level_text(tmp_path, monkeypatch) -> None:
    import fitz

    monkeypatch.setenv("PDF_EXTRACTOR", "pymupdf")
    monkeypatch.setenv("PDF_OCR_ENABLED", "false")
    path = tmp_path / "two-pages.pdf"
    with fitz.open() as document:
        page_1 = document.new_page()
        page_1.insert_text((72, 72), "Surface habitable : 50 m2")
        page_2 = document.new_page()
        page_2.insert_text((72, 72), "Occupation : bail en cours")
        document.save(path)

    payload = extract_pdf_document(path, document={"label": "PV", "document_type": "pv_huissier"})

    assert payload["cache_version"] == "pdf_text_v3_surface_calibration"
    assert payload["page_count"] == 2
    assert [page["page"] for page in payload["pages"]] == [1, 2]
    assert "Surface habitable" in payload["text"]
    assert "bail en cours" in payload["text"]


def test_extract_pdf_document_then_enriches_document_only_surface(tmp_path, monkeypatch) -> None:
    import fitz

    monkeypatch.setenv("PDF_EXTRACTOR", "pymupdf")
    monkeypatch.setenv("PDF_OCR_ENABLED", "false")
    path = tmp_path / "pv-document-only-surface.pdf"
    with fitz.open() as document:
        page_1 = document.new_page()
        page_1.insert_text((72, 72), "Proces-verbal descriptif sans surface sur cette premiere page.")
        page_2 = document.new_page()
        page_2.insert_text((72, 72), "Designation du lot. Superficie Carrez : 39,82 m2.")
        document.save(path)

    payload = extract_pdf_document(
        path,
        document={"label": "PV descriptif", "url": "https://example.test/pv.pdf", "document_type": "pv_huissier"},
    )
    payload.update(
        {
            "label": "PV descriptif",
            "url": "https://example.test/pv.pdf",
            "type": "pdf",
            "document_type": "pv_huissier",
            "file_path": str(path),
        }
    )
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-real-document-only-surface",
            "property_type": "Appartement",
            "documents": [{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
        }
    )

    enrich_sale_from_pdf_text(sale, [payload])
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("39.82")
    assert sale.carrez_surface_m2 == Decimal("39.82")
    assert sale.app_surface_m2 == Decimal("39.82")
    assert sale.raw_payload["surface_extraction"]["page_number"] == 2
    assert sale.raw_payload["surface_extraction"]["document_label"] == "PV descriptif"


def test_download_documents_skips_robots_disallowed_licitor_documents(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/10/87/62/example/108762.html",
            "documents": [
                {
                    "label": "PV descriptif",
                    "url": "https://www.licitor.com/data/pub/media/annonce/10/87/62/108762.000.001.pdf",
                    "type": "pdf",
                }
            ],
        }
    )

    def fail_get(*args, **kwargs):
        raise AssertionError("robots-disallowed Licitor PDFs must not be downloaded")

    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", fail_get)

    assert download_documents(sale, output_root=tmp_path) == []


def test_download_documents_uses_legacy_type_when_label_and_url_are_vague(tmp_path, monkeypatch) -> None:
    class Response:
        content = b"%PDF-1.4\n%%EOF"

        def raise_for_status(self) -> None:
            return None

    calls = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return Response()

    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", fake_get)
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-legacy-type.html",
            "documents": [
                {
                    "label": "Document 1.pdf",
                    "url": "https://example.test/doc1.pdf",
                    "type": "pv_descriptif",
                }
            ],
        }
    )

    downloaded = download_documents(sale, output_root=tmp_path)

    assert calls
    assert downloaded[0]["document_type"] == "pv_huissier"
    assert downloaded[0]["type"] == "pdf"


def test_download_documents_classifies_generic_type_from_label(tmp_path, monkeypatch) -> None:
    class Response:
        content = b"%PDF-1.4\n%%EOF"

        def raise_for_status(self) -> None:
            return None

    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", lambda *args, **kwargs: Response())
    sale = normalize_sale(
        {
            "source_name": "cessions_etat",
            "source_url": "https://cessions.immobilier-etat.gouv.fr/biens/generic-doc-type",
            "documents": [
                {
                    "label": "Cahier des charges.pdf",
                    "url": "https://example.test/cahier.pdf",
                    "type": "document",
                }
            ],
        }
    )

    downloaded = download_documents(sale, output_root=tmp_path)

    assert downloaded[0]["document_type"] == "cahier_conditions_vente"
    assert downloaded[0]["type"] == "pdf"


def test_download_documents_saves_non_pdf_download_endpoint_with_pdf_suffix(tmp_path, monkeypatch) -> None:
    class Response:
        content = b"%PDF-1.4\n%%EOF"

        def raise_for_status(self) -> None:
            return None

    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", lambda *args, **kwargs: Response())
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/non-pdf-download-endpoint.html",
            "documents": [
                {
                    "label": "Procès verbal de description",
                    "url": "https://example.test/download.php?id=5980&type=pvd",
                    "type": "pdf",
                }
            ],
        }
    )

    downloaded = download_documents(sale, output_root=tmp_path)

    assert downloaded[0]["document_type"] == "pv_huissier"
    assert downloaded[0]["file_path"].endswith(".pdf")


def test_download_documents_rejects_html_response_and_uses_source_referer(tmp_path, monkeypatch) -> None:
    class Response:
        content = b"<html><body>Partner landing page</body></html>"
        headers = {"content-type": "text/html; charset=utf-8"}

        def raise_for_status(self) -> None:
            return None

    captured: dict[str, object] = {}

    def fake_get(url, **kwargs):
        captured.update(kwargs)
        return Response()

    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", fake_get)
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-avec-document.html",
            "documents": [
                {
                    "label": "Procès verbal descriptif",
                    "url": "https://example.test/download.php?id=5980&type=pvd",
                    "type": "pdf",
                }
            ],
        }
    )
    stats = PdfEnrichmentStats()

    assert download_documents(sale, output_root=tmp_path, stats=stats) == []
    assert stats.errors == 1
    assert captured["headers"]["Referer"] == sale.source_url
    assert captured["timeout_seconds"] > 0
    assert list(tmp_path.rglob("*.pdf")) == []


def test_download_documents_rejects_private_network_urls(tmp_path, monkeypatch) -> None:
    transport_targets: list[PublicDocumentTarget] = []

    def record_transport(target: PublicDocumentTarget):
        transport_targets.append(target)
        raise AssertionError("private URL reached the HTTP transport")

    monkeypatch.setattr(
        "src.pdf_enrichment._PinnedHTTPTransport",
        record_transport,
    )
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-privee.html",
            "documents": [
                {
                    "label": "Document interne",
                    "url": "http://127.0.0.1:54321/admin.pdf",
                    "type": "pdf",
                }
            ],
        }
    )
    stats = PdfEnrichmentStats()

    assert download_documents(sale, output_root=tmp_path, stats=stats) == []
    assert stats.errors == 1
    assert transport_targets == []


def test_download_documents_fetches_duplicate_url_only_once(tmp_path, monkeypatch) -> None:
    class Response:
        content = b"%PDF-1.4\n%%EOF"
        headers = {"content-type": "application/pdf"}

        def raise_for_status(self) -> None:
            return None

    calls: list[str] = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return Response()

    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", fake_get)
    document = {
        "label": "Diagnostics techniques",
        "url": "https://example.test/diagnostics.pdf",
        "type": "pdf",
    }
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-document-duplique.html",
            "documents": [document, document],
        }
    )

    downloaded = download_documents(sale, output_root=tmp_path)

    assert calls == ["https://example.test/diagnostics.pdf"]
    assert len(downloaded) == 1


def test_download_documents_applies_selection_budget_before_network_fanout(tmp_path, monkeypatch) -> None:
    class Response:
        content = b"%PDF-1.4\n%%EOF"
        headers = {"content-type": "application/pdf"}

        def raise_for_status(self) -> None:
            return None

    calls: list[str] = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return Response()

    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", fake_get)
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-budgetee.html",
            "property_type": "Terrain",
            "surface_m2": "500 m2",
            "occupancy_status": "Libre",
            "documents": [
                {
                    "label": f"Annexe {index:02d}.pdf",
                    "url": f"https://example.test/document-{index:02d}.pdf",
                    "type": "pdf",
                }
                for index in range(40)
            ],
        }
    )
    sale.raw_payload["document_facts_version"] = "document_facts_v1_starting_price"

    downloaded = download_documents(sale, output_root=tmp_path)

    assert len(calls) == 2
    assert len(downloaded) == 2


def test_download_documents_retries_nfc_unicode_url_variant(tmp_path, monkeypatch) -> None:
    class Response:
        content = b"%PDF-1.4\n%%EOF"
        headers = {"content-type": "application/pdf"}

        def raise_for_status(self) -> None:
            return None

    decomposed_url = "https://example.test/Droit_de_pre\u0301emption_-_internet.pdf"
    calls: list[str] = []

    def fake_get(url, **kwargs):
        calls.append(url)
        decoded_path = unquote(urlparse(url).path)
        if not unicodedata.is_normalized("NFC", decoded_path):
            raise RuntimeError("404 decomposed path")
        return Response()

    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", fake_get)
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-document-accentue.html",
            "documents": [{"label": "Droit de préemption", "url": decomposed_url, "type": "pdf"}],
        }
    )
    stats = PdfEnrichmentStats()

    downloaded = download_documents(sale, output_root=tmp_path, stats=stats)

    assert len(calls) == 2
    assert calls[0] == decomposed_url
    assert unicodedata.is_normalized("NFC", unquote(urlparse(calls[1]).path))
    assert downloaded[0]["url"] == decomposed_url
    assert stats.downloaded == 1
    assert stats.errors == 0


def test_download_documents_normalizes_percent_encoded_combining_accent(tmp_path, monkeypatch) -> None:
    class Response:
        content = b"%PDF-1.4\n%%EOF"
        headers = {"content-type": "application/pdf"}

        def raise_for_status(self) -> None:
            return None

    encoded_decomposed_url = "https://example.test/Droit_de_pre%CC%81emption.pdf"
    calls: list[str] = []

    def fake_get(url, **kwargs):
        calls.append(url)
        decoded_path = unquote(urlparse(url).path)
        if not unicodedata.is_normalized("NFC", decoded_path):
            raise RuntimeError("404 decomposed path")
        return Response()

    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", fake_get)
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-document-encode.html",
            "documents": [{"label": "Droit de préemption", "url": encoded_decomposed_url, "type": "pdf"}],
        }
    )

    downloaded = download_documents(sale, output_root=tmp_path)

    assert len(calls) == 2
    assert calls[0] == encoded_decomposed_url
    assert "%C3%A9" in calls[1]
    assert len(downloaded) == 1


def test_download_documents_accepts_legacy_word_attachment(tmp_path, monkeypatch) -> None:
    class Response:
        content = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64
        headers = {"content-type": "application/msword"}

        def raise_for_status(self) -> None:
            return None

    monkeypatch.setattr("src.pdf_enrichment._send_pinned_document_request", lambda *args, **kwargs: Response())
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-avec-ccv-word.html",
            "documents": [
                {
                    "label": "Cahier des conditions de vente",
                    "url": "https://www.info-encheres.com/upload/CCVok.doc",
                    "type": "cahier_conditions",
                }
            ],
        }
    )
    stats = PdfEnrichmentStats()

    downloaded = download_documents(sale, output_root=tmp_path, stats=stats)

    assert len(downloaded) == 1
    assert downloaded[0]["type"] == "doc"
    assert downloaded[0]["file_format"] == "doc"
    assert downloaded[0]["document_type"] == "cahier_conditions_vente"
    assert downloaded[0]["file_path"].endswith(".doc")
    assert stats.downloaded == 1
    assert stats.errors == 0


def test_extract_attached_legacy_word_document_feeds_surface_rules(tmp_path, monkeypatch) -> None:
    file_path = tmp_path / "CCVok.doc"
    file_path.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64)
    extracted_text = (
        "Une villa traditionnelle d'une superficie privative de 87.58 m² comprenant "
        "un séjour, une cuisine et trois chambres."
    )

    monkeypatch.setattr(
        "src.pdf_enrichment.shutil.which",
        lambda command: f"/usr/bin/{command}" if command == "antiword" else None,
    )
    monkeypatch.setattr(
        "src.pdf_enrichment.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=extracted_text, stderr=""),
    )

    payload = extract_attached_document(
        file_path,
        document={"file_format": "doc", "label": "CCV", "url": "https://example.test/CCVok.doc"},
    )
    payload.update(
        {
            "label": "Cahier des conditions de vente",
            "url": "https://example.test/CCVok.doc",
            "type": "doc",
            "document_type": "cahier_conditions_vente",
        }
    )
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://example.test/vente-word",
            "property_type": "Maison",
        }
    )

    enrich_sale_from_pdf_text(sale, [payload])

    assert payload["extraction_method"] == "antiword"
    assert payload["text"] == extracted_text
    assert sale.surface_m2 == Decimal("87.58")


def test_extract_attached_docx_document_uses_embedded_xml(tmp_path) -> None:
    file_path = tmp_path / "conditions.docx"
    with zipfile.ZipFile(file_path, "w") as archive:
        archive.writestr(
            "word/document.xml",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:body><w:p><w:r><w:t>Surface habitable : 92,40 m².</w:t></w:r></w:p></w:body>
            </w:document>""",
        )

    payload = extract_attached_document(file_path, document={"file_format": "docx"})

    assert payload["extraction_method"] == "docx_xml"
    assert payload["text"] == "Surface habitable : 92,40 m²."


def test_document_land_surface_prefers_explicit_private_parcel_over_cadastral_rows() -> None:
    text = (
        "Dans un lotissement cadastré : Section AM 55 Surface 00ha 05a 80ca ; "
        "Section AM 117 Surface 00ha 27a 13ca ; Section AM 119 Surface 00ha 06a 40ca ; "
        "Section AM 120 Surface 00ha 00a 74ca. Une villa d'une superficie privative "
        "de 87.58 m². Outre piscine, le droit à la jouissance exclusive et perpétuelle "
        "d'une parcelle de terrain de 3 ares environ."
    )
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://example.test/vente-word-cadastre",
            "property_type": "Maison",
        }
    )

    enrich_sale_from_pdf_text(
        sale,
        [
            {
                "text": text,
                "pages": [{"page": 1, "text": text, "confidence": 0.92, "method": "antiword"}],
                "label": "Cahier des conditions de vente",
                "url": "https://example.test/CCVok.doc",
                "type": "doc",
                "document_type": "cahier_conditions_vente",
            }
        ],
    )

    assert sale.surface_m2 == Decimal("87.58")
    assert sale.land_surface_m2 == Decimal("300")


def test_adaptive_docling_timeout_shortens_signed_documents(tmp_path, monkeypatch) -> None:
    file_path = tmp_path / "ccv-sign.pdf"
    file_path.write_bytes(b"%PDF-1.4\n%%EOF")
    settings = {
        "pdf_docling_timeout_seconds": 180,
        "pdf_docling_fast_timeout_seconds": 45,
        "pdf_docling_threshold_chars": 1200,
    }

    timeout = _adaptive_docling_timeout(
        file_path,
        {
            "label": "CCV sign.pdf",
            "url": "https://example.test/CCV-sign.pdf",
            "document_type": "cahier_conditions_vente",
        },
        settings,
    )

    assert timeout == 45


def test_document_text_cache_roundtrip(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "cache"
    monkeypatch.setattr("src.pdf_enrichment.PDF_DOCUMENT_TEXTS_DIR", cache_dir)
    file_path = tmp_path / "pv.pdf"
    file_path.write_bytes(b"pdf bytes")
    document = {"url": "https://example.test/pv.pdf", "label": "PV", "document_type": "pv_huissier"}
    payload = {
        "label": "PV",
        "url": document["url"],
        "type": "pdf",
        "document_type": "pv_huissier",
        "file_path": str(file_path),
        "text": "Surface 80 m2",
    }

    _write_document_text_cache(document, file_path, payload)

    assert _read_document_text_cache(document, file_path)["text"] == "Surface 80 m2"


def test_store_document_analysis_status_marks_partial_document_coverage() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/doc-coverage",
            "documents": [
                {"label": "PV descriptif", "url": "https://example.test/pv.pdf"},
                {"label": "Cahier des conditions", "url": "https://example.test/ccv.pdf"},
            ],
        }
    )
    documents = [
        {"label": "PV descriptif", "url": "https://example.test/pv.pdf", "document_type": "pv_huissier"},
        {
            "label": "Cahier des conditions",
            "url": "https://example.test/ccv.pdf",
            "document_type": "cahier_conditions_vente",
        },
    ]
    pdf_texts = [
        {
            "label": "PV descriptif",
            "url": "https://example.test/pv.pdf",
            "document_type": "pv_huissier",
            "text": "Surface habitable : 40 m2.",
            "text_chars": 28,
            "page_count": 1,
            "confidence": 0.9,
            "extraction_method": "pymupdf_pages",
        }
    ]

    _store_document_analysis_status(sale, documents, pdf_texts)

    analysis = sale.raw_payload["document_analysis"]
    assert analysis["coverage_status"] == "partial"
    assert "diagnostics" in analysis["missing_core_documents"]
    assert analysis["official_documents_found"] is True
    assert analysis["profiles"][0]["family"] == "constat_et_description"
