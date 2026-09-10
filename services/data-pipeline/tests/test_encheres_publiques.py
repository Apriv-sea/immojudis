import json
from decimal import Decimal

from src.asset_normalization import normalize_asset_features
from src.normalize import normalize_sale
from src.sale_procedure import classify_sale_procedure
from src.sources.common import is_allowed_origin_url
from src.sources.encheres_publiques import (
    BASE_URL,
    CANONICAL_BASE_URL,
    _enrich_sale_from_detail,
    _source_sale_schedule,
    parse_encheres_publiques_detail_html,
    parse_encheres_publiques_html,
)


def test_sale_schedule_keeps_matching_boundaries_without_mixing_lot_and_event() -> None:
    event = {"ouverture_date": 1789556400, "fermeture_date": 1789642800}
    assert _source_sale_schedule({}, event) is not None
    assert _source_sale_schedule({"ouverture_date": 1789556400}, event) is None
    assert _source_sale_schedule({"fermeture_date": 1789642800}, event) is None
    assert _source_sale_schedule({"ouverture_date": 1789642800, "fermeture_date": 1789556400}, {}) is None
    assert _source_sale_schedule({"ouverture_date": 10**100, "fermeture_date": 10**101}, {}) is None


def test_detail_window_survives_normalization_and_procedure_classification() -> None:
    state = {
        "Lot:123": {
            "id": "123", "categorie": "immobilier", "nom": "Maison à Bordeaux",
            "description": "Vente notariale en ligne", "mise_a_prix": 100000,
            "ouverture_date": 1789556400, "fermeture_date": 1789642800,
        },
    }
    payload = {"props": {"pageProps": {"apolloState": {"data": state}}}}
    html = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(payload) + '</script>'
    raw = parse_encheres_publiques_detail_html(html, f"{BASE_URL}/encheres/maison_123")
    sale = classify_sale_procedure(normalize_sale(raw))
    assert sale.sale_procedure["sale_window"]["opens_at"] == raw["sale_date"]
    assert sale.sale_procedure["sale_window"]["closes_at"] == raw["source_sale_schedule"]["closes_at"]


def test_encheres_publiques_accepts_only_its_www_and_canonical_origins() -> None:
    allowed_origins = (BASE_URL, CANONICAL_BASE_URL)

    assert is_allowed_origin_url(
        "https://www.encheres-publiques.com/encheres/immobilier/lot_1",
        allowed_origins,
    )
    assert is_allowed_origin_url(
        "https://encheres-publiques.com/encheres/immobilier/lot_1",
        allowed_origins,
    )
    assert not is_allowed_origin_url(
        "https://encheres-publiques.com.evil.example/encheres/immobilier/lot_1",
        allowed_origins,
    )


def test_parse_encheres_publiques_html_reads_next_apollo_state() -> None:
    html = """
    <html>
      <body>
        <a href="/encheres/immobilier/appartements/carcans-33/appartement-carcans_128128">Voir</a>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "apolloState": {
                "data": {
                  "Adresse:201447": {"__typename": "Adresse", "id": "201447", "ville": "Carcans", "ville_slug": "carcans-33"},
                  "Profil:5388": {"__typename": "Profil", "id": "5388", "nom": "Tribunal Judiciaire de BORDEAUX", "categorie": "tribunal"},
                  "Evenement:21820": {"__typename": "Evenement", "id": "21820", "titre": "Vente immobilière au Tribunal judiciaire de Bordeaux le 9 Juin 2026", "ouverture_date": 1781005200},
                  "Lot:128128": {
                    "__typename": "Lot",
                    "id": "128128",
                    "nom": "Un appartement de 23,56 m² située ZAC de Maubuisson à Carcans",
                    "type": "En salle",
                    "categorie": "immobilier",
                    "sous_categorie": "appartements",
                    "adresse_defaut": {"__ref": "Adresse:201447"},
                    "ouverture_date": 1779973200,
                    "criteres_resume": "Carcans · 23.56 m²",
                    "mise_a_prix": 20000,
                    "prix_adjuge": 40000,
                    "organisateur": {"__ref": "Profil:5388"},
                    "evenement": {"__ref": "Evenement:21820"},
                    "termine": false
                  }
                }
              }
            }
          }
        }
        </script>
      </body>
    </html>
    """

    raw_sales = parse_encheres_publiques_html(
        html,
        "https://www.encheres-publiques.com/ventes/immobilier/v/bordeaux-33",
    )
    sale = normalize_sale(raw_sales[0])

    assert len(raw_sales) == 1
    assert sale.source_name == "encheres_publiques"
    assert sale.source_url == (
        "https://www.encheres-publiques.com/"
        "encheres/immobilier/appartements/carcans-33/appartement-carcans_128128"
    )
    assert sale.external_id == "128128"
    assert sale.department == "33"
    assert sale.city == "Carcans"
    assert sale.postal_code is None
    assert sale.property_type == "apartment"
    assert sale.surface_m2 == Decimal("23.56")
    assert sale.starting_price_eur == 20000
    assert sale.tribunal == "Tribunal Judiciaire de BORDEAUX"
    assert raw_sales[0]["status"] == "adjudicated"
    assert sale.status == "adjudicated"
    assert sale.adjudication_price_eur == Decimal("40000")
    assert raw_sales[0]["source_blocks"]["surface"] == "23.56"
    assert raw_sales[0]["source_blocks"]["mise_a_prix"] == "20000"
    assert raw_sales[0]["source_blocks"]["tribunal"] == "Tribunal Judiciaire de BORDEAUX"


