import json
from decimal import Decimal

import httpx

from src.normalize import normalize_sale
from src.raw_models import validate_raw_sales
from src.sources import cessions_etat, notaires, petites_affiches
from src.sources.agrasc import parse_agrasc_html
from src.sources.cessions_etat import parse_cessions_etat_detail_html, parse_cessions_etat_html
from src.sources.encheres_immobilieres import parse_encheres_immobilieres_detail_html, parse_encheres_immobilieres_html
from src.sources.notaires import parse_notaires_detail_json, parse_notaires_json
from src.sources.petites_affiches import parse_petites_affiches_detail_html, parse_petites_affiches_html


def test_parse_petites_affiches_public_cards() -> None:
    html = """
    <div class="annonce_lot_1 col-md-6">
      <div class="annonceListe">
        <div class="imgList">
          <a href="/encheres-immobilieres/vente/immobiliere/judiciaire/appartement-bordeaux-1.html">
            <img data-src="/image.jpg" />
          </a>
          <div class="miseAPrix">Mise a Prix : <strong>80 000</strong> €</div>
        </div>
        <div class="titreVente">
          <a href="/encheres-immobilieres/vente/immobiliere/judiciaire/appartement-bordeaux-1.html">
            UN APPARTEMENT a BORDEAUX <br /><strong>Ref. : 123 - Appartement</strong>
          </a>
        </div>
        <div class="lieuVente"><strong>TJ DE BORDEAUX</strong></div>
        <div class="typeVente"><strong>Judiciaire</strong></div>
        <div class="adresse"><strong class="lot-adresse">Bordeaux</strong></div>
        <div class="dateVente"><strong>24/06/2026</strong></div>
        <div class="infos">51 m² - 33000 Bordeaux - Maître Dupont, avocat</div>
      </div>
    </div>
    """

    sales = parse_petites_affiches_html(html, fallback_department="33")

    assert sales[0]["source_name"] == "petites_affiches"
    assert sales[0]["department"] == "33"
    assert sales[0]["city"] == "Bordeaux"
    assert sales[0]["starting_price_eur"] == "80 000"
    assert sales[0]["tribunal"] == "TJ DE BORDEAUX"
    assert sales[0]["surface_m2"] == "51"
    assert sales[0]["postal_code"] == "33000"
    assert sales[0]["lawyer_name"].startswith("Maître Dupont")
    assert validate_raw_sales("petites_affiches", sales, []) == sales


def test_parse_petites_affiches_public_detail() -> None:
    html = """
    <meta name="description" content="Vente aux enchères d'un lot : UN APPARTEMENT à Bordeaux vendu au tribunal judiciaire de TJ DE BORDEAUX le 18/06/2026" />
    <div class="row detail default">
      <h4>Mise à Prix : <strong>15 300</strong> €</h4>
      <div class="alert">réservée aux abonnés</div>
      <div class="lot-adresse"><h4>Adresse : 33000 Bordeaux</h4></div>
    </div>
    <div class="contact-container">
      <ul>
        <li><a title="Maître MERLIN-LABRE"><strong>Maître MERLIN-LABRE</strong></a></li>
        <li>0422140871</li>
      </ul>
      <div class="lieu-vente"><strong><a>TJ DE BORDEAUX</a></strong></div>
    </div>
    <h3>Visites</h3>
    <p>Visite finie</p>
    <p>Jeudi 25 Juin 2026</p>
    <p>à 11:00</p>
    <p>Adresse :</p>
    """

    detail = parse_petites_affiches_detail_html(html, "https://www.petitesaffiches.fr/vente.html")

    assert detail["description"].startswith("Vente aux enchères")
    assert detail["address"] == "33000 Bordeaux"
    assert detail["postal_code"] == "33000"
    assert detail["starting_price_eur"] == "15 300"
    assert detail["lawyer_name"] == "Maître MERLIN-LABRE"
    assert detail["lawyer_contact"] == "0422140871"
    assert detail["tribunal"] == "TJ DE BORDEAUX"
    assert detail["visit_dates"] == ["Visite finie Jeudi 25 Juin 2026 à 11:00"]
    assert detail["source_blocks"]["adresse"] == "33000 Bordeaux"
    assert detail["source_blocks"]["mise_a_prix"] == "15 300"
    assert detail["source_blocks"]["contact_avocat"] == "0422140871"
    assert detail["source_blocks"]["visites"] == "Visite finie Jeudi 25 Juin 2026 à 11:00"


def test_parse_petites_affiches_detail_keeps_thousands_surface() -> None:
    html = """
    <meta name="description" content="Vente aux enchères d'une propriété agricole" />
    <div class="row detail default">
      <h4>Mise à Prix : <strong>9 500 000</strong> €</h4>
      <p>Surface totale : 2 464,70 m²</p>
      <div class="lot-adresse"><h4>Adresse : Beaulieu-sur-Mer</h4></div>
    </div>
    """

    detail = parse_petites_affiches_detail_html(html, "https://www.petitesaffiches.fr/vente.html")

    assert detail["surface_m2"] == "2464,70"


def test_parse_petites_affiches_detail_extracts_documents_when_surface_is_in_attachments() -> None:
    html = """
    <meta name="description" content="Vente aux enchères d'un appartement à Bordeaux" />
    <div class="row detail default">
      <h4>Mise à Prix : <strong>80 000</strong> €</h4>
      <div class="lot-adresse"><h4>Adresse : 33000 Bordeaux</h4></div>
    </div>
    <div class="documents">
      <a href="/docs/pv-descriptif.pdf">Procès-verbal descriptif</a>
      <a href="/docs/cahier-conditions.pdf">Cahier des conditions de vente</a>
      <a href="/encheres-immobilieres/">Retour aux ventes</a>
    </div>
    """

    detail = parse_petites_affiches_detail_html(html, "https://www.petitesaffiches.fr/vente.html")

    assert detail["surface_m2"] is None
    assert detail["documents"] == [
        {
            "label": "Procès-verbal descriptif",
            "url": "https://www.petitesaffiches.fr/docs/pv-descriptif.pdf",
            "type": "pdf",
        },
        {
            "label": "Cahier des conditions de vente",
            "url": "https://www.petitesaffiches.fr/docs/cahier-conditions.pdf",
            "type": "pdf",
        },
    ]
    assert detail["source_blocks"]["documents"] == "Procès-verbal descriptif; Cahier des conditions de vente"


def test_parse_petites_affiches_detail_extracts_property_images_without_site_assets() -> None:
    html = """
    <html>
      <head>
        <meta property="og:image" content="/uploads/ventes/appartement-facade.jpg" />
      </head>
      <body>
        <img src="/images/logo.svg" />
        <img src="/uploads/ventes/appartement-facade.jpg" />
        <img data-src="/uploads/ventes/appartement-cour.webp?cache=1" />
      </body>
    </html>
    """

    detail = parse_petites_affiches_detail_html(html, "https://www.petitesaffiches.fr/vente.html")

    assert detail["raw_image_url"] == "https://www.petitesaffiches.fr/uploads/ventes/appartement-facade.jpg"
    assert detail["source_images"] == [
        "https://www.petitesaffiches.fr/uploads/ventes/appartement-facade.jpg",
        "https://www.petitesaffiches.fr/uploads/ventes/appartement-cour.webp?cache=1",
    ]


