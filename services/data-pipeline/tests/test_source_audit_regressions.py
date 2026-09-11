"""Reduced fixtures from public pages inspected on 2026-09-11."""
from decimal import Decimal

import pytest

from src.enrichment.extract_structured import _format_surface_value
from src.normalize import normalize_sale
from src.sources import avoventes, cessions_etat, info_encheres, petites_affiches, vench


def test_explicit_free_lot_is_not_confused_with_underlying_land_lease():
    text = "La parcelle a été donnée à bail aux copropriétaires. BIENS LIBRES D’OCCUPATION."
    assert info_encheres._extract_occupancy_status(text) == "vacant"
    assert info_encheres._extract_occupancy_status("BIEN OCCUPE PAR LES PROPRIETAIRES.") == "owner_occupied"
    assert info_encheres._extract_occupancy_status("Appartement donné à bail à un locataire.") == "rented"


@pytest.mark.parametrize("module,url", [
    (info_encheres, "https://www.info-encheres.com/pix/home.png"),
    (info_encheres, "https://www.info-encheres.com/pix/facebook.png"),
    (vench, "https://www.vench.fr/Design/Img/autopromo-abo.png"),
    (petites_affiches, "https://www.petitesaffiches.fr/encheres-immobilieres/images/captcha.png"),
    (petites_affiches, "https://www.petitesaffiches.fr/squelettes/images/kiosque-petites-affiches.jpg"),
])
def test_site_ui_assets_are_not_property_photos(module, url):
    assert not module._looks_like_property_image(url)
    assert module._looks_like_property_image("https://example.fr/ventes/123/photo.jpg")


def test_institutional_and_subscription_links_are_not_sale_documents():
    assert not petites_affiches._looks_like_document_link("/conditions-generales-de-vente,14787.html", "CGV Abonnements")
    assert not cessions_etat._looks_like_document_link("https://immobilier-etat.gouv.fr/qui-nous-sommes/presentation/", "Qui sommes-nous ?")
    assert petites_affiches._looks_like_document_link("/files/cahier.pdf", "Cahier des conditions de vente")
    assert cessions_etat._looks_like_document_link("/cahier.pdf?download=1", "Cahier")


def test_cessions_current_dom_recovers_description_sale_time_and_open_visits():
    html = """<div id="panel-bien"><div class="texte"><div class="fr-text">
    Terrain constructible. Visites libres.</div></div>
    <p>Date d'adjudication : 05/11/2026</p>
    <p>Commentaire : Adjudication le jeudi 05 novembre 2026 à 15h30</p></div>
    <p>Visites libres.</p><a href="/cahier.pdf?download=1">Cahier</a>"""
    raw = cessions_etat.parse_cessions_etat_detail_html(html, cessions_etat.BASE_URL + "/biens/test")
    assert raw["description"] == "Terrain constructible. Visites libres."
    assert raw["sale_date"] == "05/11/2026 à 15h30"
    assert "Visites libres." in raw["visit_dates"]
    assert raw["documents"][0]["type"] == "pdf"
    assert normalize_sale(raw).sale_date.isoformat() == "2026-11-05T14:30:00+00:00"
    assert cessions_etat._extract_sale_date("Date d'adjudication : 05/11/2026\nCommentaire : Visite le 04 novembre 2026 à 10h30") == "05/11/2026"


def test_avoventes_description_is_the_lot_not_nearby_comparables():
    html = """<h1>Appartement</h1><p>Vente aux enchères</p><p>Mise à prix : 80 000 €</p>
    <h2>À propos du bien</h2><div>Appartement T2. Superficie loi Carrez : 51,10 m². Loué 780 €/mois.</div>
    <h2>À proximité</h2><div>Supermarché, parking 50 places</div>
    <h2>Données des valeurs foncières</h2><table><tr><td>Maison voisine 600 000 €</td></tr></table>
    <div>Informations complémentaires :</div><div>Chauffage collectif.</div>"""
    raw = avoventes.parse_avoventes_detail_html(html, avoventes.BASE_URL + "/enchere/test")
    assert "Appartement T2" in raw["description"]
    assert "Chauffage collectif" in raw["description"]
    assert "600 000" not in raw["raw_text"]
    assert "50 places" not in raw["raw_text"]
    assert "51,10" in raw["raw_text"]


@pytest.mark.parametrize("value,expected", [("140", "140"), ("120", "120"), ("51.10", "51,1"), ("1E+3", "1000")])
def test_fallback_surface_never_uses_scientific_notation(value, expected):
    assert _format_surface_value(Decimal(value)) == expected


def test_known_media_cannot_restore_icons_after_a_fresh_detail():
    from src.main import _preserve_known_enrichment_payloads
    sale = {"source_url": "u", "source_detail_status": "complete", "source_images": []}
    known = {"u": {"raw_payload": {"source_images": ["https://www.info-encheres.com/pix/home.png"],
                                   "raw_image_url": "https://www.info-encheres.com/pix/home.png"}}}
    _preserve_known_enrichment_payloads([sale], known)
    assert sale["source_images"] == []
    assert not sale.get("raw_image_url")


