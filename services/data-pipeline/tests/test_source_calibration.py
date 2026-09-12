from decimal import Decimal

from src.normalize import normalize_sale


def test_normalize_sale_calibrates_info_encheres_source_blocks() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-test-33-ref-123.html",
            "source_blocks": {
                "detail_nature_du_bien": "Appartement",
                "detail_adresse": "12 rue du Test 33000 Bordeaux",
                "detail_mise_a_prix": "150 000 euros",
                "detail_vente_le": "Jeudi 10 septembre 2026 à 14h00",
                "detail_date_de_visite": "5 septembre 2026 de 10h00 a 11h00",
                "detail_au_tribunal_judiciaire_de": "Tribunal judiciaire de Bordeaux",
                "description": (
                    "Appartement de type T3 de 68,5 m² carrez comprenant sejour, "
                    "deux chambres, une salle d'eau et une place de parking. "
                    "Libre de toute occupation."
                ),
                "avocat": "Maitre Test",
                "contact_avocat": "05 00 00 00 00",
            },
        }
    )

    assert sale.address == "12 rue du Test 33000 Bordeaux"
    assert sale.postal_code == "33000"
    assert sale.city == "Bordeaux"
    assert sale.department == "33"
    assert sale.property_type == "apartment"
    assert sale.starting_price_eur == Decimal("150000")
    assert sale.sale_date is not None
    assert sale.visit_dates == ["5 septembre 2026 de 10h00 a 11h00"]
    assert sale.tribunal == "Tribunal judiciaire de Bordeaux"
    assert sale.lawyer_name == "Maitre Test"
    assert sale.lawyer_contact == "05 00 00 00 00"
    assert sale.surface_m2 == Decimal("68.5")
    assert sale.carrez_surface_m2 == Decimal("68.5")
    assert sale.rooms_count == 3
    assert sale.bedrooms_count == 2
    assert sale.bathrooms_count == 1
    assert sale.parking_count == 1
    assert sale.occupancy_status == "vacant"


def test_normalize_sale_ignores_info_encheres_navigation_studio_for_rooms_count() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/108236-d-vente-encheres-immobilieres-villa-gleize-69-ref-6006.html",
            "title": "Villa à Gleize (69)",
            "property_type": "Villa",
            "city": "Gleize",
            "department": "69",
            "address": "69400 Gleize",
            "surface_m2": "118,10 m2",
            "starting_price_eur": "75 000 euros",
            "sale_date": "09/07/2026",
            "raw_text": "Villa à Gleize (69)",
            "source_blocks": {
                "page_text": "Tous les biens\nVilla\nMaison\nAppartement\nStudio\nTerrain\nEnsemble Immobilier",
            },
        }
    )

    assert sale.property_type == "house"
    assert sale.rooms_count is None


def test_normalize_sale_does_not_use_petites_affiches_tribunal_postal_as_asset_postal_code() -> None:
    sale = normalize_sale(
        {
            "source_name": "petites_affiches",
            "source_url": "https://www.petitesaffiches.fr/encheres-immobilieres/vente/propriete-beaulieu.html",
            "title": "UNE PROPRIÉTÉ à Beaulieu-sur-Mer",
            "property_type": "Propriété agricole",
            "city": "Beaulieu-sur-Mer",
            "address": "Beaulieu-sur-Mer",
            "starting_price_eur": "9 500 000 euros",
            "sale_date": "09/07/2026",
            "raw_text": "UNE PROPRIÉTÉ à Beaulieu-sur-Mer",
            "source_blocks": {
                "adresse": "Beaulieu-sur-Mer",
                "page_text": "Lieu de Vente\nTJ DE NICE\nPlace du Palais de Justice, 06357 NICE CEDEX",
            },
        }
    )

    assert sale.property_type == "mixed"
    assert sale.postal_code is None