def test_petites_affiches_detail_enrichment_merges_card_and_detail_images() -> None:
    class Client:
        def get(self, url: str) -> str:
            assert url == "https://www.petitesaffiches.fr/vente.html"
            return """
            <html>
              <body>
                <img src="/uploads/ventes/detail-cour.jpg" />
                <img src="/uploads/ventes/detail-cour.jpg" />
              </body>
            </html>
            """

    sale = {
        "source_url": "https://www.petitesaffiches.fr/vente.html",
        "raw_image_url": "https://www.petitesaffiches.fr/uploads/ventes/card.jpg",
        "source_images": ["https://www.petitesaffiches.fr/uploads/ventes/card.jpg"],
    }
    errors: list[str] = []

    petites_affiches._enrich_sale_from_detail(Client(), sale, errors)

    assert errors == []
    assert sale["raw_image_url"] == "https://www.petitesaffiches.fr/uploads/ventes/card.jpg"
    assert sale["source_images"] == [
        "https://www.petitesaffiches.fr/uploads/ventes/card.jpg",
        "https://www.petitesaffiches.fr/uploads/ventes/detail-cour.jpg",
    ]


def test_parse_petites_affiches_card_prefers_title_property_type() -> None:
    html = """
    <div class="annonce_lot_165104 col-md-6">
      <div class="annonceListe">
        <div class="titreVente">
          <a href="/encheres-immobilieres/vente/immobiliere/judiciaire/stationnement-cannes-58156.html">
            UN EMPLACEMENT DE STATIONNEMENT à Cannes <br /><strong>Ref. : 165104 - Maison</strong>
          </a>
        </div>
        <div class="lieuVente"><strong>TJ DE GRASSE</strong></div>
        <div class="typeVente"><strong>Judiciaire</strong></div>
        <div class="adresse"><strong class="lot-adresse">Cannes</strong></div>
        <div class="dateVente"><strong>09/07/2026</strong></div>
        <div class="miseAPrix">Mise a Prix : <strong>4 510</strong> €</div>
      </div>
    </div>
    """

    sales = parse_petites_affiches_html(html, fallback_department="06")

    assert sales[0]["property_type"] == "Stationnement"


def test_parse_petites_affiches_card_keeps_apartment_primary_type_with_parking() -> None:
    html = """
    <div class="annonce_lot_165101 col-md-6">
      <div class="annonceListe">
        <div class="titreVente">
          <a href="/encheres-immobilieres/vente/immobiliere/judiciaire/appartement-parking-58148.html">
            UN APPARTEMENT ET UN EMPLACEMENT DE PARKING EXTERIEUR à Remoulins
            <br /><strong>Ref. : 165101 - Maison</strong>
          </a>
        </div>
        <div class="lieuVente"><strong>TJ DE NIMES</strong></div>
        <div class="adresse"><strong class="lot-adresse">Remoulins</strong></div>
        <div class="dateVente"><strong>09/07/2026</strong></div>
        <div class="miseAPrix">Mise a Prix : <strong>70 000</strong> €</div>
      </div>
    </div>
    """

    sales = parse_petites_affiches_html(html, fallback_department="30")

    assert sales[0]["property_type"] == "Appartement"


def test_petites_affiches_uses_single_national_listing_when_all_departments_are_targeted(monkeypatch) -> None:
    monkeypatch.setattr(petites_affiches, "TARGET_DEPARTMENTS", petites_affiches.FRANCE_DEPARTMENTS)

    assert petites_affiches._department_filters() == (None,)


def test_petites_affiches_keeps_department_listing_for_partial_scope(monkeypatch) -> None:
    monkeypatch.setattr(petites_affiches, "TARGET_DEPARTMENTS", ("33", "75"))

    assert petites_affiches._department_filters() == ("33", "75")


def test_petites_affiches_falls_back_to_get_when_national_post_is_refused(monkeypatch) -> None:
    html = """
    <div class="annonce_lot_1 col-md-6">
      <div class="annonceListe">
        <div class="imgList">
          <a href="/encheres-immobilieres/vente/immobiliere/judiciaire/appartement-bordeaux-1.html">
            <img data-src="/image.jpg" />
          </a>
          <div class="miseAPrix">Mise a Prix : <strong>80 000</strong> €</div>
        </div>
        <div class="titreVente">
          <a href="/encheres-immobilieres/vente/immobiliere/judiciaire/appartement-bordeaux-1.html">
            UN APPARTEMENT a BORDEAUX <br /><strong>Ref. : 123 - Appartement</strong>
          </a>
        </div>
        <div class="lieuVente"><strong>TJ DE BORDEAUX</strong></div>
        <div class="dateVente"><strong>24/06/2026</strong></div>
        <div class="infos">51 m² - 33000 Bordeaux - Maître Dupont, avocat</div>
      </div>
    </div>
    """

    class Client:
        def __init__(self, *args, **kwargs) -> None:
            self.calls: list[str] = []

        def post_form(self, url: str, data: dict[str, str]) -> str:
            self.calls.append(f"post:{url}:{data}")
            request = httpx.Request("POST", url)
            response = httpx.Response(403, request=request)
            raise httpx.HTTPStatusError("forbidden", request=request, response=response)

        def get(self, url: str) -> str:
            self.calls.append(f"get:{url}")
            return html

    monkeypatch.setattr(petites_affiches, "TARGET_DEPARTMENTS", petites_affiches.FRANCE_DEPARTMENTS)
    monkeypatch.setattr(petites_affiches, "PoliteHttpClient", Client)
    monkeypatch.setattr(
        petites_affiches,
        "load_settings",
        lambda: {
            "browser_user_agent": "Mozilla/5.0",
            "request_delay_seconds": 0,
            "request_timeout_seconds": 1,
        },
    )
    monkeypatch.setattr(petites_affiches, "_enrich_sale_from_detail", lambda *args, **kwargs: None)

    result = petites_affiches.scrape_petites_affiches_aquitaine_result()

    assert result.errors == []
    assert len(result.sales) == 1
    assert result.sales[0]["source_url"] == (
        "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/judiciaire/"
        "appartement-bordeaux-1.html"
    )


def test_parse_cessions_etat_public_cards() -> None:
    html = """
    <div id="bien-38760" node_id="38760" data-titre="Immeuble a Vendre a Cancon"
      data-localisation="Cancon - 47" data-type-bien="Bureaux / Commerces"
      data-url="/biens/immeuble-vendre-cancon" data-nid="38760"
      data-lat="44.538328" data-lng="0.61918">
      <h3 class="fr-card__title"><a href="/biens/immeuble-vendre-cancon">Immeuble a Vendre a Cancon</a></h3>
      <div class="fr-card__detail">Reference : 240470000</div>
      <div class="fr-card__detail">120 m² - 47290 Cancon</div>
      <img src="/photo.png" />
    </div>
    """

    sales = parse_cessions_etat_html(html)

    assert sales[0]["source_name"] == "cessions_etat"
    assert sales[0]["department"] == "47"
    assert sales[0]["city"] == "Cancon"
    assert sales[0]["surface_m2"] == "120"
    assert sales[0]["postal_code"] == "47290"
    assert sales[0]["source_url"] == "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-vendre-cancon"
    assert sales[0]["source_blocks"]["reference"] == "240470000"
    assert sales[0]["source_blocks"]["type_bien"] == "Bureaux / Commerces"
    assert sales[0]["source_blocks"]["surface"] == "120"
    assert validate_raw_sales("cessions_etat", sales, []) == sales


