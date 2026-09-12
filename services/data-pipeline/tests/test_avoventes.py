from decimal import Decimal

from src.normalize import normalize_sale
from src.sources.avoventes import parse_avoventes_detail_html, parse_avoventes_html


def test_parse_avoventes_html_extracts_public_sale_fields() -> None:
    html = """
    <article>
      <h2>Vente aux enchères Maison</h2>
      <a href="/enchere/maison-bordeaux-123">Voir la vente</a>
      <p>12 rue Test 33000 Bordeaux</p>
      <p>Mise à prix : 120 000 €</p>
      <p>Date de la vente : jeudi 10 janvier 2027 à 09h00</p>
      <p>Date des visites : 5 janvier 2027 à 10h00</p>
      <p>Cabinet : Me Test</p>
      <a href="/docs/vente.pdf">Cahier des conditions</a>
    </article>
    """

    sales = parse_avoventes_html(
        html, page_url="https://avoventes.fr/recherche?departement=33", fallback_department="33"
    )

    assert len(sales) == 1
    assert sales[0]["source_url"] == "https://avoventes.fr/enchere/maison-bordeaux-123"
    assert sales[0]["postal_code"] == "33000"
    assert sales[0]["city"] == "Bordeaux"
    assert sales[0]["starting_price_eur"] == "120 000 €"
    assert sales[0]["lawyer_name"] == "Me Test"
    assert sales[0]["source_blocks"]["mise_a_prix"] == "120 000 €"
    assert sales[0]["source_blocks"]["date_vente"] == "jeudi 10 janvier 2027 à 09h00"
    assert sales[0]["source_blocks"]["cabinet"] == "Me Test"
    assert sales[0]["documents"][0]["url"] == "https://avoventes.fr/docs/vente.pdf"
    assert sales[0]["documents"][0]["type"] == "pdf"


def test_parse_avoventes_html_rejects_cross_origin_sale_and_document_urls() -> None:
    html = """
    <article data-link="https://evil.example/enchere/replace-existing-sale">
      <h2>Maison à Bordeaux</h2>
      <p>Mise à prix : 100 000 €</p>
      <p>Date de la vente : 10 septembre 2026</p>
      <a href="https://evil.example/cahier.pdf">Cahier des conditions de vente</a>
    </article>
    """

    assert parse_avoventes_html(html) == []


def test_parse_avoventes_html_extracts_adjudication_without_polluting_title() -> None:
    html = """
    <article>
      <h2>Vente aux enchères Autres</h2>
      <h3>UN BATIMENT D'EXPLOITATION AGRICOLE A HAUT-VALROMEY</h3>
      <a href="/enchere/batiment-agricole">Voir la vente</a>
      <p>01260 Haut-Valromey, France</p>
      <p>Mise à prix initiale : 35 000,00 €</p>
      <p>Adjugé :</p><p>36 000,00 €</p>
      <p>Surenchère possible jusqu'au 10 juillet 2026</p>
      <p>Date de la vente : mardi 30 juin 2026 à 14h00</p>
    </article>
    """

    raw = parse_avoventes_html(html, page_url="https://avoventes.fr/recherche", fallback_department="01")[0]
    sale = normalize_sale(raw)

    assert raw["title"] == "UN BATIMENT D'EXPLOITATION AGRICOLE A HAUT-VALROMEY"
    assert raw["adjudication_price_eur"] == "36 000,00 €"
    assert raw["source_blocks"]["prix_adjudication"] == "36 000,00 €"
    assert sale.starting_price_eur == Decimal("35000.00")
    assert sale.adjudication_price_eur == Decimal("36000.00")
    assert sale.status == "adjudicated"


def test_parse_avoventes_detail_html_extracts_pdf_documents() -> None:
    html = """
    <html>
      <body>
        <a href="/public/uploads/documents/affiche.pdf">Affiche greffe</a>
        <a href="/conditions-generales-dutilisation">CGU</a>
      </body>
    </html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/test")

    assert details["documents"] == [
        {
            "label": "Affiche greffe",
            "url": "https://avoventes.fr/public/uploads/documents/affiche.pdf",
            "type": "pdf",
        }
    ]
    assert details["source_blocks"]["documents"] == "Affiche greffe"


def test_catalogue_returned_for_removed_detail_is_not_parsed_as_property():
    import pytest

    from src.sources.avoventes import _enrich_sale_from_detail

    html = '<html><title>AVOVENTES - Ventes aux enchères publiques immobilières</title><select>'
    html += ''.join(f'<option>Ville {i}</option>' for i in range(101))
    html += '</select><h2>Appartement à vendre à Riorges 42120</h2></html>'
    with pytest.raises(ValueError, match='identity unverified'):
        parse_avoventes_detail_html(html, 'https://avoventes.fr/enchere/le-cannet')
    class Client:
        def get(self, url):
            return html
    sale = {'source_url':'https://avoventes.fr/enchere/le-cannet','postal_code':'06110'}
    errors = []
    _enrich_sale_from_detail(Client(), sale, errors)
    assert sale['_detail_fetch_failed']
    assert sale['postal_code'] == '06110'
    assert len(errors) == 1


def test_parse_avoventes_detail_html_extracts_lot_superficie() -> None:
    html = """
    <html>
      <body>
        <h1>Appartement Lot 5, 2 pièces</h1>
        <section>
          <h2>À propos du bien</h2>
          <p>Cadastré section AC n°164 pour 07a 02ca</p>
          <p>Superficie Lots 5 et 8 : 48,80 m² - DPE : non réalisable</p>
        </section>
      </body>
    </html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/test")

    assert details["title"] == "Appartement Lot 5, 2 pièces"
    assert details["surface_m2"] == "48,80"
    assert details["source_blocks"]["titre_detail"] == "Appartement Lot 5, 2 pièces"
    assert details["source_blocks"]["surface"] == "48,80"
    assert "Superficie Lots 5 et 8" in details["source_blocks"]["page_text"]


def test_parse_avoventes_detail_html_extracts_source_images() -> None:
    html = """
    <html>
      <head>
        <meta property="og:image" content="/public/uploads/cabinet/114/images/cropped_photo.jpg">
        <meta name="twitter:image" content="/public/uploads/cabinet/114/images/cropped_photo.jpg">
      </head>
      <body>
        <ul id="lightSliderDetails">
          <li data-src="/public/uploads/cabinet/114/images/resized_photo.jpg"></li>
        </ul>
        <img src="/images/logo.svg">
      </body>
    </html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/test")

    assert details["raw_image_url"] == "https://avoventes.fr/public/uploads/cabinet/114/images/cropped_photo.jpg"
    assert details["source_images"] == [
        "https://avoventes.fr/public/uploads/cabinet/114/images/cropped_photo.jpg",
        "https://avoventes.fr/public/uploads/cabinet/114/images/resized_photo.jpg",
    ]


def test_detail_postponement_is_not_replaced_by_nearby_sale_date():
    from src.sources.avoventes import parse_avoventes_detail_html
    detail = parse_avoventes_detail_html('''<h1>Maison à Marsannay-la-Côte</h1>
        <div>Adjudication : VENTE REPORTÉE</div><div>Vente reportée</div>
        <h2>À propos du bien</h2><p>Maison 127,31 m²</p>
        <h2>Autres biens à proximité</h2><div>Appartement, vente le 16 septembre 2026</div>''',
        'https://avoventes.fr/enchere/une-maison-dhabitation-a-marsannay-la-cote')
    assert detail['status'] == 'postponed'
    assert detail.get('sale_date') is None
