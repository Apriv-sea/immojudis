from decimal import Decimal

from src.normalize import (
    normalize_documents,
    normalize_occupancy_status,
    normalize_sale,
    normalize_source_urls,
    parse_confidence,
    parse_french_datetime,
    parse_price,
    parse_surface,
)


def test_parse_price_handles_french_money() -> None:
    assert parse_price("Mise à prix : 125 000,50 €") == Decimal("125000.50")
    assert parse_price("Mise à prix : 1.180.000 €") == Decimal("1180000")


def test_parse_price_preserves_already_normalized_numeric_values() -> None:
    assert parse_price(118000.0) == Decimal("118000.0")
    assert parse_price("118000.0") == Decimal("118000.0")


def test_parse_surface_preserves_decimal_point() -> None:
    assert parse_surface("91.78") == Decimal("91.78")
    assert parse_surface("91,78 m²") == Decimal("91.78")
    assert parse_surface("Surface terrain : 2.464 m²") == Decimal("2464")


def test_parse_confidence_normalizes_percent_and_ratio() -> None:
    assert parse_confidence("0.75") == Decimal("0.75")
    assert parse_confidence("75") == Decimal("0.75")


def test_normalize_documents_removes_navigation_marketplace_and_partner_links() -> None:
    documents = normalize_documents(
        [
            {"url": "https://itunes.apple.com/fr/app/licitor/id1024474985", "label": "document"},
            {"url": "https://play.google.com/store/apps/details?id=fr.tiddle.licitor", "label": "document"},
            {"url": "https://www.licitor.com/", "label": "document"},
            {
                "url": "https://app-pro.la-loupe.immo/ext-partenaire/licitor/token/",
                "label": "Voir le dossier complet avec La Loupe",
            },
            {"url": "https://www.licitor.com/download/document?id=109014", "label": "PV descriptif"},
            {"url": "https://www.licitor.com/download/document?id=109014", "label": "Doublon"},
        ],
        source_url="https://www.licitor.com/annonce/109014.html",
    )

    assert documents == [
        {"url": "https://www.licitor.com/download/document?id=109014", "label": "Doublon"}
    ]


def test_normalize_sale_uses_explicit_built_surface_for_building() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-immeuble.html",
            "property_type": "Un bâtiment à usage de bureaux",
            "surface_m2": "158,95 m²",
        }
    )

    assert sale.property_type == "building"
    assert sale.surface_m2 == Decimal("158.95")
    assert sale.app_surface_m2 == Decimal("158.95")
    assert sale.app_surface_kind == "built"
    assert sale.surface_scope == "total"


def test_parse_french_datetime_handles_month_and_hour() -> None:
    parsed = parse_french_datetime("Jeudi 12 décembre 2024 à 14h30")
    assert parsed is not None
    assert parsed.year == 2024
    assert parsed.month == 12
    assert parsed.day == 12
    assert parsed.hour == 13  # 14:30 Europe/Paris in winter
    assert parsed.minute == 30


def test_parse_french_datetime_keeps_day_before_french_month() -> None:
    parsed = parse_french_datetime("Vente immobilière le 11 Juin 2026")
    assert parsed is not None
    assert parsed.year == 2026
    assert parsed.month == 6
    assert parsed.day == 11


def test_parse_french_datetime_keeps_iso_year_month_day_order() -> None:
    parsed = parse_french_datetime("2026-07-09T09:00:00.000Z")
    assert parsed is not None
    assert parsed.year == 2026
    assert parsed.month == 7
    assert parsed.day == 9
    assert parsed.hour == 9


def test_parse_french_datetime_keeps_iso_date_embedded_in_text() -> None:
    parsed = parse_french_datetime("Ouverture de la vente : 2026-06-09T11:40:00+00:00")
    assert parsed is not None
    assert parsed.year == 2026
    assert parsed.month == 6
    assert parsed.day == 9


def test_normalize_sale_extracts_department_and_property_type() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/example",
            "title": "Vente aux enchères Maison",
            "address": "12 rue Test 33000 Bordeaux",
            "starting_price_eur": "80 000 €",
            "sale_date": "12 décembre 2026 à 10h00",
        }
    )
    assert sale.department == "33"
    assert sale.postal_code == "33000"
    assert sale.city == "Bordeaux"
    assert sale.property_type == "house"
    assert sale.status == "upcoming"