def test_parse_cessions_etat_public_detail_keeps_source_blocks() -> None:
    html = """
    <article>
      <div class="field--name-body">
        Ancien logement domanial de 134 m² avec terrain. Prix : 210 000 €.
      </div>
      <p>Adresse : 47290 Cancon</p>
      <p>Date limite : 24 septembre 2026 à 12h00</p>
      <p>Visites : sur rendez-vous auprès du service local</p>
      <a href="/documents/cahier.pdf">Cahier des charges</a>
    </article>
    """

    detail = parse_cessions_etat_detail_html(
        html,
        "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-vendre-cancon",
    )

    assert detail["description"].startswith("Ancien logement domanial")
    assert detail["surface_m2"] == "134"
    assert detail["postal_code"] == "47290"
    assert detail["starting_price_eur"] == "210 000"
    assert detail["sale_date"] == "24 septembre 2026 à 12h00"
    assert detail["visit_dates"] == ["sur rendez-vous auprès du service local"]
    assert detail["documents"][0]["label"] == "Cahier des charges"
    assert detail["source_blocks"]["mise_a_prix"] == "210 000"
    assert detail["source_blocks"]["documents"] == "Cahier des charges"


def test_parse_cessions_etat_detail_extracts_property_images_without_site_assets() -> None:
    html = """
    <html>
      <head>
        <meta property="og:image" content="/sites/default/files/styles/large/public/2026-07/cancon-facade.jpg" />
      </head>
      <body>
        <article>
          <div class="field--name-body">Ancien logement domanial de 134 m².</div>
          <img src="/themes/custom/etat/logo.svg" />
          <img src="/sites/default/files/styles/large/public/2026-07/cancon-facade.jpg" />
          <img data-src="/sites/default/files/styles/large/public/2026-07/cancon-cour.webp?itok=1" />
          <a href="/documents/cahier.pdf">Cahier des charges</a>
        </article>
      </body>
    </html>
    """

    detail = parse_cessions_etat_detail_html(
        html,
        "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-vendre-cancon",
    )

    assert detail["raw_image_url"] == (
        "https://cessions.immobilier-etat.gouv.fr/sites/default/files/styles/large/public/2026-07/cancon-facade.jpg"
    )
    assert detail["source_images"] == [
        "https://cessions.immobilier-etat.gouv.fr/sites/default/files/styles/large/public/2026-07/cancon-facade.jpg",
        "https://cessions.immobilier-etat.gouv.fr/sites/default/files/styles/large/public/2026-07/cancon-cour.webp?itok=1",
    ]


def test_cessions_etat_detail_enrichment_merges_card_and_detail_images() -> None:
    class Client:
        def get(self, url: str) -> str:
            assert url == "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-vendre-cancon"
            return """
            <article>
              <div class="field--name-body">Ancien logement domanial de 134 m².</div>
              <img src="/sites/default/files/detail-cour.jpg" />
              <img src="/sites/default/files/detail-cour.jpg" />
            </article>
            """

    sale = {
        "source_url": "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-vendre-cancon",
        "raw_image_url": "https://cessions.immobilier-etat.gouv.fr/sites/default/files/card.jpg",
        "source_images": ["https://cessions.immobilier-etat.gouv.fr/sites/default/files/card.jpg"],
    }
    errors: list[str] = []

    cessions_etat._enrich_sale_from_detail(Client(), sale, errors)

    assert errors == []
    assert sale["raw_image_url"] == "https://cessions.immobilier-etat.gouv.fr/sites/default/files/card.jpg"
    assert sale["source_images"] == [
        "https://cessions.immobilier-etat.gouv.fr/sites/default/files/card.jpg",
        "https://cessions.immobilier-etat.gouv.fr/sites/default/files/detail-cour.jpg",
    ]


def test_parse_cessions_etat_detail_keeps_document_links_without_pdf_extension() -> None:
    html = """
    <article>
      <div class="field--name-body">
        Ancienne brigade de gendarmerie. La surface est indiquée dans le dossier de consultation.
      </div>
      <a href="/telechargement/123">Cahier des charges</a>
      <a href="/telechargement/456">Dossier de consultation</a>
      <a href="/biens/autre-bien">Voir un autre bien</a>
    </article>
    """

    detail = parse_cessions_etat_detail_html(
        html,
        "https://cessions.immobilier-etat.gouv.fr/biens/ancienne-brigade-bayeux",
    )

    assert detail["documents"] == [
        {
            "label": "Cahier des charges",
            "url": "https://cessions.immobilier-etat.gouv.fr/telechargement/123",
            "type": "document",
        },
        {
            "label": "Dossier de consultation",
            "url": "https://cessions.immobilier-etat.gouv.fr/telechargement/456",
            "type": "document",
        },
    ]
    assert detail["source_blocks"]["documents"] == "Cahier des charges; Dossier de consultation"


def test_parse_cessions_etat_detail_extracts_price_de_vente_in_euros_text() -> None:
    html = """
    <article>
      <div class="field--name-body">
        Ancienne brigade de gendarmerie de 486 m². Prix de vente : 210 000 euros.
      </div>
      <p>Adresse : 14400 Bayeux</p>
      <p>Date limite : 24 septembre 2026 à 12h00</p>
    </article>
    """

    detail = parse_cessions_etat_detail_html(
        html,
        "https://cessions.immobilier-etat.gouv.fr/biens/ancienne-brigade-bayeux",
    )

    assert detail["starting_price_eur"] == "210 000"
    assert detail["source_blocks"]["mise_a_prix"] == "210 000"


def test_parse_cessions_etat_detail_handles_state_sale_specific_text() -> None:
    html = """
    <article>
      <div class="field--name-body">
        A rénover, ancien ensemble immobilier sur un terrain d'une superficie totale de 10 553 m2.
        La date limite de réception des offres est fixée au 6 octobre 2026.
      </div>
      <p>Visite Virtuelle (0)</p>
      <p>Aucune visite virtuelle disponible.</p>
      <p>Visite groupée prévue le 01/07/2026 de 10h à 13h et le 03/07/2026 de 14h à 17h.</p>
      <p>La visite est obligatoire pour participer à la vente sous pli cacheté.</p>
      <a href="/documents/dossier.pdf">Dossier de présentation</a>
    </article>
    """

    detail = parse_cessions_etat_detail_html(
        html,
        "https://cessions.immobilier-etat.gouv.fr/biens/ancien-ensemble-immobilier",
    )

    assert detail["surface_m2"] == "10553"
    assert detail["land_surface_m2"] == "10553"
    assert detail["sale_date"] == "6 octobre 2026"
    assert detail["visit_dates"] == [
        "Visite groupée prévue le 01/07/2026 de 10h à 13h et le 03/07/2026 de 14h à 17h.",
        "La visite est obligatoire pour participer à la vente sous pli cacheté.",
    ]
    assert "visite virtuelle" not in " ".join(detail["visit_dates"]).lower()


def test_parse_cessions_etat_detail_ignores_standalone_insee_code_as_postal_code() -> None:
    html = """
    <article>
      <div class="field--name-body">Immeuble de bureaux de 486 m² à Bayeux.</div>
      <p>Bayeux</p>
      <p>14047</p>
    </article>
    """

    detail = parse_cessions_etat_detail_html(
        html,
        "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-de-bureaux-486-m2-bayeux",
    )

    assert detail["postal_code"] is None
    assert "code_postal" not in detail["source_blocks"]