def test_parse_encheres_publiques_html_keeps_national_listing() -> None:
    html = """
    <html>
      <body>
        <a href="/encheres/immobilier/appartements/paris-75/appartement-paris_129387">Voir</a>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "apolloState": {
                "data": {
                  "Adresse:201979": {"__typename": "Adresse", "id": "201979", "ville": "Paris", "ville_slug": "paris-75"},
                  "Profil:5311": {"__typename": "Profil", "id": "5311", "nom": "Tribunal Judiciaire de PARIS", "categorie": "tribunal"},
                  "Evenement:21877": {"__typename": "Evenement", "id": "21877", "ouverture_date": 1783495800},
                  "Lot:129387": {
                    "__typename": "Lot",
                    "id": "129387",
                    "nom": "Un appartement de 52,8 m² situé rue des Fossés Saint-Jacques à Paris",
                    "type": "En salle",
                    "categorie": "immobilier",
                    "sous_categorie": "appartements",
                    "adresse_defaut": {"__ref": "Adresse:201979"},
                    "ouverture_date": 1783495800,
                    "criteres_resume": "Paris · 52.8 m²",
                    "mise_a_prix": 170000,
                    "organisateur": {"__ref": "Profil:5311"},
                    "evenement": {"__ref": "Evenement:21877"},
                    "termine": false
                  }
                }
              }
            }
          }
        }
        </script>
      </body>
    </html>
    """

    raw_sales = parse_encheres_publiques_html(html, "https://www.encheres-publiques.com/ventes/immobilier")

    assert len(raw_sales) == 1
    assert raw_sales[0]["department"] == "75"


def test_parse_encheres_publiques_html_keeps_finished_adjudicated_lot() -> None:
    html = """
    <html>
      <body>
        <a href="/encheres/immobilier/maisons/bordeaux-33/maison-bordeaux_129555">Voir</a>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "apolloState": {
                "data": {
                  "Adresse:1": {"__typename": "Adresse", "id": "1", "ville": "Bordeaux", "ville_slug": "bordeaux-33"},
                  "Profil:1": {"__typename": "Profil", "id": "1", "nom": "Tribunal Judiciaire de BORDEAUX", "categorie": "tribunal"},
                  "Evenement:1": {"__typename": "Evenement", "id": "1", "ouverture_date": 1781005200},
                  "Lot:129555": {
                    "__typename": "Lot",
                    "id": "129555",
                    "nom": "Maison de 84 m² à Bordeaux",
                    "categorie": "immobilier",
                    "sous_categorie": "maisons",
                    "adresse_defaut": {"__ref": "Adresse:1"},
                    "evenement": {"__ref": "Evenement:1"},
                    "criteres_resume": "Bordeaux · 84 m²",
                    "mise_a_prix": 120000,
                    "prix_adjuge": 156000,
                    "organisateur": {"__ref": "Profil:1"},
                    "termine": true
                  }
                }
              }
            }
          }
        }
        </script>
      </body>
    </html>
    """

    raw_sales = parse_encheres_publiques_html(html, "https://www.encheres-publiques.com/ventes/immobilier")
    sale = normalize_sale(raw_sales[0])

    assert len(raw_sales) == 1
    assert raw_sales[0]["adjudication_price_eur"] == 156000
    assert raw_sales[0]["status"] == "adjudicated"
    assert sale.status == "adjudicated"
    assert sale.adjudication_price_eur == Decimal("156000")