def test_normalize_sale_preserves_collected_app_ready_metadata() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://example.test/primary",
            "source_urls": ["https://example.test/secondary", "https://example.test/primary"],
            "tribunal_code": "bordeaux",
            "surface_scope": "total",
            "score_version": "score-v1",
            "score_confidence": "87",
            "score_factors": [{"factor_key": "surface"}],
        }
    )

    assert sale.source_urls == ["https://example.test/primary", "https://example.test/secondary"]
    assert sale.tribunal_code == "bordeaux"
    assert sale.surface_scope == "total"
    assert sale.score_version == "score-v1"
    assert sale.score_confidence == Decimal("0.87")
    assert sale.score_factors == [{"factor_key": "surface"}]


def test_normalize_sale_promotes_source_energy_diagnostics_from_source_blocks() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://example.test/dpe-source-blocks",
            "risk_notes": "Travaux à prévoir",
            "source_blocks": {
                "dpe": "G",
                "ges": "D",
                "diagnostic_date": "2026-04-27",
            },
        }
    )

    diagnostics = sale.raw_payload["source_energy_diagnostics"]
    assert diagnostics["source"] == "source_blocks"
    assert diagnostics["dpe_class"] == "G"
    assert diagnostics["ges_class"] == "D"
    assert diagnostics["diagnostic_date"] == "2026-04-27"
    assert diagnostics["evidence"] == "DPE G, GES D, diagnostic du 2026-04-27"
    assert sale.risk_notes == "Travaux à prévoir | DPE G"


def test_normalize_source_urls_handles_mapping_and_dedupes_primary_first() -> None:
    assert normalize_source_urls(
        {"licitor": "https://example.test/secondary", "main": "https://example.test/primary"},
        "https://example.test/primary",
    ) == ["https://example.test/primary", "https://example.test/secondary"]


def test_normalize_sale_extracts_overseas_department() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/guadeloupe",
            "address": "12 rue Test 97100 Basse-Terre",
        }
    )

    assert sale.department == "971"
    assert sale.postal_code == "97100"


def test_normalize_sale_preserves_canonical_property_type() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/canonical",
            "property_type": "house",
        }
    )

    assert sale.property_type == "house"


def test_normalize_sale_maps_notaires_short_property_code() -> None:
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://www.immobilier.notaires.fr/fr/annonce-immo/adjudication/maison/le-bouscat-33/1741074",
            "property_type": "MAI",
            "title": "Maison 5 pièces de 106 m²",
        }
    )

    assert sale.property_type == "house"


def test_normalize_sale_recovers_specific_type_from_title_when_raw_type_is_other() -> None:
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://example.test/notaires-other-title",
            "property_type": "Autre",
            "title": "Maison 5 pièces de 106 m² avec jardin",
        }
    )

    assert sale.property_type == "house"


def test_normalize_sale_corrects_legacy_price_with_raw_text_evidence() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/legacy-price",
            "starting_price_eur": 1180000.0,
            "raw_text": "Mise à prix : 118 000,00 €",
        }
    )

    assert sale.starting_price_eur == Decimal("118000.00")


def test_normalize_sale_extracts_prix_de_vente_from_raw_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "cessions_etat",
            "source_url": "https://cessions.immobilier-etat.gouv.fr/biens/prix-de-vente",
            "raw_text": "Ancienne brigade de gendarmerie. Prix de vente : 210 000 euros.",
        }
    )

    assert sale.starting_price_eur == Decimal("210000")


def test_normalize_sale_keeps_legitimate_sale_price_near_sale_date() -> None:
    sale = normalize_sale(
        {
            "source_name": "cessions_etat",
            "source_url": "https://cessions.immobilier-etat.gouv.fr/biens/date-prix-vente",
            "raw_text": "Date de vente prévue prochainement. Prix de vente : 210 000 euros.",
        }
    )

    assert sale.starting_price_eur == Decimal("210000")


def test_normalize_sale_extracts_adjudication_price_from_raw_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/adjuge-raw-text",
            "starting_price_eur": "35 000,00 €",
            "raw_text": (
                "Mise à prix initiale : 35 000,00 €\n"
                "Adjugé :\n"
                "36 000,00 €\n"
                "Surenchère possible jusqu'au 10 juillet 2026."
            ),
        }
    )

    assert sale.starting_price_eur == Decimal("35000.00")
    assert sale.adjudication_price_eur == Decimal("36000.00")
    assert sale.status == "adjudicated"


