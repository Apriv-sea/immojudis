from decimal import Decimal

import pytest

from src import recompute_scoring as recompute_module
from src.asset_normalization import normalize_asset_features
from src.models import AuctionSale
from src.recompute_scoring import _sale_from_storage_row, _validate_persisted_sale_procedure


def test_fetch_sales_uses_retrying_postgrest_transport(monkeypatch) -> None:
    monkeypatch.setattr(
        recompute_module,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )
    calls: list[dict[str, object]] = []

    class Response:
        is_error = False
        status_code = 200
        text = ""

        def __init__(self, rows):
            self._rows = rows

        def json(self):
            return self._rows

    pages = iter([[{"source_url": "https://example.test/sale"}]])

    def fake_request(method, endpoint, *, table, **kwargs):
        calls.append({"method": method, "endpoint": endpoint, "table": table, **kwargs})
        return Response(next(pages))

    monkeypatch.setattr(recompute_module, "_postgrest_request_with_retries", fake_request)

    rows = recompute_module._fetch_sales(source=None, limit=None)

    assert rows == [{"source_url": "https://example.test/sale"}]
    assert len(calls) == 1
    assert all(call["method"] == "GET" for call in calls)
    assert all(call["table"] == "auction_sales" for call in calls)


def test_merge_refetched_source_details_preserves_and_extends_evidence() -> None:
    merged = recompute_module._merge_refetched_source_details(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://www.encheres-publiques.com/encheres/lot_123",
            "raw_payload": {
                "source_blocks": {"mise_a_prix": "100000"},
                "collector_marker": "preserved",
            },
        },
        {
            "address": "1 rue Exemple, 74000 Annecy",
            "raw_text": "Vente volontaire organisée par Office du Parc",
            "source_blocks": {
                "organisateur": "Office du Parc",
                "organisateur_categorie": "notaire",
            },
            "status": "unknown",
        },
    )

    assert merged["address"] == "1 rue Exemple, 74000 Annecy"
    assert merged["raw_payload"]["collector_marker"] == "preserved"
    assert merged["raw_payload"]["source_blocks"] == {
        "mise_a_prix": "100000",
        "organisateur": "Office du Parc",
        "organisateur_categorie": "notaire",
    }
    assert merged["raw_payload"]["procedure_source_refresh"]["status"] == "verified_source_page"
    assert "status" not in merged or merged["status"] != "unknown"


def test_refresh_unknown_sale_procedures_refetches_only_supported_unknowns(monkeypatch) -> None:
    rows = [
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/example/123.html",
            "sale_venue_type": "unknown",
            "raw_payload": {},
        },
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/known",
            "sale_venue_type": "unknown",
            "raw_payload": {},
        },
    ]
    refreshed = AuctionSale(
        source_name="licitor",
        source_url="https://www.licitor.com/annonce/example/123.html",
        sale_venue_type="tribunal",
    )
    writes: list[str] = []

    monkeypatch.setattr(recompute_module, "_load_env_fallbacks", lambda: None)
    monkeypatch.setattr(recompute_module, "_fetch_sales", lambda **_kwargs: rows)
    monkeypatch.setattr(recompute_module, "_procedure_refresh_clients", lambda: {})
    monkeypatch.setattr(
        recompute_module,
        "_fetch_procedure_source_details",
        lambda row, _clients: {"raw_text": "Tribunal judiciaire de Paris"},
    )
    monkeypatch.setattr(
        recompute_module,
        "_recomputed_sale_from_storage_row",
        lambda row, geocode: refreshed,
    )
    monkeypatch.setattr(
        recompute_module,
        "upsert_sales_to_supabase",
        lambda sales, refresh_last_seen: writes.extend(sale.source_url for sale in sales) or len(sales),
    )

    exit_code = recompute_module.refresh_unknown_sale_procedures()

    assert exit_code == 0
    assert writes == ["https://www.licitor.com/annonce/example/123.html"]


def test_recomputed_sale_validates_geocode_before_court_assignment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_geocode(sale: AuctionSale) -> AuctionSale:
        calls.append("geocode")
        sale.raw_payload["geocode"] = {
            "provider": "ban_geoplateforme",
            "accepted": True,
            "citycode": "33063",
        }
        return sale

    def fake_tribunal(sale: AuctionSale) -> AuctionSale:
        calls.append("tribunal")
        assert sale.raw_payload["geocode"]["citycode"] == "33063"
        return sale

    monkeypatch.setattr(recompute_module, "geocode_sale", fake_geocode)
    monkeypatch.setattr(recompute_module, "fill_tribunal", fake_tribunal)
    monkeypatch.setattr(recompute_module, "classify_sale_procedure", lambda sale: calls.append("procedure") or sale)
    monkeypatch.setattr(recompute_module, "normalize_asset_features", lambda sale: calls.append("assets") or sale)

    sale = recompute_module._recomputed_sale_from_storage_row(
        {
            "id": "historical-geocode",
            "source_name": "avoventes",
            "source_url": "https://example.test/historical-geocode",
            "address": "30 cours de l'Intendance",
            "postal_code": "33000",
            "city": "Bordeaux",
            "raw_payload": {},
        },
        geocode=True,
    )

    assert sale.raw_payload["geocode"]["provider"] == "ban_geoplateforme"
    assert calls == ["geocode", "tribunal", "procedure", "assets"]