def test_parse_cessions_etat_card_keeps_land_surface_with_thousands() -> None:
    html = """
    <div id="bien-40000" node_id="40000" data-titre="Terrain a vendre a Luzech"
      data-localisation="Luzech - 46" data-type-bien="Foncier"
      data-url="/biens/terrain-luzech" data-nid="40000">
      <h3 class="fr-card__title"><a href="/biens/terrain-luzech">Terrain a vendre a Luzech</a></h3>
      <div class="fr-card__detail">Reference : 240460000</div>
      <div class="fr-card__detail">33 587 m² - 46140 Luzech</div>
    </div>
    """

    sales = parse_cessions_etat_html(html)

    assert sales[0]["surface_m2"] == "33587"
    assert sales[0]["land_surface_m2"] == "33587"
    assert sales[0]["source_blocks"]["surface_terrain"] == "33587"


def test_parse_agrasc_public_real_estate_cards() -> None:
    html = """
    <div class="fr-card card-vente-immo external-link">
      <h3 class="fr-card__title"><a href="https://agrasc.gouv.fr/vente">Maison</a></h3>
      <p class="fr-card__detail">Agen (47)</p>
      <p class="fr-card__desc">Maison avec jardin.</p>
      <p class="fr-badge fr-badge--sm">89 m²</p>
      <p class="fr-badge fr-badge--info">MAP : 91 466 €</p>
      <p class="fr-card__detail">16 au 18 juin 2026</p>
      <img src="/maison.jpg" />
    </div>
    """

    sales = parse_agrasc_html(html)

    assert sales[0]["source_name"] == "agrasc"
    assert sales[0]["department"] == "47"
    assert sales[0]["surface_m2"] == "89"
    assert sales[0]["starting_price_eur"] == "91 466"
    assert sales[0]["raw_image_url"] == "https://agrasc.gouv.fr/maison.jpg"
    assert sales[0]["source_images"] == ["https://agrasc.gouv.fr/maison.jpg"]
    assert sales[0]["source_blocks"]["description"] == "Maison avec jardin."
    assert sales[0]["source_blocks"]["mise_a_prix"] == "91 466"
    assert sales[0]["source_blocks"]["date_vente"] == "18 juin 2026"
    assert validate_raw_sales("agrasc", sales, []) == sales


def test_parse_agrasc_card_filters_site_assets_from_images() -> None:
    html = """
    <div class="fr-card card-vente-immo external-link">
      <h3 class="fr-card__title"><a href="https://example.test/vente">Maison</a></h3>
      <p class="fr-card__detail">Agen (47)</p>
      <p class="fr-card__desc">Maison avec jardin.</p>
      <img src="/assets/logo.svg" />
      <img src="/uploads/ventes/maison-facade.jpg" />
      <img data-src="/uploads/ventes/maison-jardin.webp?cache=1" />
    </div>
    """

    sales = parse_agrasc_html(html)

    assert sales[0]["raw_image_url"] == "https://agrasc.gouv.fr/uploads/ventes/maison-facade.jpg"
    assert sales[0]["source_images"] == [
        "https://agrasc.gouv.fr/uploads/ventes/maison-facade.jpg",
        "https://agrasc.gouv.fr/uploads/ventes/maison-jardin.webp?cache=1",
    ]


def test_parse_agrasc_prefers_badge_surface_and_keeps_land_surface() -> None:
    html = """
    <div class="fr-card card-vente-immo external-link">
      <h3 class="fr-card__title">
        <a href="https://www.36heures.immo/fr/annonce/01KW/maison-macau-33460-4p-75m2-90000euros.html">
          Maison 4 pièces
        </a>
      </h3>
      <p class="fr-card__detail">Macan (33)</p>
      <p class="fr-card__desc">
        À deux pas du bourg de Macau, cette maison possède un terrain de 483 m².
      </p>
      <p class="fr-badge fr-badge--sm fr-badge--info">75 m²</p>
      <p class="fr-card__detail">26 au 27 juillet 2026</p>
      <p class="fr-badge fr-badge--info">MAP : 90 000 €</p>
    </div>
    """

    sales = parse_agrasc_html(html)

    assert sales[0]["city"] == "Macau"
    assert sales[0]["postal_code"] == "33460"
    assert sales[0]["surface_m2"] == "75"
    assert sales[0]["land_surface_m2"] == "483"
    assert sales[0]["sale_date"] == "27 juillet 2026"
    assert sales[0]["source_blocks"]["surface"] == "75"
    assert sales[0]["source_blocks"]["surface_terrain"] == "483"


def test_parse_encheres_immobilieres_next_payload() -> None:
    item = {
        "id": 9001,
        "titre": "APPARTEMENT 2P de 51,66 m2 a PAU (64)",
        "prix": 60000,
        "typeVente": "judiciaire",
        "adresse": "1 rue Test",
        "codePostal": "64000",
        "departement": "64",
        "ville": "PAU",
        "latitude": 43.3,
        "longitude": -0.37,
        "description": "Appartement occupe avec 1 place de parking",
        "url": "9001-appartement-pau-64",
        "dateVente": "$D2026-07-09T09:00:00.000Z",
        "complement": "<p>Appartement occupe avec 1 place de parking</p>",
        "complementVisite": "Sur rendez-vous",
        "prixAdjudication": None,
        "entete": "Cabinet Test",
        "ccv": "RG 1",
        "avocat": {"nom": "Cabinet Test", "tel": "0559000000"},
        "lots": [],
    }
    escaped = json.dumps(item, ensure_ascii=False).replace('"', '\\"')
    html = f'<script>self.__next_f.push([1,"{escaped}"])</script>'

    sales = parse_encheres_immobilieres_html(html)

    assert sales[0]["source_name"] == "encheres_immobilieres"
    assert sales[0]["department"] == "64"
    assert sales[0]["source_url"] == "https://encheresimmobilieres.fr/ventes/9001-appartement-pau-64"
    assert sales[0]["sale_date"] == "2026-07-09T09:00:00.000Z"
    assert sales[0]["occupancy_status"] == "occupied"
    assert sales[0]["surface_m2"] == "51,66"
    assert sales[0]["rooms_count"] == 2
    assert sales[0]["source_blocks"]["surface"] == "51,66"
    assert sales[0]["source_blocks"]["mise_a_prix"] == 60000
    assert sales[0]["source_blocks"]["contact_avocat"] == "0559000000"
    assert validate_raw_sales("encheres_immobilieres", sales, []) == sales


def test_parse_encheres_immobilieres_next_payload_accepts_non_empty_lots() -> None:
    item = {
        "id": 9002,
        "titre": "MAISON T4 de 75 m2 à MACAU (33)",
        "prix": 90000,
        "typeVente": "judiciaire",
        "adresse": "2 rue Test",
        "codePostal": "33460",
        "departement": "33",
        "ville": "MACAU",
        "description": "Maison libre avec jardin.",
        "url": "9002-maison-macau-33",
        "dateVente": "$D2026-07-27T09:00:00.000Z",
        "complement": "<p>Maison libre avec jardin.</p>",
        "complementVisite": None,
        "prixAdjudication": None,
        "entete": "Cabinet Test",
        "ccv": "RG 2",
        "avocat": {"nom": "Cabinet Test", "tel": "0559000000"},
        "lots": [{"numero": 1, "surface": "75 m2"}],
    }
    escaped = json.dumps(item, ensure_ascii=False).replace('"', '\\"')
    html = f'<script>self.__next_f.push([1,"{escaped}"])</script>'

    sales = parse_encheres_immobilieres_html(html)

    assert len(sales) == 1
    assert sales[0]["external_id"] == "9002"
    assert sales[0]["surface_m2"] == "75"
    assert sales[0]["occupancy_status"] == "vacant"


