from decimal import Decimal

from src.normalize import normalize_sale
from src.sources import licitor
from src.sources.licitor import (
    RobotsRules,
    parse_licitor_detail_html,
    parse_licitor_list_html,
    parse_licitor_list_sales,
)


def test_robots_rules_allows_public_licitor_pages_and_blocks_disallowed_documents() -> None:
    rules = RobotsRules.parse(
        """
        User-agent: *
        Disallow: /data/pub/doc/
        Disallow: /services.html

        User-agent: ClaudeBot
        Disallow: /
        """,
        "immojudis-data-pipeline/1.0 (+contact@example.com)",
    )

    assert rules.can_fetch(
        "https://www.licitor.com/ventes-aux-encheres-immobilieres/paris-et-ile-de-france/prochaines-ventes.html"
    )
    assert rules.can_fetch("https://www.licitor.com/annonce/10/84/61/x/108461.html")
    assert not rules.can_fetch("https://www.licitor.com/data/pub/doc/example.pdf")


def test_parse_licitor_list_html_extracts_detail_and_next_urls() -> None:
    html = """
    <a href="/ventes-aux-encheres-immobilieres/paris-et-ile-de-france/prochaines-ventes.html?p=2">2</a>
    <a href="/annonce/10/86/25/vente-aux-encheres/une-maison/merignac/gironde/108625.html">
      33 Mérignac Une maison Mise à prix : 200 000 €
    </a>
    """
    details, next_urls = parse_licitor_list_html(html)

    assert details == [
        "https://www.licitor.com/annonce/10/86/25/vente-aux-encheres/une-maison/merignac/gironde/108625.html"
    ]
    assert next_urls == [
        "https://www.licitor.com/ventes-aux-encheres-immobilieres/paris-et-ile-de-france/prochaines-ventes.html?p=2"
    ]


def test_parse_licitor_list_html_rejects_cross_origin_links() -> None:
    html = """
    <a href="https://evil.example/annonce/10/86/25/vente/108625.html">Annonce</a>
    <a href="https://evil.example/ventes-aux-encheres-immobilieres/test/prochaines-ventes.html?p=2">2</a>
    """

    assert parse_licitor_list_html(html) == ([], [])
    assert parse_licitor_list_sales(html) == []


def test_parse_licitor_list_sales_extracts_light_listing() -> None:
    html = """
    <div class="Result">
      <a href="/annonce/10/91/27/vente-aux-encheres/trois-appartements/paris-2eme/paris/109127.html">
        <span>75</span>
        <span>Paris 2ème</span>
        <strong>Trois appartements</strong>
        <p>dans le bâtiment A, au 2ème, 3ème et 4ème étage</p>
        <span>Mise à prix :</span>
        <span>82 610 €</span>
        <time>Mercredi 10 juin</time>
      </a>
    </div>
    """

    sales = parse_licitor_list_sales(html)

    assert sales[0]["source_url"] == (
        "https://www.licitor.com/annonce/10/91/27/vente-aux-encheres/"
        "trois-appartements/paris-2eme/paris/109127.html"
    )
    assert sales[0]["external_id"] == "109127"
    assert sales[0]["department"] == "75"
    assert sales[0]["city"] == "Paris 2ème"
    assert sales[0]["title"] == "Trois appartements"
    assert sales[0]["starting_price_eur"] == "82 610 €"
    assert sales[0]["source_blocks"]["mise_a_prix"] == "82 610 €"
    assert sales[0]["source_blocks"]["ville"] == "Paris 2ème"


def test_licitor_uses_aquitaine_listing_page_for_aquitaine_targets(monkeypatch) -> None:
    monkeypatch.setattr(licitor, "TARGET_DEPARTMENTS", ("24", "33", "40", "47", "64"))

    assert licitor._start_urls_for_target_departments() == (licitor.AQUITAINE_URL,)


def test_licitor_uses_all_listing_pages_for_national_targets(monkeypatch) -> None:
    monkeypatch.setattr(licitor, "TARGET_DEPARTMENTS", ("33", "75"))

    assert licitor._start_urls_for_target_departments() == licitor.LICITOR_ZONE_URLS