def test_normalize_sale_does_not_mark_future_adjudication_audience_as_adjudicated() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/audience-adjudication-future.html",
            "title": "Appartement à Bordeaux",
            "status": "Audience d'adjudication",
            "sale_date": "15 octobre 2026 à 15h00",
            "raw_text": "Audience d'adjudication le 15 octobre 2026 à 15h00.",
        }
    )

    assert sale.adjudication_price_eur is None
    assert sale.status == "upcoming"


def test_normalize_sale_infers_future_status_when_source_says_unknown() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://example.test/future-unknown-status",
            "status": "unknown",
            "sale_date": "15 octobre 2099 à 15h00",
        }
    )

    assert sale.status == "upcoming"


def test_normalize_sale_infers_past_status_when_source_says_unknown() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/past-unknown-status",
            "status": "unknown",
            "sale_date": "15 octobre 2000 à 15h00",
        }
    )

    assert sale.status == "past"


def test_normalize_sale_keeps_unknown_status_without_date() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://example.test/undated-unknown-status",
            "status": "unknown",
        }
    )

    assert sale.status == "unknown"


def test_normalize_sale_extracts_rooms_count_from_source_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/rooms-from-page",
            "raw_text": "Estimez vos frais d'acquisition 5 pièces 3 chambres À propos du bien Maison.",
        }
    )

    assert sale.rooms_count == 5
    assert sale.bedrooms_count == 3


def test_normalize_sale_does_not_read_surface_decimal_as_rooms_count() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/un-appartement-et-cave-a-chenove",
            "raw_text": (
                "VISITES : VISITE : MARDI 16 JUIN 2026 A 09 H 00 "
                "1 pièces 34.52 m² superficie À propos du bien CHENOVE (21300), "
                "Un appartement situé au rez-de-chaussée comprenant : entrée, cuisine, séjour."
            ),
        }
    )

    assert sale.rooms_count == 1


def test_normalize_sale_distinguishes_rooms_and_bedrooms() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/rooms-bedrooms",
            "raw_text": "Appartement de type 4 comprenant séjour, cuisine et 3 chambres.",
        }
    )

    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 3


def test_normalize_sale_extracts_written_room_and_bedroom_counts() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/type-trois",
            "raw_text": "Appartement de type trois comprenant séjour, cuisine et deux chambres.",
        }
    )

    assert sale.rooms_count == 3
    assert sale.bedrooms_count == 2


def test_normalize_sale_extracts_rooms_from_listing_title() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-165170-un-appartement-de-4-pieces-pau.html",
            "title": "UN APPARTEMENT DE 4 PIÈCES - Pau",
        }
    )

    assert sale.rooms_count == 4


def test_normalize_sale_extracts_rooms_before_parking_count() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/un-appartement/pau/109107.html",
            "raw_text": "Un appartement de 79,06 m², de trois pièces deux places de parking.",
        }
    )

    assert sale.rooms_count == 3


def test_normalize_sale_reads_single_main_room_as_one_room() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/un-appartement/paris/108781.html",
            "raw_text": "Un appartement de 31,60 m² comprenant entrée, salle d'eau avec wc, pièce principale avec placard.",
        }
    )

    assert sale.rooms_count == 1


def test_normalize_sale_counts_numbered_bedrooms() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/numbered-bedrooms",
            "raw_text": "Maison comprenant séjour, chambre n°1, chambre n°2 et chambre n°3.",
        }
    )

    assert sale.bedrooms_count == 3


def test_normalize_sale_ignores_dvf_comparable_rooms_count() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/rooms-dvf",
            "raw_text": "Données des valeurs foncières Type de bien Date de vente Surface Nb de pièces Prix de vente Maison 100 m2 4 410000 euros.",
        }
    )

    assert sale.rooms_count is None
    assert sale.starting_price_eur is None


def test_normalize_sale_ignores_compact_dvf_comparable_price() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/compact-dvf-price",
            "raw_text": (
                "Données des valeurs foncières Type de bien Date de vente Surface "
                "Nb de pièces Prix de vente 410000 euros."
            ),
        }
    )

    assert sale.starting_price_eur is None


def test_normalize_sale_ignores_dvf_comparable_price_with_colon() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/dvf-colon-price",
            "raw_text": (
                "Données des valeurs foncières Type de bien Date de vente Surface "
                "Nb de pièces Prix de vente : 410000 euros."
            ),
        }
    )

    assert sale.starting_price_eur is None


def test_normalize_sale_maps_french_occupancy_to_enum() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://www.encheres-publiques.com/enchere/maison-kleber",
            "occupancy_status": "Libre de toute occupation",
        }
    )

    assert sale.occupancy_status == "vacant"