def test_parse_encheres_immobilieres_next_payload_extracts_source_images() -> None:
    item = {
        "id": 9003,
        "titre": "APPARTEMENT T3 à BORDEAUX (33)",
        "prix": 150000,
        "adresse": "1 rue Test",
        "codePostal": "33000",
        "departement": "33",
        "ville": "BORDEAUX",
        "description": "Appartement libre avec balcon.",
        "url": "9003-appartement-bordeaux-33",
        "dateVente": "$D2026-09-10T09:00:00.000Z",
        "photos": [
            {"url": "/uploads/ventes/9003/facade.jpg"},
            {"src": "/uploads/ventes/9003/sejour.webp?size=large"},
            {"url": "/images/logo.svg"},
            {"url": "/documents/9003-pv.pdf"},
        ],
        "lots": [{"photos": [{"url": "/uploads/ventes/9003/facade.jpg"}]}],
    }
    escaped = json.dumps(item, ensure_ascii=False).replace('"', '\\"')
    html = f'<script>self.__next_f.push([1,"{escaped}"])</script>'

    sales = parse_encheres_immobilieres_html(html)

    assert sales[0]["raw_image_url"] == "https://encheresimmobilieres.fr/uploads/ventes/9003/facade.jpg"
    assert sales[0]["source_images"] == [
        "https://encheresimmobilieres.fr/uploads/ventes/9003/facade.jpg",
        "https://encheresimmobilieres.fr/uploads/ventes/9003/sejour.webp?size=large",
    ]


def test_parse_encheres_immobilieres_next_payload_marks_adjudicated_price() -> None:
    item = {
        "id": 9004,
        "titre": "MAISON T4 à MACAU (33)",
        "prix": 90000,
        "prixAdjudication": 126000,
        "adresse": "2 rue Test",
        "codePostal": "33460",
        "departement": "33",
        "ville": "MACAU",
        "description": "Maison libre avec jardin.",
        "url": "9004-maison-macau-33",
        "dateVente": "$D2026-07-27T09:00:00.000Z",
        "lots": [],
    }
    escaped = json.dumps(item, ensure_ascii=False).replace('"', '\\"')
    html = f'<script>self.__next_f.push([1,"{escaped}"])</script>'

    raw = parse_encheres_immobilieres_html(html)[0]
    sale = normalize_sale(raw)

    assert raw["adjudication_price_eur"] == 126000
    assert raw["status"] == "adjudicated"
    assert sale.adjudication_price_eur == Decimal("126000")
    assert sale.status == "adjudicated"


def test_parse_encheres_immobilieres_rendered_listing_fallback(monkeypatch) -> None:
    from datetime import date

    from src.sources import encheres_immobilieres

    class FixtureDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 1)

    monkeypatch.setattr(encheres_immobilieres, "date", FixtureDate)
    html = """
    <main>
      <a href="/ventes/9162-une-maison-dhabitation-a-bonne-74-">
        28 AOÛT Maison UNE MAISON D'HABITATION à BONNE (74) BONNE (74)
        Mise à prix : 120 000 € Tribunal Judiciaire de Thonon les Bains Voir le bien
      </a>
      <a href="/ventes/9160-parcelles-boisees-a-gattieres-06">
        11 AOÛT Parcelles de terre PARCELLES Boisées à GATTIÈRES (06) GATTIÈRES (06)
        Mise à prix : 25 000 € OFFICE NOTARIAL DE LA MANDA Voir le bien
      </a>
    </main>
    """

    sales = parse_encheres_immobilieres_html(html)

    assert len(sales) == 2
    assert sales[0]["source_url"] == "https://encheresimmobilieres.fr/ventes/9162-une-maison-dhabitation-a-bonne-74-"
    assert sales[0]["external_id"] == "9162"
    assert sales[0]["department"] == "74"
    assert sales[0]["city"] == "Bonne"
    assert sales[0]["property_type"] == "maison"
    assert sales[0]["title"] == "UNE MAISON D'HABITATION à BONNE (74)"
    assert sales[0]["starting_price_eur"] == "120 000"
    assert sales[0]["tribunal"] == "Tribunal Judiciaire de Thonon les Bains"
    assert sales[0]["sale_date"].endswith("août 2026")
    assert sales[1]["property_type"] == "terrain"
    assert sales[1]["tribunal"] is None
    assert "OFFICE NOTARIAL DE LA MANDA" in sales[1]["raw_text"]


def test_parse_encheres_immobilieres_detail_html_extracts_rich_static_page() -> None:
    html = """
    <article>
      <h1>UNE MAISON D'HABITATION à BONNE (74)</h1>
      <p>MISE À PRIX</p><p>120 000 €</p>
      <p>Annonce n° 9162</p>
      <p>Adresse de la vente :</p>
      <p>Tribunal Judiciaire de Thonon les Bains - 10 Rue de l'Hotel Dieu, 74200 THONON LES BAINS</p>
      <p>Date de la vente :</p><p>vendredi 28 août 2026 à 15h00</p>
      <p>Visite(s) du bien :</p><p>lundi 24 août 2026 de 15h00 à 16h00</p>
      <h2>Descriptif du bien</h2>
      <p>Réf. annonce : 9162</p>
      <p>SCP PIANTA & ASSOCIES, Avocats 4 Place de l'Hôtel de Ville 74200 THONON LES BAINS Tél. 04.50.26.00.22</p>
      <p>À BONNE (74), 983 chemin de chez Desbois</p>
      <p>UNE MAISON D'HABITATION</p>
      <p>La maison, d’une superficie Loi Carrez de 125.05 m2, est édifiée sur trois niveaux.</p>
      <p>Les biens mis en vente sont occupés par le propriétaire et sa famille.</p>
      <p>Avocat poursuivant</p><p>PIANTA ET ASSOCIÉS (SCP)</p>
      <p>4 Place de l'Hôtel de ville</p><p>74200 Thonon-les-Bains</p>
      <p>Tél. : 0450260022 Fax : 04 50 26 08 95</p>
      <img src="/assets/logo.svg" />
      <img data-src="/uploads/ventes/9162/maison-facade.jpg" />
      <img src="/documents/9162-pv.pdf" />
    </article>
    """

    detail = parse_encheres_immobilieres_detail_html(
        html,
        "https://encheresimmobilieres.fr/ventes/9162-une-maison-dhabitation-a-bonne-74-",
    )

    assert detail["external_id"] == "9162"
    assert detail["department"] == "74"
    assert detail["city"] == "Bonne"
    assert detail["address"] == "983 chemin de chez Desbois"
    assert detail["surface_m2"] == "125.05"
    assert detail["starting_price_eur"] == "120 000"
    assert detail["sale_date"] == "vendredi 28 août 2026 à 15h00"
    assert detail["visit_dates"] == ["lundi 24 août 2026 de 15h00 à 16h00"]
    assert detail["tribunal"] == "Tribunal Judiciaire de Thonon les Bains"
    assert detail["lawyer_name"] == "PIANTA ET ASSOCIÉS (SCP)"
    assert detail["lawyer_contact"] == "04.50.26.00.22"
    assert detail["occupancy_status"] == "owner_occupied"
    assert detail["raw_image_url"] == "https://encheresimmobilieres.fr/uploads/ventes/9162/maison-facade.jpg"
    assert detail["source_images"] == ["https://encheresimmobilieres.fr/uploads/ventes/9162/maison-facade.jpg"]
    assert detail["source_blocks"]["tribunal"] == "Tribunal Judiciaire de Thonon les Bains"