def test_normalize_sale_extracts_petites_affiches_accented_rooms_count() -> None:
    sale = normalize_sale(
        {
            "source_name": "petites_affiches",
            "source_url": "https://www.petitesaffiches.fr/encheres-immobilieres/vente/appartement-honfleur.html",
            "title": "UN APPARTEMENT DE DEUX PIÉCES AVEC JARDIN à Honfleur",
            "property_type": "Appartement",
            "city": "Honfleur",
            "address": "Honfleur",
            "starting_price_eur": "30 000 euros",
            "sale_date": "09/07/2026",
            "raw_text": "UN APPARTEMENT DE DEUX PIÉCES AVEC JARDIN à Honfleur",
            "source_blocks": {"titre": "UN APPARTEMENT DE DEUX PIÉCES AVEC JARDIN à Honfleur"},
        }
    )

    assert sale.property_type == "apartment"
    assert sale.rooms_count == 2
    assert sale.has_garden is True


def test_normalize_sale_calibrates_nested_detail_blocks() -> None:
    sale = normalize_sale(
        {
            "source_name": "petites_affiches",
            "source_url": "https://www.petitesaffiches.fr/vente.html",
            "source_blocks": {
                "detail": {
                    "nature_du_bien": "Maison",
                    "adresse": "8 avenue Test 64000 Pau",
                    "mise_a_prix": "90 000 euros",
                    "vente_le": "Mercredi 16 septembre 2026 à 09h30",
                },
                "visites": "Visite sur place le 9 septembre 2026 de 14h a 15h",
                "description": "Maison de 92 m² habitables avec jardin et garage.",
            },
        }
    )

    assert sale.property_type == "house"
    assert sale.address == "8 avenue Test 64000 Pau"
    assert sale.postal_code == "64000"
    assert sale.city == "Pau"
    assert sale.department == "64"
    assert sale.starting_price_eur == Decimal("90000")
    assert sale.sale_date is not None
    assert sale.visit_dates == ["Visite sur place le 9 septembre 2026 de 14h a 15h"]
    assert sale.surface_m2 == Decimal("92")
    assert sale.habitable_surface_m2 == Decimal("92")
    assert sale.has_garden is True
    assert sale.has_garage is True


def test_normalize_sale_calibrates_avoventes_lot_superficie_from_raw_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/appartement-vic-sur-aisne",
            "title": "Appartement Lot 5, 2 pièces Lot 8, 2 cours Lots 18 et 19, emplacement de stationnement",
            "property_type": "Appartement",
            "address": "15 Rue de Saint-Christophe, 02290 Vic-sur-Aisne, France",
            "starting_price_eur": "20 000,00 €",
            "sale_date": "mardi 23 juin 2026 à 10h00",
            "raw_text": (
                "D'UN APPARTEMENT (lot 5) deux pièces (Lot 8) deux cours "
                "(Lots 18 et 19) emplacement de stationnement (Lot 16) "
                "Dans un ensemble immobilier sis Commune de VIC-SUR-AISNE "
                "(02290 - Aisne) 15 rue Saint-Christophe Cadastré section AC n°164 "
                "lieudit La porte Saint-Christophe pour 07a 02ca "
                "Superficie Lots 5 et 8 : 48,80 m² - DPE : non réalisable. "
                "Le lot numéro cinq (5) : un appartement se composant d'une cuisine, "
                "salle de bains, 2 chambres."
            ),
        }
    )

    assert sale.property_type == "apartment"
    assert sale.postal_code == "02290"
    assert sale.city == "Vic-sur-Aisne"
    assert sale.department == "02"
    assert sale.surface_m2 == Decimal("48.80")
    assert sale.surface_source == "source_text"
    assert "Superficie Lots 5 et 8" in (sale.surface_evidence or "")
    assert sale.rooms_count == 2
    assert sale.bedrooms_count == 2
    assert sale.bathrooms_count == 1
    assert sale.parking_count == 1


