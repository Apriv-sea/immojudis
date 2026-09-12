from src.dedupe import compute_content_hash, dedupe_sales
from src.normalize import normalize_sale


def _sale(source_url: str, address: str = "1 rue Test 33000 Bordeaux"):
    return normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": source_url,
            "address": address,
            "city": "Bordeaux",
            "starting_price_eur": "100 000 €",
            "sale_date": "10 janvier 2027 à 9h00",
        }
    )


def test_compute_content_hash_is_stable_for_same_content() -> None:
    first = _sale("https://avoventes.fr/enchere/1")
    second = _sale("https://avoventes.fr/enchere/2")
    assert compute_content_hash(first) == compute_content_hash(second)


def test_dedupe_sales_keeps_distinct_publisher_urls_even_with_equal_hash() -> None:
    sales = [
        _sale("https://avoventes.fr/enchere/1"),
        _sale("https://avoventes.fr/enchere/1"),
        _sale("https://avoventes.fr/enchere/2"),
        _sale("https://avoventes.fr/enchere/3", "2 rue Test 33000 Bordeaux"),
    ]
    assert len(dedupe_sales(sales)) == 3


def test_dedupe_sales_collapses_cross_source_duplicates() -> None:
    avoventes = _sale("https://avoventes.fr/enchere/1")
    licitor = _sale("https://www.licitor.com/annonce/1.html")
    licitor.source_name = "licitor"

    result = dedupe_sales([avoventes, licitor])

    assert len(result) == 1
    assert result[0].source_url == "https://avoventes.fr/enchere/1"
    assert "https://www.licitor.com/annonce/1.html" in result[0].source_urls
    assert result[0].dedupe_confidence == "content_hash"


def _make(
    source_url: str,
    *,
    source_name: str = "avoventes",
    address: str = "12 avenue de la Republique 33000 Bordeaux",
    city: str | None = "Bordeaux",
    postal_code: str | None = "33000",
    starting_price: str | None = "100 000 €",
    sale_date: str | None = "10 janvier 2027 à 9h00",
    surface_m2: str | None = None,
    documents: list[dict[str, str]] | None = None,
):
    raw: dict[str, object] = {
        "source_name": source_name,
        "source_url": source_url,
        "address": address,
    }
    if city is not None:
        raw["city"] = city
    if postal_code is not None:
        raw["postal_code"] = postal_code
    if starting_price is not None:
        raw["starting_price_eur"] = starting_price
    if sale_date is not None:
        raw["sale_date"] = sale_date
    if surface_m2 is not None:
        raw["surface_m2"] = surface_m2
    if documents is not None:
        raw["documents"] = documents
    return normalize_sale(raw)


def test_dedupe_merges_same_address_across_sources_when_price_differs() -> None:
    # Même adresse précise + même date, mais prix légèrement différent selon la
    # source (frais inclus/exclus) → content_hash diffère, l'adresse rapproche.
    avoventes = _make("https://avoventes.fr/enchere/9", starting_price="100 000 €")
    licitor = _make(
        "https://www.licitor.com/annonce/9.html",
        source_name="licitor",
        starting_price="105 000 €",
    )

    result = dedupe_sales([avoventes, licitor])

    assert len(result) == 1
    assert result[0].dedupe_confidence == "address"
    assert "https://www.licitor.com/annonce/9.html" in result[0].source_urls
    assert len(result[0].observations) == 2
    assert result[0].raw_payload["merged_sources"][0]["source_name"] == "licitor"