def test_parse_encheres_immobilieres_detail_html_drops_template_description_placeholder() -> None:
    html = """
    <h1>UNE VILLA TRADITIONNELLE à GLEIZÉ (69)</h1>
    <p>Réf. annonce : 9155</p>
    <p>$d4</p>
    <p>Avocat poursuivant</p>
    """

    detail = parse_encheres_immobilieres_detail_html(
        html,
        "https://encheresimmobilieres.fr/ventes/9155-une-villa-traditionnelle-a-gleize-69",
    )

    assert detail["description"] is None
    assert "$d4" not in detail["raw_text"]


def test_parse_encheres_immobilieres_detail_html_does_not_treat_visit_libre_as_vacant() -> None:
    html = """
    <article>
      <h1>UN APPARTEMENT à PAU (64)</h1>
      <p>MISE À PRIX</p><p>90 000 €</p>
      <p>Annonce n° 9170</p>
      <p>Adresse du bien</p><p>12 rue Test, 64000 PAU</p>
      <p>Date de la vente :</p><p>jeudi 10 septembre 2026 à 14h00</p>
      <p>Visite(s) du bien :</p><p>visite libre le lundi 7 septembre 2026 de 10h00 à 11h00</p>
      <h2>Descriptif du bien</h2>
      <p>Appartement de 48 m2 vendu loué à un locataire suivant bail d'habitation.</p>
    </article>
    """

    detail = parse_encheres_immobilieres_detail_html(
        html,
        "https://encheresimmobilieres.fr/ventes/9170-un-appartement-a-pau-64",
    )

    assert detail["occupancy_status"] == "rented"


def test_parse_encheres_immobilieres_detail_html_extracts_documents_when_surface_is_in_attachments() -> None:
    html = """
    <article>
      <h1>UN APPARTEMENT à PAU (64)</h1>
      <p>MISE À PRIX</p><p>90 000 €</p>
      <p>Annonce n° 9171</p>
      <p>Adresse du bien</p><p>12 rue Test, 64000 PAU</p>
      <p>Date de la vente :</p><p>jeudi 10 septembre 2026 à 14h00</p>
      <h2>Descriptif du bien</h2>
      <p>Appartement vendu suivant les informations du procès-verbal descriptif.</p>
      <a href="/documents/9171-pv-descriptif.pdf">Procès-verbal descriptif</a>
      <a href="/documents/9171-cahier-conditions.pdf">Cahier des conditions de vente</a>
      <a href="/contact">Contact avocat</a>
    </article>
    """

    detail = parse_encheres_immobilieres_detail_html(
        html,
        "https://encheresimmobilieres.fr/ventes/9171-un-appartement-a-pau-64",
    )

    assert detail["surface_m2"] is None
    assert detail["documents"] == [
        {
            "label": "Procès-verbal descriptif",
            "url": "https://encheresimmobilieres.fr/documents/9171-pv-descriptif.pdf",
            "type": "pdf",
        },
        {
            "label": "Cahier des conditions de vente",
            "url": "https://encheresimmobilieres.fr/documents/9171-cahier-conditions.pdf",
            "type": "pdf",
        },
    ]
    assert detail["source_blocks"]["documents"] == "Procès-verbal descriptif; Cahier des conditions de vente"


def test_parse_encheres_immobilieres_detail_html_converts_are_centiare_land_surface() -> None:
    html = """
    <article>
      <h1>PARCELLES Boisées à GATTIÈRES (06)</h1>
      <p>MISE À PRIX</p><p>25 000 €</p>
      <p>Réf. annonce : 9160</p>
      <p>Adresse du bien</p><p>Lieudit Les Escaputeous , 06510 GATTIÈRES</p>
      <p>Date de mise en vente</p><p>mardi 11 août 2026 à 09h00</p>
      <h2>Descriptif du bien</h2>
      <p>OFFICE NOTARIAL DE LA MANDA Maître Leila PALOMBIERI</p>
      <p>Sur la commune de GATTIÈRES (Alpes-Maritimes), la ou les parcelle(s) suivante(s) :</p>
      <p>section C numéro 0429 pour une contenance de 52a, section C numéro 0453 pour une contenance de 63a 20ca</p>
      <p>Avocat poursuivant</p><p>OFFICE NOTARIAL DE LA MANDA</p>
    </article>
    """

    detail = parse_encheres_immobilieres_detail_html(
        html,
        "https://encheresimmobilieres.fr/ventes/9160-parcelles-boisees-a-gattieres-06",
    )

    assert detail["property_type"] == "terrain"
    assert detail["land_surface_m2"] == "11520"
    assert detail["starting_price_eur"] == "25 000"
    assert detail["tribunal"] is None
    assert detail["source_blocks"]["surface_terrain"] == "11520"


def test_parse_notaires_public_api_payload() -> None:
    payload = json.dumps(
        {
            "annonceResumeDto": [
                {
                    "id": 1,
                    "annonceId": 2,
                    "reference": "VNI-TEST",
                    "typeTransaction": "VNI",
                    "descriptionFr": "Maison a vendre en immo-interactif",
                    "communeNom": "Bordeaux",
                    "codePostal": "33000",
                    "inseeDepartement": "33",
                    "typeBien": "MAI",
                    "surface": 100,
                    "prixAffiche": 250000,
                    "dateDebutEncheres": "2026-07-09T11:00:00Z",
                    "urlDetailAnnonceFr": "https://www.immo-interactif.fr/encheres-en-ligne/maison/bordeaux-33/2",
                },
                {"id": 3, "typeTransaction": "VENTE", "inseeDepartement": "33"},
            ]
        }
    )

    sales = parse_notaires_json(payload)

    assert len(sales) == 1
    assert sales[0]["source_name"] == "notaires"
    assert sales[0]["department"] == "33"
    assert sales[0]["property_type"] == "maison"
    assert sales[0]["starting_price_eur"] == 250000
    assert validate_raw_sales("notaires", sales, []) == sales


def test_notaires_uses_national_api_when_all_departments_are_targeted(monkeypatch) -> None:
    monkeypatch.setattr(notaires, "TARGET_DEPARTMENTS", notaires.FRANCE_DEPARTMENTS)

    assert notaires._department_filters() == (None,)
    assert "departements=" not in notaires._api_url(1, "VAE", None)


def test_notaires_keeps_department_filter_for_targeted_override(monkeypatch) -> None:
    monkeypatch.setattr(notaires, "TARGET_DEPARTMENTS", ("33", "75"))

    assert notaires._department_filters() == ("33", "75")
    assert "departements=33" in notaires._api_url(1, "VAE", "33")


def test_notaires_stops_pagination_when_api_reports_page_out_of_range(monkeypatch) -> None:
    list_payload = json.dumps(
        {
            "annonceResumeDto": [
                {
                    "annonceId": 123,
                    "typeTransaction": "VAE",
                    "urlDetailAnnonceFr": "https://www.immobilier.notaires.fr/fr/annonce-immo/test",
                    "inseeDepartement": "33",
                    "communeNom": "Bordeaux",
                    "typeBien": "APP",
                    "descriptionFr": "Appartement à Bordeaux",
                    "prixAffiche": 80000,
                    "seanceDate": "2026-06-24",
                }
            ]
        }
    )

    class Client:
        requested: list[str] = []

        def __init__(self, *args, **kwargs) -> None:
            pass

        def get(self, url: str) -> str:
            self.requested.append(url)
            if "page=1" in url and "typeTransactions=VAE" in url:
                return list_payload
            if "page=2" in url and "typeTransactions=VAE" in url:
                request = httpx.Request("GET", url)
                response = httpx.Response(
                    400,
                    text='{"message":"Le numéro de page demandé est supérieur au nombre de pages"}',
                    request=request,
                )
                raise httpx.HTTPStatusError("bad request", request=request, response=response)
            return json.dumps({"annonceResumeDto": []})

    monkeypatch.setattr(notaires, "PoliteHttpClient", Client)
    monkeypatch.setattr(
        notaires,
        "load_settings",
        lambda: {
            "user_agent": "immojudis-test",
            "request_delay_seconds": 0,
            "request_timeout_seconds": 1,
            "notaires_max_pages": 2,
        },
    )
    monkeypatch.setattr(notaires, "_enrich_sale_from_detail", lambda *args, **kwargs: True)

    result = notaires.scrape_notaires_aquitaine_result(max_pages=2)

    assert result.errors == []
    assert len(result.sales) == 1
    assert any("page=2" in url and "typeTransactions=VAE" in url for url in Client.requested)