def test_parse_encheres_publiques_html_keeps_thousands_surface_fallback() -> None:
    html = """
    <html>
      <body>
        <a href="/encheres/immobilier/maisons/bordeaux-33/propriete_129999">Voir</a>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "apolloState": {
                "data": {
                  "Adresse:1": {"__typename": "Adresse", "id": "1", "ville": "Bordeaux", "ville_slug": "bordeaux-33"},
                  "Evenement:1": {"__typename": "Evenement", "id": "1", "ouverture_date": 1781005200},
                  "Lot:129999": {
                    "__typename": "Lot",
                    "id": "129999",
                    "nom": "Propriété 2 464,70 m²",
                    "categorie": "immobilier",
                    "sous_categorie": "maisons",
                    "adresse_defaut": {"__ref": "Adresse:1"},
                    "evenement": {"__ref": "Evenement:1"},
                    "criteres_resume": "Bordeaux · 2 464,70 m²",
                    "mise_a_prix": 100000,
                    "termine": false
                  }
                }
              }
            }
          }
        }
        </script>
      </body>
    </html>
    """

    raw_sales = parse_encheres_publiques_html(html, "https://www.encheres-publiques.com/ventes/immobilier")
    sale = normalize_sale(raw_sales[0])

    assert raw_sales[0]["surface_m2"] == "2464.70"
    assert raw_sales[0]["source_blocks"]["surface"] == "2464.70"
    assert sale.surface_m2 == Decimal("2464.70")


