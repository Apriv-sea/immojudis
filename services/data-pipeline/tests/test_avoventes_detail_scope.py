from src.sources.avoventes import parse_avoventes_detail_html

# Reduced from the preserved Gaillard detail response
# (/private/tmp/immojudis-critical-pages-20260913/gaillard-live.html,
# SHA-256 ebf0111c6b41b197476a6c789dc3b3c7309a6c64bb24548c0c4bc15f0354a406).
# The two nearby cards retain the exact values that previously leaked into
# the detail text, while unrelated page chrome is intentionally omitted.
GAILLARD_DETAIL_FIXTURE = """
<html>
  <body>
    <section id="gaillard-detail">
      <h1>APPARTEMENT + CAVE à GAILLARD</h1>
      <div class="sale-summary">
        <span>Vente aux enchères</span>
        <p>Mise à prix : 150 000,00 €</p>
        <p>Vente 16 octobre 2026 à 15h00</p>
      </div>

      <h2>À propos du bien</h2>
      <div class="property-description">
        DESIGNATION Sur la commune de GAILLARD (74240), 97 Rue de Genève,
        dans l'ensemble immobilier « Le Castelet », cadastré section A n° 4104,
        bâtiment C :
        <br />
        LOT N°242 : un appartement de type 4 au 1er étage.
        <br />
        LOT N°654 : dans le bâtiment C, au sous-sol, une cave portant le numéro 5.
        <br />
        Le tout d'une superficie privative de 91,76 m² de surface Loi Carrez
        totale, 109,10 m² de surface au sol totale.
      </div>

      <h2>À proximité</h2>
      <div id="cadastre">Carte cadastrale du bien cible</div>

      <hr />
      <h4>Autres biens à proximité</h4>
      <div class="card annonce" data-link="https://avoventes.fr/enchere/un-appartement-a-gaillard-74">
        <span>Vente aux enchères</span>
        <span>UN APPARTEMENT à GAILLARD (74)</span>
        <span>102 Rue de Genève, 74240 Gaillard, France</span>
        <span>Mise à prix : 35 000,00 €</span>
        <span>Date de la vente : vendredi 16 octobre 2026 à 15h00</span>
      </div>
      <div class="card annonce" data-link="https://avoventes.fr/enchere/un-appartement-a-gaillard-74-1">
        <span>Vente aux enchères</span>
        <span>UN APPARTEMENT à GAILLARD (74)</span>
        <span>102 Rue de Genève, 74240 Gaillard, France</span>
        <span>Mise à prix : 37 000,00 €</span>
        <span>Date de la vente : vendredi 16 octobre 2026 à 15h00</span>
      </div>
    </section>
  </body>
</html>
"""


def test_detail_scope_does_not_mix_nearby_cards_into_main_listing() -> None:
    details = parse_avoventes_detail_html(
        GAILLARD_DETAIL_FIXTURE,
        "https://avoventes.fr/enchere/appartement-cave-a-gaillard",
    )

    assert details["postal_code"] == "74240"
    assert details["description"] is not None
    assert "97 Rue de Genève" in details["description"]
    assert "91,76 m²" in details["description"]
    assert "109,10 m²" in details["description"]
    assert details["surface_m2"] is None

    page_text = details["source_blocks"]["page_text"]
    assert "150 000,00 €" in page_text
    assert "102 Rue de Genève" not in page_text
    assert "35 000,00 €" not in page_text
    assert "37 000,00 €" not in page_text
    assert details["adjudication_price_eur"] is None
    assert details["status"] is None