def test_normalize_sale_calibrates_avoventes_agricultural_mixed_asset() -> None:
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
                "Surface totale : 2.464,70 m². "
                "Le bâtiment agricole est libre de toute occupation. Données des valeurs foncières "
                "Maison 83 m2 5 pièces 130 000 euros."
            ),
            "source_blocks": {
                "type_bien": "Autres",
                "page_text": (
                    "À propos du bien Un bâtiment d'exploitation agricole avec terrain attenant. "
                    "Surface totale : 2.464,70 m². Données des valeurs foncières Maison 83 m2 5 pièces."
                ),
            },
        }
    )

    assert sale.title.startswith("UN BATIMENT D'EXPLOITATION AGRICOLE")
    assert sale.property_type == "mixed"
    assert sale.surface_m2 == Decimal("2464.70")
    assert sale.rooms_count is None
    assert sale.occupancy_status == "vacant"


def test_normalize_sale_calibrates_avoventes_house_surface_before_land_context() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/maison-15",
            "title": "Villa",
            "property_type": "Villa",
            "address": "5B Chem. de Thenières, 74140 Massongy, France",
            "starting_price_eur": "750 000,00 €",
            "sale_date": "vendredi 28 août 2026 à 15h00",
            "raw_text": (
                "MASSONGY (74140), 5 B chemin de Thénières, cadastrés section D 1828, 1841, "
                "1845, 1859 et 1864 pour une contenance totale de 7a 73ca, soit une maison "
                "de 244,47 m² garage compris (+ 11,37 m²) sur son terrain, formant le lot 2 "
                "du lotissement Les Gredalles. Biens occupés par la propriétaire."
            ),
        }
    )

    assert sale.property_type == "house"
    assert sale.surface_m2 == Decimal("244.47")
    assert sale.habitable_surface_m2 is None
    assert sale.land_surface_m2 == Decimal("773")
    assert sale.app_surface_m2 == Decimal("244.47")
    assert sale.app_surface_kind == "built"
    assert sale.occupancy_status == "occupied"


def test_normalize_sale_keeps_cadastral_surface_as_land_not_built_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://www.immobilier.notaires.fr/fr/annonce-immo/test",
            "source_blocks": {
                "description": (
                    "Maison a rehabiliter. Cadastree section CT n 363 pour un total de 44 m². "
                    "Le bien est libre de toute occupation."
                )
            },
        }
    )

    assert sale.property_type == "house"
    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 is None
    assert sale.land_surface_m2 == Decimal("44")
    assert sale.occupancy_status == "vacant"


def test_normalize_sale_keeps_mixed_notaires_land_surface_when_no_built_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://www.immo-interactif.fr/encheres-en-ligne/local-divers/st-martory-31/2017677",
            "title": "Type de Bien : Grange / Hangar avec le terrain attenant.",
            "property_type": "GRANGE",
            "city": "Saint-Martory",
            "postal_code": "31360",
            "starting_price_eur": "45 000,00 €",
            "sale_date": "2026-08-28T10:00:00Z",
            "raw_text": (
                "VENTE NOTARIALE INTERACTIVE - Grange / Hangar avec terrain de 1850 m² "
                "en zone urbaine - Fort potentiel. Le vendeur est disposé à procéder "
                "à la démolition et au retrait du hangar si l'acquéreur souhaite acheter "
                "uniquement le terrain."
            ),
        }
    )

    assert sale.property_type == "mixed"
    assert sale.surface_m2 is None
    assert sale.land_surface_m2 == Decimal("1850")
    assert sale.app_surface_m2 == Decimal("1850")
    assert sale.app_surface_kind == "land"
    assert sale.surface_scope == "land"


def test_normalize_sale_calibrates_encheres_publiques_blocks() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://www.encheres-publiques.com/encheres/immobilier/test_129346",
            "source_blocks": {
                "resume": "Bordeaux - 103.16 m² - 4 pieces",
                "description": (
                    "Appartement T4 de 103.16 m² comprenant sejour, cuisine, "
                    "trois chambres, terrasse privative et 2 places de parking."
                ),
                "occupation": "Libre de toute occupation",
            },
        }
    )

    assert sale.property_type == "apartment"
    assert sale.surface_m2 == Decimal("103.16")
    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 3
    assert sale.parking_count == 2
    assert sale.has_terrace is True
    assert sale.occupancy_status == "vacant"