def test_parse_encheres_publiques_detail_html_extracts_rich_lot_context() -> None:
    html = """
    <html>
      <body>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "apolloState": {
                "data": {
                  "Adresse:201952": {
                    "__typename": "Adresse",
                    "id": "201952",
                    "text": "7 Rue du Palais Gallien, 33000 Bordeaux, France",
                    "ville": "Bordeaux",
                    "ville_slug": "bordeaux-33",
                    "coords": [-0.5812147, 44.8416492]
                  },
                  "Profil:5692": {
                    "__typename": "Profil",
                    "id": "5692",
                    "nom": "OFFICE NOTARIAL DU JEU DE PAUME",
                    "categorie": "notaire",
                    "telephone": "05 56 42 41 85"
                  },
                  "Evenement:22001": {
                    "__typename": "Evenement",
                    "id": "22001",
                    "titre": "Vente notariale interactive à Bordeaux",
                    "ouverture_date": 1781005200
                  },
                  "LotVisite:51437": {
                    "__typename": "LotVisite",
                    "id": "51437",
                    "ouverture_date": 1779786000,
                    "fermeture_date": 1779791400,
                    "observations": "sur rendez-vous"
                  },
                  "PhotoLot:1": {
                    "__typename": "PhotoLot",
                    "id": "1",
                    "url": "/static/lot/photo/bordeaux.jpg"
                  },
                  "Lot:129346": {
                    "__typename": "Lot",
                    "id": "129346",
                    "nom": "Appartement T4 en duplex à rénover 103,19 m² carrez avec terrasse privative",
                    "type": "En ligne",
                    "type_de_vente": "Vente volontaire",
                    "categorie": "immobilier",
                    "sous_categorie": "appartements",
                    "adresse_physique": {"__ref": "Adresse:201952"},
                    "organisateur": {"__ref": "Profil:5692"},
                    "evenement": {"__ref": "Evenement:22001"},
                    "visites": [{"__ref": "LotVisite:51437"}],
                    "photos": [{"__ref": "PhotoLot:1"}],
                    "criteres_resume": "Bordeaux · 103.16 m² · 4 pièces · 3296 €/m²",
                    "critere_surface_habitable": 103.16,
                    "critere_nombre_de_pieces": 4,
                    "critere_nombre_de_chambres": 3,
                    "critere_diagnostic_date": "2026-04-27",
                    "critere_consommation_energetique": "C",
                    "critere_emissions_de_gaz": "C",
                    "critere_occupation_du_bien": "Libre de toute occupation",
                    "description": "Appartement de type T4 en duplex à rénover comprenant séjour, cuisine, trois chambres, terrasse privative et place de parking. PREVOIR TRAVAUX DE RENOVATION",
                    "infos_conditions_de_vente": "Vente notariale interactive (VNI)",
                    "infos_frais_de_vente": "Barème des frais de négociation à la charge de l'acquéreur.",
                    "infos_modalite_de_paiement": "Comptant le jour de l'acte authentique.",
                    "infos_renseignements_de_vente": "Texte générique : vérifier les autorisations d’urbanisme avant travaux.",
                    "mise_a_prix": 340000,
                    "termine": false
                  }
                }
              }
            }
          }
        }
        </script>
      </body>
    </html>
    """

    raw_sale = parse_encheres_publiques_detail_html(
        html,
        "https://www.encheres-publiques.com/encheres/immobilier/appartements/bordeaux-33/appartement-duplex-renover-carrez-avec-terrasse-privative_129346",
    )
    sale = normalize_sale(raw_sale)

    assert sale.description is not None
    assert "PREVOIR TRAVAUX DE RENOVATION" in sale.description
    assert sale.address == "7 Rue du Palais Gallien, 33000 Bordeaux, France"
    assert sale.postal_code == "33000"
    assert sale.city == "Bordeaux"
    assert sale.department == "33"
    assert sale.latitude == Decimal("44.8416492")
    assert sale.longitude == Decimal("-0.5812147")
    assert sale.surface_m2 == Decimal("103.16")
    assert sale.carrez_surface_m2 == Decimal("103.16")
    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 3
    assert sale.parking_count == 1
    assert sale.has_terrace is True
    assert sale.lawyer_name == "OFFICE NOTARIAL DU JEU DE PAUME"
    assert sale.lawyer_contact == "05 56 42 41 85"
    assert sale.occupancy_status == "vacant"
    diagnostics = sale.raw_payload["source_energy_diagnostics"]
    assert diagnostics["dpe_class"] == "C"
    assert diagnostics["ges_class"] == "C"
    assert diagnostics["diagnostic_date"] == "2026-04-27"
    assert sale.visit_dates
    assert "Vente notariale interactive" in (sale.raw_text or "")
    assert "Comptant le jour de l'acte authentique" in (sale.raw_text or "")
    assert "Libre de toute occupation" in (sale.raw_text or "")
    assert "autorisation" not in (sale.raw_text or "")
    assert raw_sale["source_blocks"]["renseignements_de_vente"].startswith("Texte générique")
    assert raw_sale["source_blocks"]["organisateur"] == "OFFICE NOTARIAL DU JEU DE PAUME"
    assert raw_sale["source_blocks"]["organisateur_categorie"] == "notaire"
    assert raw_sale["source_images"] == ["https://www.encheres-publiques.com/static/lot/photo/bordeaux.jpg"]