def test_storage_recompute_preserves_editorial_text_for_surface_reconciliation() -> None:
    row = {
        "id": "725939b3-f8f1-4c84-b8c4-32be90143291",
        "source_name": "encheres_publiques",
        "source_url": "https://example.test/130432",
        "property_type": "house",
        "title": "Maison 1 877 m²",
        "description": "Description d'affichage stockée",
        "surface_m2": 1877,
        "habitable_surface_m2": 1877,
        "app_surface_m2": 1877,
        "raw_payload": {
            "title": "Un ensemble immobilier de 187 m² situé rue Gâte-Bourse",
            "description": (
                "Un ensemble immobilier de 10 pièces de 187 m² avec un garage de 18 m², "
                "édifié sur une parcelle de 1 110 m²."
            ),
            "surface_m2": 1877,
            "habitable_surface_m2": 1877,
        },
    }

    sale = _sale_from_storage_row(row)
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("187")
    assert sale.habitable_surface_m2 is None
    assert sale.land_surface_m2 == Decimal("1110")
    assert sale.app_surface_m2 == Decimal("187")
    assert sale.raw_payload["surface_reconciliation"]["rejected_surface_m2"] == "1877"


def test_storage_recompute_reclassifies_future_unknown_status() -> None:
    row = {
        "id": "future-status",
        "source_name": "info_encheres",
        "source_url": "https://example.test/future-status",
        "status": "unknown",
        "sale_date": "2099-10-15T13:00:00+00:00",
        "raw_payload": {"status": "unknown"},
    }

    sale = _sale_from_storage_row(row)

    assert sale.status == "upcoming"


def test_storage_recompute_restores_partial_pdf_surface_scope() -> None:
    row = {
        "id": "35f44afc-36ff-4c0b-93c0-4288334989a2",
        "source_name": "info_encheres",
        "source_url": "https://www.info-encheres.com/vente-6009.html",
        "property_type": "apartment",
        "title": "Appartement 4 m²",
        "surface_m2": 3.78,
        "carrez_surface_m2": 3.78,
        "app_surface_m2": 3.78,
        "app_surface_kind": "carrez",
        "surface_scope": "total",
        "surface_source": "pdf",
        "surface_confidence": 0.45,
        "raw_payload": {
            "surface_extraction": {
                "source": "pdf",
                "value_m2": "3.78",
                "surface_scope": "partial",
            }
        },
    }

    sale = _sale_from_storage_row(row)
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("3.78")
    assert sale.carrez_surface_m2 == Decimal("3.78")
    assert sale.app_surface_m2 is None
    assert sale.app_surface_kind is None
    assert sale.surface_scope == "partial"
    assert sale.title == "Appartement"


def test_persisted_sale_procedure_validation_accepts_consistent_payload() -> None:
    row = {
        "sale_venue_type": "tribunal",
        "sale_legal_framework": "judicial_seizure",
        "sale_verification_status": "cross_checked",
        "sale_procedure": {
            "schema_version": "sale_procedure_v1",
            "venue_type": "tribunal",
            "legal_framework": "judicial_seizure",
            "rules": {"lawyer_required": True},
            "verification": {"status": "cross_checked"},
        },
    }

    assert _validate_persisted_sale_procedure(row) == []


def test_persisted_sale_procedure_validation_rejects_empty_or_inconsistent_payload() -> None:
    assert _validate_persisted_sale_procedure(
        {
            "sale_venue_type": "tribunal",
            "sale_legal_framework": "judicial_seizure",
            "sale_verification_status": "verified",
            "sale_procedure": {},
        }
    ) == ["missing sale_procedure"]

    issues = _validate_persisted_sale_procedure(
        {
            "sale_venue_type": "notary",
            "sale_legal_framework": "voluntary_notarial",
            "sale_verification_status": "verified",
            "sale_procedure": {
                "schema_version": "outdated",
                "venue_type": "tribunal",
                "legal_framework": "unknown",
                "verification": {"status": "pending"},
            },
        }
    )

    assert issues == [
        "invalid schema_version",
        "venue_type mismatch",
        "legal_framework mismatch",
        "missing rules",
        "verification status mismatch",
    ]


def test_persisted_sale_procedure_validation_detects_stale_but_well_formed_payload() -> None:
    row = {
        "sale_venue_type": "tribunal",
        "sale_legal_framework": "unknown",
        "sale_verification_status": "pending",
        "sale_procedure": {
            "schema_version": "sale_procedure_v1",
            "ruleset_version": "fr_auction_participation_2026-08-20",
            "venue_type": "tribunal",
            "legal_framework": "unknown",
            "participation_mode": "in_person",
            "rules": {"lawyer_required": None},
            "verification": {"status": "pending"},
        },
    }
    expected = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/stale",
        sale_venue_type="tribunal",
        sale_legal_framework="judicial_seizure",
        sale_verification_status="verified",
        sale_procedure={
            "ruleset_version": "fr_auction_participation_2026-08-20",
            "participation_mode": "lawyer_mandate",
            "rules": {"lawyer_required": True},
        },
    )

    assert _validate_persisted_sale_procedure(row, expected_sale=expected) == [
        "legal_framework differs from recompute",
        "verification status differs from recompute",
        "participation_mode differs from recompute",
        "rules differs from recompute",
    ]