def test_parse_notaires_detail_api_payload_extracts_rich_fields() -> None:
    payload = json.dumps(
        {
            "id": 1963393,
            "typeTransaction": "VAE",
            "vae": {
                "reference": "260633VaeTondu",
                "multimedias": [
                    {
                        "urlHighestResolution": (
                            "https://media.immobilier.notaires.fr/inotr/media/0/33015/1963393/photo_QXGA.jpg"
                        ),
                        "vga": {
                            "url": "https://media.immobilier.notaires.fr/inotr/media/0/33015/1963393/photo_VGA.jpg"
                        },
                    }
                ],
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Immeuble en pierre",
                        "descLongue": (
                            "VENTE AUX ENCHERES\nBORDEAUX (33000) 65, RUE DU TONDU\n"
                            "Un immeuble en pierre à usage d'habitation et de commerce de 206.90 m², "
                            "avec 2 chambres, salle d'eau et dépendance à usage de garage. "
                            "Arrêté de péril. ABSENCE DE VISITE. DPE Non soumis. "
                            "Me Edouard FIGEROU, notaire à Bordeaux."
                        ),
                    }
                ],
                "visite": {"visiteLibre": "mercredi 27 mai de 14h00 a 15h00"},
                "miseAPrix": 300000,
                "consignation": 60000,
                "dateMaj": "2026-06-08T08:58:49Z",
                "seanceDate": "2026-06-24T12:30:00Z",
                "adresse4": "6 rue Mably",
                "codePostal": "33000",
                "ville": "BORDEAUX",
                "bienVendu": "NON",
                "origineJudiciaire": "ADJUDICATION",
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "adresse4": "65 RUE DU TONDU",
                    "codePostal": "33000",
                    "communeNom": "Bordeaux",
                    "inseeDepartement": "33",
                    "departementNom": "Gironde",
                    "surfaceHabitable": 206.9,
                    "surfaceTerrain": 266,
                    "nbPieces": 4,
                    "situationLocative": "LIBRE",
                    "stationnement": "INCONNU",
                    "ancienNeuf": "ANCIEN",
                    "etat": "RENOVER",
                    "sousType": "VILLE",
                    "nbEtages": 1,
                    "coordonneesExactesW84": {"coordonneeX": -0.57918, "coordonneeY": 44.837789},
                },
            },
            "contact": {"nom": "Service immobilier", "telephone": "0761761899", "mail": "vente@example.test"},
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["address"] == "65 RUE DU TONDU, 33000 Bordeaux"
    assert detail["property_type"] == "immeuble"
    assert detail["description"].startswith("VENTE AUX ENCHERES BORDEAUX (33000) 65, RUE DU TONDU")
    assert detail["habitable_surface_m2"] == 206.9
    assert detail["land_surface_m2"] == 266
    assert detail["surface_source"] == "notaires.surfaceHabitable"
    assert detail["surface_confidence"] == 0.95
    assert "surfaceHabitable" in detail["surface_evidence"]
    assert detail["bedrooms_count"] == 2
    assert detail["bathrooms_count"] == 1
    assert detail["has_garage"] is True
    assert detail["occupancy_status"] == "LIBRE"
    assert detail["risk_notes"] == "Arrêté de péril; Absence de visite; DPE non soumis"
    assert detail["latitude"] == 44.837789
    assert detail["longitude"] == -0.57918
    assert detail["source_images"] == [
        "https://media.immobilier.notaires.fr/inotr/media/0/33015/1963393/photo_QXGA.jpg"
    ]
    assert detail["lawyer_contact"] == "0761761899 | vente@example.test"
    assert detail["source_blocks"]["consignation"] == 60000
    assert detail["source_blocks"]["origine_judiciaire"] == "ADJUDICATION"
    assert detail["source_blocks"]["source_updated_at"] == "2026-06-08T08:58:49Z"
    assert detail["source_blocks"]["auction_location"] == "6 rue Mably, 33000 BORDEAUX"
    assert detail["source_blocks"]["notary_name"] == "Me Edouard FIGEROU"
    assert detail["source_blocks"]["usage"] == "VILLE"
    assert detail["source_blocks"]["etat"] == "RENOVER"
    assert detail["source_blocks"]["ancien_neuf"] == "ANCIEN"
    assert detail["source_blocks"]["nb_etages"] == 1


def test_notary_from_text_keeps_french_letters_and_rejects_math_symbols() -> None:
    assert notaires._notary_from_text("Me Élodie D'ŒUVRE, notaire à Bordeaux.") == "Me Élodie D'ŒUVRE"
    assert notaires._notary_from_text("MAÎTRE ÉLODIE D’ŒUVRE, notaire à Bordeaux.") == "Me ÉLODIE D’ŒUVRE"
    assert notaires._notary_from_text("Me Élodie D'ŒUVRE×FAUSSE, notaire à Bordeaux.") is None
    assert notaires._notary_from_text("Me Élodie D'ŒUVRE÷FAUSSE, notaire à Bordeaux.") is None
    assert notaires._notary_from_text("Me Élodie KFAUSSE, notaire à Bordeaux.") is None


def test_parse_notaires_detail_prefers_precise_text_surface_and_ignores_visit_ui_state() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VNI",
            "vni": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Maison de plain-pied",
                        "descLongue": (
                            "Maison de plain-pied avec combles aménagés, construite en 1968 "
                            "d'une surface de 126,70 m² habitables environ. "
                            "ABSENCE DE VISITE (arrêté de péril)."
                        ),
                    }
                ],
                "visite": {
                    "visiteLibre": "ABSENCE DE VISITE (arrêté de péril)",
                    "visiteFixe": '[{"opened":false}]',
                },
                "premierPrix": 329000,
                "dateDebutEncheres": "2026-08-07T10:00:00Z",
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "adresse4": "23 Rue Eugène Delacroix",
                    "codePostal": "33160",
                    "communeNom": "Saint-Médard-en-Jalles",
                    "inseeDepartement": "33",
                    "surfaceHabitable": 126,
                    "surfaceTerrain": 489,
                    "nbPieces": 6,
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["surface_m2"] == 126.7
    assert detail["habitable_surface_m2"] == 126.7
    assert detail["surface_source"] == "notaires.description.surface_batie"
    assert detail["surface_confidence"] == 0.9
    assert "126,70 m² habitables" in detail["surface_evidence"]
    assert detail["visit_dates"] == ["ABSENCE DE VISITE (arrêté de péril)"]