def test_parse_licitor_detail_html_extracts_national_postal_code() -> None:
    html = """
    <h1>Annonce n°109000 : un appartement à Paris (Paris), mise à prix : 100 000 €</h1>
    <p>Tribunal Judiciaire de Paris</p>
    <h2>Un appartement</h2>
    <h3>Mise à prix : 100 000 €</h3>
    <p>Paris</p>
    <p>12 rue Test - 75001 Paris</p>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/90/00/vente-aux-encheres/un-appartement/paris/paris/109000.html",
    )

    assert raw["department"] == "75"
    assert raw["postal_code"] == "75001"


def test_parse_licitor_detail_html_derives_paris_arrondissement_postal_code_from_location_block() -> None:
    html = """
    <section class="AddressBlock">
      <div class="Lot">
        <div class="FirstSousLot SousLot">
          <h2>Un appartement</h2>
          <p>de 31,60 m², comprenant : entrée, salle d'eau avec wc, pièce principale avec placard.</p>
        </div>
        <h3>Mise à prix : 100 000 €</h3>
      </div>
      <div class="Location">
        <p class="City">Paris 19ème</p>
        <p class="Street">66, rue du Pré Saint Gervais</p>
        <p class="Map"><a href="https://maps.google.fr/maps?q=48.8787613,2.3979249&amp;z=13">Afficher le plan</a></p>
      </div>
    </section>
    <h3>Maître Philippe Marion, Avocat</h3>
    <p>29, rue Jean de la Fontaine - 75016 Paris</p>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/87/81/vente-aux-encheres/un-appartement/paris-19eme/paris/108781.html",
    )
    sale = normalize_sale(raw)

    assert raw["postal_code"] == "75019"
    assert raw["department"] == "75"
    assert sale.address == "66, rue du Pré Saint Gervais, 75019 Paris 19ème"
    assert sale.rooms_count == 1
    assert sale.latitude == Decimal("48.8787613")
    assert sale.longitude == Decimal("2.3979249")


def test_parse_licitor_detail_html_accepts_missing_postal_code() -> None:
    html = """
    <h1>Annonce n°108625 : une maison d'habitation à Mérignac (Gironde), mise à prix : 200 000 €</h1>
    <p>Annonce publiée le</p>
    <p>6 mai 2026</p>
    <p>108625</p>
    <p>Tribunal Judiciaire de Bordeaux (Gironde)</p>
    <p>Vente aux enchères publiques</p>
    <p>jeudi 11 juin 2026 à 15h</p>
    <h2>Une maison d'habitation</h2>
    <h3>Mise à prix : 200 000 €</h3>
    <p>Mérignac</p>
    <p>2, av. des Azalés</p>
    <p><a href="https://carto.example.test/plan?q=44.8401,-0.6512&z=13">Afficher le plan</a></p>
    <p>Visite sur place mardi 26 mai 2026 de 10h à 12h</p>
    <h3>Maître Juliette André, de ABR et associés, Avocat</h3>
    <p>4, quai Hubert Prom - 33300 Bordeaux</p>
    <p>Tél.: 05 35 54 98 12</p>
    <p>Surface habitable : 90 m² environ</p>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/86/25/vente-aux-encheres/une-maison/merignac/gironde/108625.html",
    )
    sale = normalize_sale(raw)

    assert raw["external_id"] == "108625"
    assert raw["surface_m2"] == "90"
    assert raw["source_blocks"]["mise_a_prix"] == "200 000 €"
    assert raw["source_blocks"]["visites"] == "Visite sur place mardi 26 mai 2026 de 10h à 12h"
    assert raw["source_blocks"]["contact_avocat"] == "4, quai Hubert Prom - 33300 Bordeaux | Tél.: 05 35 54 98 12"
    assert sale.source_name == "licitor"
    assert sale.department == "33"
    assert sale.city == "Mérignac"
    assert sale.postal_code is None
    assert sale.address == "2, av. des Azalés, Mérignac"
    assert sale.latitude == Decimal("44.8401")
    assert sale.longitude == Decimal("-0.6512")
    assert sale.starting_price_eur == 200000
    assert sale.property_type == "house"
    assert sale.visit_dates == ["Visite sur place mardi 26 mai 2026 de 10h à 12h"]
    assert sale.lawyer_contact == "4, quai Hubert Prom - 33300 Bordeaux | Tél.: 05 35 54 98 12"


def test_parse_licitor_detail_html_keeps_thousands_surface() -> None:
    html = """
    <h1>Annonce n°100001 : une propriété à Bordeaux (Gironde), mise à prix : 100 000 €</h1>
    <p>Tribunal Judiciaire de Bordeaux (Gironde)</p>
    <p>Vente aux enchères publiques</p>
    <p>jeudi 11 juin 2026 à 15h</p>
    <h2>Une propriété</h2>
    <h3>Mise à prix : 100 000 €</h3>
    <p>Bordeaux</p>
    <p>Surface totale : 2 464,70 m² environ, libre de toute occupation.</p>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/00/01/vente-aux-encheres/une-propriete/bordeaux/gironde/100001.html",
    )
    sale = normalize_sale(raw)

    assert raw["surface_m2"] == "2464,70"
    assert sale.surface_m2 == Decimal("2464.70")