def test_notaires_keeps_list_record_when_detail_fails(monkeypatch):
    import json

    from src.sources import notaires
    monkeypatch.setattr(notaires, "_department_filters", lambda: (None,))
    monkeypatch.setattr(notaires, "TARGET_DEPARTMENTS", ("33",))
    class Client:
        def __init__(self, **kwargs):
            pass
        def get(self, url):
            if "?" not in url:
                raise RuntimeError("detail temporarily unavailable")
            return json.dumps({"annonceResumeDto": [{"annonceId": 42, "typeTransaction": "VAE",
                "inseeDepartement": "33", "descriptionFr": "Appartement", "prixAffiche": 80000,
                "seanceDate": "2026-11-05", "urlDetailAnnonceFr": notaires.BASE_URL + "/fr/annonce-immo/42"}]})
    monkeypatch.setattr(notaires, "PoliteHttpClient", Client)
    result = notaires.scrape_notaires_aquitaine_result(max_pages=1)
    assert len(result.sales) == 1
    assert result.errors
    assert result.sales[0]["source_detail_status"] == "failed"
    from src.main import _hydrate_known_unchanged_sales
    sale = result.sales[0]
    _hydrate_known_unchanged_sales([sale], {sale["source_url"]: {
        "description": "Description détaillée déjà vérifiée.", "occupancy_status": "vacant",
        "starting_price_eur": 70000, "documents": [{"url": "https://example.fr/pv.pdf"}]}})
    assert sale["description"] == "Description détaillée déjà vérifiée."
    assert sale["starting_price_eur"] == 80000
    assert sale["occupancy_status"] == "vacant"
    assert sale["documents"]


def test_old_extractor_version_requires_a_new_source_read():
    from datetime import UTC, datetime

    from src.freshness import detail_is_fresh
    assert not detail_is_fresh({"raw_payload": {"source_checks": {"u": {
        "checked_at": datetime.now(UTC).isoformat(), "extractor_version": "old"}}}}, "u")


def test_quality_distinguishes_model_description_from_fallback():
    from src.enrichment.extract_structured import LLMEnrichmentStats
    from src.pdf_enrichment import PdfEnrichmentStats
    from src.quality import build_quality_report
    sales = [normalize_sale({"source_url": "https://example.fr/" + status,
                            "llm_display_status": status}) for status in ["accepted", "fallback", "rejected"]]
    report = build_quality_report(sales, PdfEnrichmentStats(), LLMEnrichmentStats())
    assert report["llm_display_accepted"] == 1
    assert report["llm_display_fallback"] == 1
    assert report["llm_display_rejected"] == 1


def test_agrasc_operator_enrichment_preserves_identity_and_closing_date():
    import json

    from src.sources.agrasc_operators import enrich_agrasc_operator
    from src.sources.notaires import BASE_URL
    sale = {"source_name": "agrasc", "source_url": "https://www.immo-interactif.fr/encheres-en-ligne/maison/test/42",
            "external_id": "42", "description": "Maison", "source_blocks": {"origine": "AGRASC"}}
    class Client:
        def get(self, url):
            return json.dumps({"id": 42, "typeTransaction": "VNI", "bien": {"typeBien": "MAI", "maison": {
                "surfaceHabitable": 140, "surfaceTerrain": 1623}}, "vni": {
                "descriptions": [{"langue": "fr", "descLongue": "Maison avec garage. Travaux à prévoir."}],
                "dateDebutEncheres": "2026-10-31T23:00:00Z", "dateFinEncheres": "2026-11-01T23:00:00Z"}})
    errors = []
    enrich_agrasc_operator(sale, {BASE_URL: Client()}, {}, errors)
    assert errors == []
    assert sale["source_name"] == "agrasc" and sale["external_id"] == "42"
    assert sale["source_url"].startswith("https://www.immo-interactif.fr/")
    assert sale["sale_date"] == "2026-11-01T23:00:00Z"
    assert sale["land_surface_m2"] == 1623
    assert sale["operator_detail_status"] == "complete"


def test_agrasc_operator_identity_and_product_metadata_are_checked():
    import json

    from src.sources.agrasc_operators import parse_agora_operator_images, parse_immo_operator_json
    with pytest.raises(ValueError, match="identity"):
        parse_immo_operator_json(json.dumps({"id": 43}), "42")
    url = "https://www.agorastore-immo.fr/vente/maison-430647.aspx"
    html = '<script type="application/ld+json">' + json.dumps({"@type": "Product", "productID": "430647",
        "image": "https://cdn.agorastore.fr/produits/photo.jpg"}) + '</script>'
    assert parse_agora_operator_images(html, url) == ["https://cdn.agorastore.fr/produits/photo.jpg"]
    assert parse_agora_operator_images(html, url.replace("430647", "430648")) == []


def test_info_encheres_uses_audience_hour_not_office_opening_hours():
    text = "Cabinet ouvert de 10h à 12h. L'audience des ventes débute à 13h30."
    assert info_encheres._sale_date_with_audience_time("03/09/2026", text) == "03/09/2026 à 13h30"
    assert info_encheres._sale_date_with_audience_time("02/09/2026", "L'AUDIENCE DES VENTES DÉBUTE À 9H.") == "02/09/2026 à 9h00"
    assert info_encheres._sale_date_with_audience_time("03/09/2026", "Cabinet ouvert de 10h à 12h.") == "03/09/2026"