def test_parse_notaires_detail_rejects_balcony_surface_as_habitable_outlier() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VNI",
            "vni": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Appartement T2 avec balcon",
                        "descLongue": (
                            "L'appartement de 40 m² habitables (39,67 m² Loi Carrez) "
                            "avec 9 m² de balcon se compose d'une chambre et d'un séjour."
                        ),
                    }
                ],
                "premierPrix": 250000,
                "dateDebutEncheres": "2026-08-07T10:00:00Z",
            },
            "bien": {
                "typeBien": "APP",
                "appartement": {
                    "typeBien": "APP",
                    "surfaceHabitable": 9,
                    "codePostal": "83270",
                    "communeNom": "Saint-Cyr-sur-Mer",
                    "inseeDepartement": "83",
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["surface_m2"] == 40
    assert detail["habitable_surface_m2"] == 40
    assert detail["carrez_surface_m2"] == 39.67
    assert detail["surface_source"] == "notaires.description.surface_batie"
    assert "40 m² habitables" in detail["surface_evidence"]


def test_parse_notaires_detail_does_not_replace_global_surface_with_room_surface() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VNI",
            "vni": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Appartement duplex",
                        "descLongue": (
                            "Appartement deux pièces avec combles aménagés : 28 m² Carrez et 47,67 m² au sol. "
                            "La chambre aménagée dans les combles a une superficie de 23,4 m² dont 5,6 m² Carrez."
                        ),
                    }
                ]
            },
            "bien": {
                "typeBien": "APP",
                "appartement": {
                    "typeBien": "APP",
                    "surfaceHabitable": 47,
                    "codePostal": "75007",
                    "communeNom": "Paris",
                    "inseeDepartement": "75",
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["habitable_surface_m2"] == 47
    assert detail["carrez_surface_m2"] == 28
    assert detail["surface_source"] == "notaires.surfaceHabitable"


def test_parse_notaires_detail_keeps_thousands_text_surface() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VNI",
            "vni": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Grande maison",
                        "descLongue": "Maison d'une surface de 2 464,70 m² habitables environ. Libre.",
                    }
                ],
                "premierPrix": 300000,
                "dateDebutEncheres": "2026-08-07T10:00:00Z",
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "adresse4": "1 rue Test",
                    "codePostal": "33000",
                    "communeNom": "Bordeaux",
                    "inseeDepartement": "33",
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["surface_m2"] == 2464.7
    assert detail["habitable_surface_m2"] == 2464.7
    assert detail["surface_source"] == "notaires.description.surface_batie"
    assert "2 464,70 m² habitables" in detail["surface_evidence"]


def test_parse_notaires_detail_extracts_address_from_description() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VAE",
            "vae": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descLongue": (
                            "LE TEICH (33470) – 20 Rue du Milon Quartier résidentiel "
                            "Maison à démolir 52 m² environ, faisant l'objet d'un arrêté de péril. "
                            "Le tout sur un terrain cadastré pour 322 m²."
                        ),
                    }
                ],
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "codePostal": "33470",
                    "communeNom": "Teich",
                    "inseeDepartement": "33",
                    "surfaceTerrain": 322,
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["address"] == "20 Rue du Milon, 33470 Teich"
    assert detail["property_type"] == "maison"
    assert detail["surface_m2"] == 52
    assert detail["habitable_surface_m2"] is None
    assert detail["land_surface_m2"] == 322
    assert detail["surface_source"] == "notaires.description.surface_batie"
    assert "Maison à démolir 52 m² environ" in detail["surface_evidence"]


def test_parse_notaires_detail_extracts_main_surface_from_description_without_structured_field() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VAE",
            "vae": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Immeuble en pierre",
                        "descLongue": (
                            "BORDEAUX (33000) 65, RUE DU TONDU "
                            "Un immeuble en pierre à usage d'habitation et de commerce de 206.90 m², comprenant : "
                            "- Sous-sol partiel de 35 m² environ. "
                            "- A l'étage : un appartement de 84 m² environ. "
                            "Ledit ensemble est cadastré section n° 179 et HN n°219 pour un total de 266 m²."
                        ),
                    }
                ],
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "adresse4": "65 RUE DU TONDU",
                    "codePostal": "33000",
                    "communeNom": "Bordeaux",
                    "inseeDepartement": "33",
                    "surfaceTerrain": 266,
                    "nbPieces": 4,
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["property_type"] == "immeuble"
    assert detail["surface_m2"] == 206.9
    assert detail["habitable_surface_m2"] is None
    assert detail["land_surface_m2"] == 266
    assert detail["surface_source"] == "notaires.description.surface_batie"
    assert "immeuble en pierre" in detail["surface_evidence"]


def test_parse_notaires_detail_keeps_cadastral_surface_when_habitable_placeholder() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VAE",
            "vae": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Maison à réhabiliter",
                        "descLongue": (
                            "BORDEAUX (33000) 135, RUE KLÉBER Une maison à réhabiliter. "
                            "Cadastrée section CT n°363 pour un total de 44 m². DPE : Non soumis."
                        ),
                    }
                ],
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "adresse4": "135 RUE KLÉBER",
                    "codePostal": "33000",
                    "communeNom": "Bordeaux",
                    "inseeDepartement": "33",
                    "surfaceHabitable": 1.0,
                    "nbPieces": 5,
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["address"] == "135 RUE KLÉBER, 33000 Bordeaux"
    assert detail["property_type"] == "maison"
    assert detail["surface_m2"] is None
    assert detail["habitable_surface_m2"] is None
    assert detail["land_surface_m2"] == 44
    assert detail["surface_source"] == "notaires.description.cadastre"
    assert detail["surface_confidence"] == 0.9
    assert detail["surface_evidence"] == "Cadastrée section CT n°363 pour un total de 44 m²."
    assert detail["rooms_count"] == 5
    assert detail["risk_notes"] == "DPE non soumis"


def test_parse_notaires_detail_keeps_thousands_cadastral_surface_as_land() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VAE",
            "vae": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Maison à réhabiliter",
                        "descLongue": (
                            "BORDEAUX (33000) 135, RUE KLÉBER Une maison à réhabiliter. "
                            "Cadastrée section CT n°363 pour un total de 2 464,70 m². DPE : Non soumis."
                        ),
                    }
                ],
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "adresse4": "135 RUE KLÉBER",
                    "codePostal": "33000",
                    "communeNom": "Bordeaux",
                    "inseeDepartement": "33",
                    "surfaceHabitable": 1.0,
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["surface_m2"] is None
    assert detail["habitable_surface_m2"] is None
    assert detail["land_surface_m2"] == 2464.7
    assert detail["surface_source"] == "notaires.description.cadastre"
    assert "2 464,70 m²" in detail["surface_evidence"]


def test_notarial_generic_area_is_not_promoted_to_habitable():
    detail = parse_notaires_detail_json(json.dumps({
        'typeTransaction': 'VNI', 'vni': {'descriptions': [{'langue':'fr', 'descLongue':
            'Maison de 176 m² au sol, dont environ 150 m² habitables.'}]},
        'bien': {'typeBien':'MAI', 'maison': {'typeBien':'MAI'}}}))
    assert detail['habitable_surface_m2'] == 150


def test_notarial_api_description_contradiction_keeps_both_values():
    detail = parse_notaires_detail_json(json.dumps({
        'id': 2069118, 'typeTransaction': 'VNI', 'vni': {'descriptions': [{'langue':'fr', 'descLongue':
            'Maison de 176 m² au sol, dont environ 150 m² habitables.'}]},
        'bien': {'typeBien':'MAI', 'maison': {'typeBien':'MAI','surfaceHabitable':176.89}}}))
    conflict = detail['source_conflicts'][0]
    assert {conflict['selected'], conflict['alternative']} == {176.89, 150}
    assert conflict['selected_source'].endswith('/2069118')
    assert conflict['evidence']['api_surfaceHabitable'] == 176.89