def test_parse_licitor_detail_html_accepts_square_symbol_without_m() -> None:
    html = """
    <h1>Annonce n°109135 : un bâtiment à usage de bureaux à Vieillevigne</h1>
    <p>Tribunal Judiciaire de Nantes</p>
    <p>Vente aux enchères publiques</p>
    <p>jeudi 3 septembre 2026 à 10h</p>
    <h2>Un bâtiment à usage de bureaux</h2>
    <h3>Mise à prix : 120 000 €</h3>
    <p>Vieillevigne</p>
    <div class="AddressBlock">
      <div class="Lot">
        <div class="SousLot"><p>de 636,70 ², comprenant vingt bureaux et des salles de réunion.</p></div>
      </div>
    </div>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/91/35/vente-aux-encheres/bureaux/vieillevigne/109135.html",
    )
    sale = normalize_sale(raw)

    assert raw["surface_m2"] == "636,70"
    assert sale.surface_m2 == Decimal("636.70")


def test_parse_licitor_detail_html_accepts_first_day_ordinal_sale_date() -> None:
    html = """
    <h1>Annonce n°109151 : un appartement à Sarcelles (Val-d'Oise), mise à prix : 44 000 €</h1>
    <p>Tribunal Judiciaire de Pontoise (Val d'Oise)</p>
    <p>Vente aux enchères publiques en un lot</p>
    <p>mardi 1er septembre 2026 à 14h</p>
    <h2>Un appartement</h2>
    <p>d'une superficie privative (Loi Carrez - hors loggia) de 123,84 m²</p>
    <h3>Mise à prix : 44 000 €</h3>
    <p>Sarcelles</p>
    <p>32, av. du 8 mai 1945</p>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/91/51/vente-aux-encheres/un-appartement/sarcelles/val-d-oise/109151.html",
    )
    sale = normalize_sale(raw)

    assert raw["sale_date"] == "mardi 1er septembre 2026 à 14h"
    assert sale.sale_date is not None
    assert sale.surface_m2 == Decimal("123.84")


def test_parse_licitor_detail_html_keeps_linked_pdf_documents() -> None:
    html = """
    <h1>Annonce n°108762 : divers biens à Montardon (Pyrénées-Atlantiques), mise à prix : 500 000 €</h1>
    <p>Tribunal Judiciaire de Pau</p>
    <a href="https://www.licitor.com/data/pub/media/annonce/10/87/62/108762.000.001.pdf">PV descriptif</a>
    <a href="/data/pub/media/annonce/10/87/62/108762.000.002.pdf">Cahier des conditions de vente</a>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/87/62/vente-aux-encheres/divers-biens/montardon/pyrenees-atlantiques/108762.html",
    )

    assert raw["documents"] == [
        {
            "label": "PV descriptif",
            "url": "https://www.licitor.com/data/pub/media/annonce/10/87/62/108762.000.001.pdf",
            "type": "pdf",
        },
        {
            "label": "Cahier des conditions de vente",
            "url": "https://www.licitor.com/data/pub/media/annonce/10/87/62/108762.000.002.pdf",
            "type": "pdf",
        },
    ]


def test_parse_licitor_detail_html_keeps_document_links_without_pdf_extension() -> None:
    html = """
    <h1>Annonce n°108763 : appartement à Bordeaux (Gironde), mise à prix : 90 000 €</h1>
    <p>Tribunal Judiciaire de Bordeaux</p>
    <p>La superficie exacte est indiquée dans les documents de vente.</p>
    <a href="/download/document?id=108763&pvd=1">PV descriptif</a>
    <a href="/download/document?id=108763&piece=cahier">Cahier des conditions de vente</a>
    <a href="/annuaire/avocats.html">Avocats</a>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/87/63/vente-aux-encheres/appartement/bordeaux/gironde/108763.html",
    )

    assert raw["surface_m2"] is None
    assert raw["documents"] == [
        {
            "label": "PV descriptif",
            "url": "https://www.licitor.com/download/document?id=108763&pvd=1",
            "type": "pdf",
        },
        {
            "label": "Cahier des conditions de vente",
            "url": "https://www.licitor.com/download/document?id=108763&piece=cahier",
            "type": "pdf",
        },
    ]
    assert raw["source_blocks"]["documents"] == "PV descriptif; Cahier des conditions de vente"