def test_encheres_publiques_resolves_malformed_structured_surface_from_matching_text() -> None:
    html = """
    <html>
      <body>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "apolloState": {
                "data": {
                  "Adresse:1": {
                    "text": "41 Rue Gâte Bourse, 85350 L'Île-d'Yeu, France",
                    "ville": "L'Île-d'Yeu",
                    "ville_slug": "l-ile-d-yeu-85"
                  },
                  "Lot:130432": {
                    "id": "130432",
                    "nom": "Un ensemble immobilier de 187 m² situé rue Gâte-Bourse à L'Île-d'Yeu",
                    "categorie": "immobilier",
                    "sous_categorie": "maisons",
                    "adresse_physique": {"__ref": "Adresse:1"},
                    "criteres_resume": "L'Île-d'Yeu · 1877 m² · 10 pièces · 266 €/m²",
                    "critere_surface_habitable": 1877,
                    "critere_nombre_de_pieces": 10,
                    "description": "Un ensemble immobilier de 10 pièces de 187 m², avec un garage de 18 m², le tout édifié sur une parcelle de 1 110 m².",
                    "mise_a_prix": 500000,
                    "termine": false
                  }
                }
              }
            }
          }
        }
        </script>
      </body>
    </html>
    """

    raw_sale = parse_encheres_publiques_detail_html(
        html,
        "https://www.encheres-publiques.com/encheres/immobilier/maisons/l-ile-d-yeu-85/ensemble-immobilier_130432",
    )
    sale = normalize_asset_features(normalize_sale(raw_sale))

    assert raw_sale["surface_m2"] == "187"
    assert raw_sale["habitable_surface_m2"] == "187"
    assert sale.surface_m2 == Decimal("187")
    assert sale.habitable_surface_m2 == Decimal("187")
    assert sale.land_surface_m2 == Decimal("1110")
    assert sale.app_surface_m2 == Decimal("187")
    assert sale.app_surface_kind == "habitable"
    assert sale.surface_scope == "total"
    assert sale.title == "Maison 187 m²"


def test_enrich_encheres_publiques_detail_merges_source_blocks() -> None:
    html = """
    <html>
      <body>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "apolloState": {
                "data": {
                  "Adresse:1": {
                    "__typename": "Adresse",
                    "id": "1",
                    "text": "7 Rue du Palais Gallien, 33000 Bordeaux, France",
                    "ville": "Bordeaux",
                    "ville_slug": "bordeaux-33",
                    "coords": [-0.5812147, 44.8416492]
                  },
                  "Profil:1": {
                    "__typename": "Profil",
                    "id": "1",
                    "nom": "OFFICE NOTARIAL DU JEU DE PAUME",
                    "categorie": "notaire",
                    "telephone": "05 56 42 41 85"
                  },
                  "Evenement:1": {
                    "__typename": "Evenement",
                    "id": "1",
                    "titre": "Vente notariale interactive à Bordeaux",
                    "ouverture_date": 1781005200
                  },
                  "Lot:129346": {
                    "__typename": "Lot",
                    "id": "129346",
                    "nom": "Appartement T4 103,16 m² avec terrasse",
                    "categorie": "immobilier",
                    "sous_categorie": "appartements",
                    "adresse_physique": {"__ref": "Adresse:1"},
                    "organisateur": {"__ref": "Profil:1"},
                    "evenement": {"__ref": "Evenement:1"},
                    "criteres_resume": "Bordeaux · 103.16 m² · 4 pièces",
                    "critere_surface_habitable": 103.16,
                    "critere_diagnostic_date": "2026-04-27",
                    "critere_consommation_energetique": "C",
                    "critere_emissions_de_gaz": "C",
                    "critere_occupation_du_bien": "Libre de toute occupation",
                    "description": "Appartement avec terrasse.",
                    "infos_conditions_de_vente": "Vente notariale interactive (VNI)",
                    "infos_renseignements_de_vente": "Renseignements publics spécifiques.",
                    "mise_a_prix": 340000,
                    "termine": false
                  }
                }
              }
            }
          }
        }
        </script>
      </body>
    </html>
    """
    sale = {
        "source_name": "encheres_publiques",
        "source_url": (
            "https://www.encheres-publiques.com/encheres/immobilier/appartements/"
            "bordeaux-33/appartement_129346"
        ),
        "source_blocks": {
            "titre": "Appartement T4 103,16 m² avec terrasse",
            "surface": "103.16",
        },
        "raw_text": "Appartement T4 103,16 m² avec terrasse",
    }

    class Client:
        def get(self, url: str) -> str:
            assert url == sale["source_url"]
            return html

    errors: list[str] = []
    _enrich_sale_from_detail(Client(), sale, errors)

    assert errors == []
    assert sale["source_blocks"]["surface"] == "103.16"
    assert sale["source_blocks"]["conditions_de_vente"] == "Vente notariale interactive (VNI)"
    assert sale["source_blocks"]["diagnostic_date"] == "2026-04-27"
    assert sale["source_blocks"]["occupation"] == "Libre de toute occupation"
    assert sale["source_blocks"]["renseignements_de_vente"] == "Renseignements publics spécifiques."