def test_normalize_sale_maps_uncertain_occupancy_to_unknown() -> None:
    values = (
        "occupation à vérifier",
        "occupation inconnue",
        "occupation non renseignée",
        "Occupation : à confirmer",
        "statut occupation inconnu",
    )

    for index, value in enumerate(values):
        sale = normalize_sale(
            {
                "source_name": "avoventes",
                "source_url": f"https://avoventes.fr/enchere/occ-unknown-{index}",
                "occupancy_status": value,
            }
        )

        assert sale.occupancy_status == "unknown"


def test_normalize_sale_does_not_treat_visit_libre_as_vacant_when_rented() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_immobilieres",
            "source_url": "https://encheresimmobilieres.fr/ventes/appartement-loue-visite-libre",
            "raw_text": (
                "Visite libre le mercredi 10 juin 2026 de 14h00 à 15h00. "
                "Appartement loué à un locataire suivant bail d'habitation."
            ),
        }
    )

    assert sale.occupancy_status == "rented"


def test_normalize_sale_does_not_treat_no_lease_as_rented() -> None:
    assert normalize_occupancy_status("occupé sans bail") == "occupied"
    assert normalize_occupancy_status("absence de bail écrit") == "unknown"

    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/maison-occupee-sans-bail",
            "raw_text": "Maison occupée sans bail avec travaux à prévoir.",
        }
    )

    assert sale.occupancy_status == "occupied"


def test_normalize_sale_drops_unrecognised_occupancy() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/occ-unknown",
            "occupancy_status": "amiante, plomb, termites",
        }
    )

    assert sale.occupancy_status is None


def test_normalize_sale_drops_template_description_placeholder() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_immobilieres",
            "source_url": "https://encheresimmobilieres.fr/ventes/9155-villa",
            "description": "$d4",
        }
    )

    assert sale.description is None


def test_normalize_sale_does_not_promote_stored_partial_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/vente-6009.html",
            "property_type": "Appartement",
            "surface_m2": "3,78",
            "carrez_surface_m2": "3,78",
            "surface_scope": "partial",
            "surface_source": "pdf",
        }
    )

    assert sale.surface_m2 == Decimal("3.78")
    assert sale.carrez_surface_m2 == Decimal("3.78")
    assert sale.app_surface_m2 is None
    assert sale.app_surface_kind is None
    assert sale.surface_scope == "partial"


def test_adjudication_calendar_numbers_are_not_sale_results():
    from src.normalize import extract_adjudication_price
    for raw in (
        {'raw_text': "Date et lieu de l'adjudication : 5 novembre 2026 - 14h30. Mise à prix : 252 000 €"},
        {'raw_text': 'Adjudication : 05/11/2026'},
        {'source_blocks': {'adjudication': '5 novembre 2026'}},
    ):
        assert extract_adjudication_price(raw) is None
    assert extract_adjudication_price({'raw_text': 'Adjudication : 252 000 €'}) == Decimal('252000')


def test_notarial_decimal_space_preserves_full_carrez_area():
    import json

    from src.sources.notaires import parse_notaires_detail_json
    detail = parse_notaires_detail_json(json.dumps({'typeTransaction':'VNI',
        'vni': {'descriptions':[{'langue':'fr','descLongue':'Studio de 17, 11 m2 carrez/21,31 m2 au sol.'}]},
        'bien': {'typeBien':'APP','appartement':{'typeBien':'APP'}}}))
    assert detail['carrez_surface_m2'] == 17.11
    assert detail['habitable_surface_m2'] is None


def test_future_sale_with_result_price_is_quarantined_not_certified_sold():
    sale = normalize_sale({'source_name':'licitor','source_url':'https://example.test/conflict',
        'sale_date':'2099-10-14T07:30:00Z','adjudication_price_eur':445000,'status':'upcoming'})
    assert sale.status == 'quarantined'
    assert sale.adjudication_price_eur is None
    assert sale.raw_payload['unverified_adjudication_candidate'] == '445000'
    assert 'sale_procedure_conflict' in sale.quality_flags


def test_adjudication_phrase_cannot_borrow_amount_from_another_source_block():
    from src.normalize import extract_adjudication_price

    raw = {'description': "Frais payables en sus du prix d'adjudication",
           'source_blocks': {'description': "Frais payables en sus du prix d'adjudication",
                             'mise_a_prix': '445 000 €'}}
    assert extract_adjudication_price(raw) is None
    assert extract_adjudication_price({'source_blocks': {'resultat': 'Prix d’adjudication : 510 000 €'}}) == Decimal('510000')