def test_parse_licitor_detail_html_does_not_treat_navigation_and_partner_links_as_documents() -> None:
    html = """
    <h1>Annonce n°109014 : une hutte de chasse à Warhem</h1>
    <a href="https://itunes.apple.com/fr/app/licitor/id1024474985?mt=8"><img alt="Application iOS"></a>
    <a href="https://play.google.com/store/apps/details?id=fr.tiddle.licitor"></a>
    <a href="https://www.licitor.com/"></a>
    <a href="https://app-pro.la-loupe.immo/ext-partenaire/licitor/token/">Voir le dossier complet avec La Loupe</a>
    <a href="/download/document?id=109014&amp;pvd=1">PV descriptif</a>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/90/14/vente-aux-encheres/une-hutte-de-chasse/warhem/nord/109014.html",
    )

    assert raw["documents"] == [
        {
            "label": "PV descriptif",
            "url": "https://www.licitor.com/download/document?id=109014&pvd=1",
            "type": "pdf",
        }
    ]


def test_parse_licitor_detail_html_extracts_ad_images_without_site_assets() -> None:
    html = """
    <h1>Annonce n°108762 : divers biens à Montardon (Pyrénées-Atlantiques), mise à prix : 500 000 €</h1>
    <article class="LegalAd">
      <img src="static/img/licitor.png">
      <img src="/data/pub/media/annonce/10/87/62/maison.jpg">
    </article>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/87/62/vente-aux-encheres/divers-biens/montardon/pyrenees-atlantiques/108762.html",
    )

    assert raw["raw_image_url"] == "https://www.licitor.com/data/pub/media/annonce/10/87/62/maison.jpg"
    assert raw["source_images"] == ["https://www.licitor.com/data/pub/media/annonce/10/87/62/maison.jpg"]


def test_explicit_non_required_sale_is_withdrawn_without_inventing_result():
    raw = parse_licitor_detail_html(
        '<h1>Une maison</h1><p>jeudi 10 septembre 2026 à 14h</p><p>Vente non requise</p>',
        'https://www.licitor.com/annonce/109001.html',
    )
    sale = normalize_sale(raw)
    assert sale.status == 'withdrawn'
    assert sale.adjudication_price_eur is None


def test_explicit_postponement_protects_old_date_from_expiration():
    from src.admission import retention_deadline

    raw = parse_licitor_detail_html(
        '<h1>Une maison</h1><p>jeudi 10 septembre 2026 à 14h</p><p>Vente reportée</p>',
        'https://www.licitor.com/annonce/109002.html',
    )
    sale = normalize_sale(raw)
    assert sale.status == 'postponed'
    assert retention_deadline(sale) is None


def test_unknown_adjudication_result_remains_unknown():
    raw = parse_licitor_detail_html(
        "<h1>Une maison</h1><p>Résultat d'adjudication inconnu</p>",
        'https://www.licitor.com/annonce/109003.html',
    )
    assert raw['status'] == 'unknown'
    assert normalize_sale(raw).adjudication_price_eur is None