def test_dedupe_merges_same_address_with_abbreviated_street_and_missing_postal_code() -> None:
    avoventes = _make(
        "https://avoventes.fr/enchere/9-bis",
        address="12 avenue de la République 33000 Bordeaux",
        postal_code="33000",
        surface_m2=None,
    )
    licitor = _make(
        "https://www.licitor.com/annonce/9-bis.html",
        source_name="licitor",
        address="12 av. République, Bordeaux",
        postal_code=None,
        surface_m2="84 m²",
        documents=[{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
    )

    result = dedupe_sales([avoventes, licitor])

    assert len(result) == 1
    assert result[0].dedupe_confidence == "address"
    assert result[0].surface_m2 is not None
    assert result[0].documents == [{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}]
    assert "https://www.licitor.com/annonce/9-bis.html" in result[0].source_urls


def test_dedupe_merges_merignac_duplicate_with_location_suffixes() -> None:
    notaires = _make(
        "https://www.immo-interactif.fr/encheres-en-ligne/maison/merignac-33/2008146",
        source_name="notaires",
        address="33 Avenue Léon Blum, 33700 Mérignac",
        city=None,
        postal_code=None,
        starting_price="330 000 €",
        sale_date="22 juillet 2026 à 10h00",
        surface_m2="94 m²",
    )
    encheres_publiques = _make(
        "https://www.encheres-publiques.com/encheres/immobilier/maisons/merignac-33/belle-maison_129746",
        source_name="encheres_publiques",
        address="33 Av. Léon Blum, 33700 Mérignac, France, (33)",
        city="Mérignac",
        postal_code="33700",
        starting_price="330 000 €",
        sale_date="22 juillet 2026 à 10h00",
        surface_m2="94 m²",
    )

    result = dedupe_sales([notaires, encheres_publiques])

    assert len(result) == 1
    assert result[0].dedupe_confidence == "address"
    assert "https://www.immo-interactif.fr/encheres-en-ligne/maison/merignac-33/2008146" in result[0].source_urls
    assert "https://www.encheres-publiques.com/encheres/immobilier/maisons/merignac-33/belle-maison_129746" in result[0].source_urls


def test_dedupe_merges_same_address_when_one_is_missing_date_and_price() -> None:
    avoventes = _make("https://avoventes.fr/enchere/10")
    licitor = _make(
        "https://www.licitor.com/annonce/10.html",
        source_name="licitor",
        starting_price=None,
        sale_date=None,
    )

    result = dedupe_sales([avoventes, licitor])

    assert len(result) == 1


def test_dedupe_keeps_distinct_lots_at_same_address() -> None:
    # Même immeuble, deux lots distincts : date ET prix diffèrent → on garde les deux.
    lot_a = _make(
        "https://avoventes.fr/enchere/11",
        starting_price="100 000 €",
        sale_date="10 janvier 2027 à 9h00",
    )
    lot_b = _make(
        "https://www.licitor.com/annonce/11.html",
        source_name="licitor",
        starting_price="260 000 €",
        sale_date="15 mars 2027 à 9h00",
    )

    result = dedupe_sales([lot_a, lot_b])

    assert len(result) == 2


def test_dedupe_merges_duplicate_lots_independently_at_same_address() -> None:
    lot_a = _make(
        "https://avoventes.fr/enchere/11-a",
        starting_price="100 000 €",
        sale_date="10 janvier 2027 à 9h00",
    )
    lot_b = _make(
        "https://www.licitor.com/annonce/11-b.html",
        source_name="licitor",
        starting_price="260 000 €",
        sale_date="15 mars 2027 à 9h00",
        surface_m2=None,
    )
    lot_b_duplicate = _make(
        "https://www.info-encheres.com/vente-11-b.html",
        source_name="info_encheres",
        starting_price="262 000 €",
        sale_date="15 mars 2027 à 9h00",
        surface_m2="72 m²",
    )

    result = dedupe_sales([lot_a, lot_b, lot_b_duplicate])

    assert len(result) == 2
    merged_lot_b = next(sale for sale in result if "11-b" in " ".join(sale.source_urls))
    assert merged_lot_b.dedupe_confidence == "address"
    assert "https://www.info-encheres.com/vente-11-b.html" in merged_lot_b.source_urls
    assert merged_lot_b.surface_m2 is not None


def test_dedupe_does_not_merge_city_only_addresses() -> None:
    # Adresse sans numéro de voie (commune seule) : on ne fusionne pas.
    first = _make(
        "https://avoventes.fr/enchere/12",
        address="Bordeaux",
        postal_code=None,
        starting_price="100 000 €",
        sale_date="10 janvier 2027 à 9h00",
    )
    second = _make(
        "https://www.licitor.com/annonce/12.html",
        source_name="licitor",
        address="Bordeaux",
        postal_code=None,
        starting_price="260 000 €",
        sale_date="15 mars 2027 à 9h00",
    )

    result = dedupe_sales([first, second])

    assert len(result) == 2


def test_dedupe_keeps_richest_source_for_cross_source_duplicate() -> None:
    poor = _make("https://avoventes.fr/enchere/1")
    rich = _make(
        "https://www.vench.fr/vente-1-maison.html",
        source_name="vench",
        surface_m2="91,78 m²",
        documents=[{"label": "Cahier des conditions", "url": "https://example.test/cdc.pdf"}],
    )

    result = dedupe_sales([poor, rich])

    assert len(result) == 1
    assert result[0].source_url == "https://www.vench.fr/vente-1-maison.html"
    assert "https://avoventes.fr/enchere/1" in result[0].source_urls


def test_dedupe_sanitizes_documents_hydrated_directly_from_storage() -> None:
    sale = _sale("https://avoventes.fr/enchere/document-cleanup")
    sale.documents = [
        {"label": "document", "url": "https://www.licitor.com/"},
        {"label": "PV descriptif", "url": "https://example.test/pv.pdf"},
    ]

    result = dedupe_sales([sale])

    assert result[0].documents == [
        {"label": "PV descriptif", "url": "https://example.test/pv.pdf"}
    ]