def test_normalize_sale_calibrates_agrasc_blocks() -> None:
    sale = normalize_sale(
        {
            "source_name": "agrasc",
            "source_url": "https://agrasc.gouv.fr/ventes-aux-encheres/maison-agen",
            "source_blocks": {
                "titre": "Maison",
                "description": "Maison avec jardin de 89 m², libre de toute occupation.",
                "ville": "Agen",
                "departement": "47",
                "surface": "89",
                "mise_a_prix": "91 466 euros",
                "date_vente": "16 juin 2026 à 10h00",
            },
        }
    )

    assert sale.property_type == "house"
    assert sale.city == "Agen"
    assert sale.department == "47"
    assert sale.surface_m2 == Decimal("89")
    assert sale.starting_price_eur == Decimal("91466")
    assert sale.sale_date is not None
    assert sale.has_garden is True
    assert sale.occupancy_status == "vacant"


def test_normalize_sale_calibrates_cessions_etat_blocks() -> None:
    sale = normalize_sale(
        {
            "source_name": "cessions_etat",
            "source_url": "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-vendre-cancon",
            "source_blocks": {
                "titre": "Immeuble a Vendre a Cancon",
                "type_bien": "Bureaux / Commerces",
                "description": "Ancien logement domanial de 134 m² avec terrain.",
                "ville": "Cancon",
                "departement": "47",
                "code_postal": "47290",
                "surface": "134",
                "mise_a_prix": "210 000 euros",
                "date_vente": "24 septembre 2026 à 12h00",
                "visites": "sur rendez-vous auprès du service local",
            },
        }
    )

    assert sale.property_type == "commercial"
    assert sale.city == "Cancon"
    assert sale.department == "47"
    assert sale.postal_code == "47290"
    assert sale.surface_m2 == Decimal("134")
    assert sale.starting_price_eur == Decimal("210000")
    assert sale.sale_date is not None
    assert sale.visit_dates == ["sur rendez-vous auprès du service local"]


def test_normalize_sale_does_not_use_cessions_etat_standalone_insee_as_postal_code() -> None:
    sale = normalize_sale(
        {
            "source_name": "cessions_etat",
            "source_url": "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-de-bureaux-486-m2-bayeux",
            "title": "Immeuble De Bureaux - 486 M² - Bayeux",
            "property_type": "Bureaux / Commerces",
            "city": "Bayeux",
            "department": "14",
            "surface_m2": "486 m²",
            "raw_text": "Immeuble de bureaux de 486 m² à Bayeux.\n14047",
            "source_blocks": {
                "titre": "Immeuble De Bureaux - 486 M² - Bayeux",
                "ville": "Bayeux",
                "departement": "14",
                "page_text": "Bayeux\n14047",
            },
        }
    )

    assert sale.city == "Bayeux"
    assert sale.department == "14"
    assert sale.postal_code is None


def test_normalize_sale_calibrates_encheres_immobilieres_blocks() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_immobilieres",
            "source_url": "https://encheresimmobilieres.fr/ventes/9001-appartement-pau-64",
            "source_blocks": {
                "titre": "APPARTEMENT 2P de 51,66 m2 a PAU (64)",
                "description": "Appartement occupe avec une place de parking.",
                "adresse": "1 rue Test, 64000, PAU",
                "surface": "51,66",
                "nb_pieces": 2,
                "mise_a_prix": 60000,
                "date_vente": "2026-07-09T09:00:00.000Z",
                "visites": "Sur rendez-vous",
                "contact_avocat": "0559000000",
                "occupation": "occupé",
            },
        }
    )

    assert sale.property_type == "apartment"
    assert sale.address == "1 rue Test, 64000, PAU"
    assert sale.postal_code == "64000"
    assert sale.surface_m2 == Decimal("51.66")
    assert sale.rooms_count == 2
    assert sale.parking_count == 1
    assert sale.starting_price_eur == Decimal("60000")
    assert sale.sale_date is not None
    assert sale.visit_dates == ["Sur rendez-vous"]
    assert sale.lawyer_contact == "0559000000"
    assert sale.occupancy_status == "occupied"
