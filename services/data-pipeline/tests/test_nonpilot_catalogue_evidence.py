from __future__ import annotations


def _info_page(rows: list[tuple[str, str]], *, next_page: bool = False, total: int | None = None) -> str:
    counter = f"<p>{total if total is not None else len(rows)} annonces</p>"
    table = "".join(
        f"<tr><td>{index}</td><td>Ville</td><td>{department}</td><td>Maison</td>"
        f"<td>100 000 €</td><td>01/01/2027</td><td>Avocat</td>"
        f"<td><a href=\"/detail-{index}\">detail</a></td></tr>"
        for index, department in rows
    )
    next_link = (
        '<a href="/recherche.php?1=1&amp;cat=1&amp;snr=1">Suivant</a>'
        if next_page
        else ""
    )
    return f"{counter}<table>{table}</table>{next_link}"


def _cessions_page(url: str, *, last_page: int | None = None) -> str:
    last = (
        f'<a class="fr-pagination__link--last" href="?page={last_page}">Dernière page</a>'
        if last_page is not None
        else ""
    )
    return f'<div id="bien-1" data-url="{url}"><h3>Maison</h3></div>{last}'


def test_catalogue_evidence_supports_explicit_partition_and_amicable_scope():
    from src.catalogue_proof import CatalogueEvidence

    body = (
        '<p>2 résultats</p>'
        '<div data-link="/enchere/judicial">Maison<br>Mise à prix : 100 000 €</div>'
        '<div data-link="/enchere/amiable">Vente amiable<br>Mise à prix : 80 000 €</div>'
    )
    rows = [
        {"source_url": "https://avoventes.fr/enchere/judicial"},
        {"source_url": "https://avoventes.fr/enchere/amiable"},
    ]
    evidence = CatalogueEvidence("avoventes")
    evidence.observe(body, "https://avoventes.fr/recherche", rows, partition="national")
    metrics = evidence.metrics(rows, [])

    assert metrics["coverage_complete"] is True
    certificate = metrics["certificate"]
    assert certificate["public_discovery_certified"] is True
    assert certificate["partitions"][0]["partition"] == "national"
    assert certificate["partitions"][0]["outside_scope_count"] == 1
    assert certificate["partitions"][0]["public_unique_urls"] == 1
    assert certificate["partitions"][0]["parsed_unique_urls"] == 1


def test_catalogue_evidence_never_overrides_negative_pagination_gate():
    from src.catalogue_proof import CatalogueEvidence

    body = _info_page([("1", "33"), ("2", "33")], total=2)
    rows = [
        {"source_url": "https://www.info-encheres.com/detail-1"},
        {"source_url": "https://www.info-encheres.com/detail-2"},
    ]
    evidence = CatalogueEvidence("info_encheres")
    evidence.observe(body, "https://www.info-encheres.com/vente-encheres-immobilieres-annonces.html", rows)
    metrics = evidence.metrics(
        rows,
        [],
        coverage={"coverage_complete": False, "stop_reason": "repeated_page"},
    )

    assert metrics["coverage_complete"] is False
    assert metrics["certificate"]["public_discovery_certified"] is False
    assert metrics["certificate"]["coverage_gate_failed"] == {
        "coverage_complete": False,
        "stop_reason": "repeated_page",
    }


def test_catalogue_evidence_keeps_validation_drop_unhandled():
    from src.catalogue_proof import CatalogueEvidence

    body = _info_page([("1", "33")], total=1)
    url = "https://www.info-encheres.com/vente-encheres-immobilieres-annonces.html"
    source_url = "https://www.info-encheres.com/detail-1"
    evidence = CatalogueEvidence("info_encheres")
    evidence.observe(body, url, [{"source_url": source_url}])

    metrics = evidence.metrics([], [])
    certificate = metrics["certificate"]

    assert certificate["public_discovery_certified"] is True
    assert certificate["all_discovered_announcements_emitted"] is False
    assert certificate["public_parsed_urls"] == [source_url]
    assert certificate["returned_validated_urls"] == []
    assert certificate["excluded_urls"] == []
    assert certificate["unhandled_public_urls"] == [source_url]


def test_catalogue_evidence_accepts_only_explicit_scope_exclusions():
    from src.catalogue_proof import CatalogueEvidence

    body = _info_page([("1", "33"), ("2", "75")], total=2)
    url = "https://www.info-encheres.com/vente-encheres-immobilieres-annonces.html"
    rows = [
        {"source_url": "https://www.info-encheres.com/detail-1"},
        {"source_url": "https://www.info-encheres.com/detail-2"},
    ]
    evidence = CatalogueEvidence("info_encheres")
    evidence.observe(body, url, rows)

    metrics = evidence.metrics(
        rows[:1],
        [],
        exclusions={rows[1]["source_url"]: "department_filter"},
        scope={"public": "national", "configured": "target_departments"},
    )
    certificate = metrics["certificate"]

    assert metrics["coverage_complete"] is True
    assert certificate["scope"] == {"public": "national", "configured": "target_departments"}
    assert certificate["returned_validated_urls"] == [rows[0]["source_url"]]
    assert certificate["excluded_urls"] == [{"url": rows[1]["source_url"], "reason": "department_filter"}]
    assert certificate["unhandled_public_urls"] == []


def test_avoventes_certifies_before_department_filter(monkeypatch):
    from src.sources import avoventes as source

    list_url = f"{source.SEARCH_URL}?display=liste&order=asc&sort=date"
    body = (
        "<p>2 résultats</p>"
        '<div data-link="/enchere/judicial"><p>Maison à BORDEAUX (33000)</p>'
        "<p>Mise à prix : 100 000 €</p></div>"
        '<div data-link="/enchere/amiable"><p>Vente amiable</p>'
        '<p>Maison à PARIS (75000)</p><p>Mise à prix : 80 000 €</p></div>'
    )

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url):
            assert url == list_url
            return body

        def coverage_metrics(self):
            return {"requests_attempted": 1, "requests_succeeded": 1}

    monkeypatch.setattr(source, "AvoventesClient", Client)
    monkeypatch.setattr(source, "TARGET_DEPARTMENTS", ("33",))
    monkeypatch.setattr(source, "_enrich_sale_from_detail", lambda client, sale, errors: None)
    monkeypatch.setattr(source, "validate_raw_sales", lambda source_name, sales, errors: sales)

    result = source.scrape_avoventes_aquitaine_result()

    assert len(result.sales) == 1
    assert result.coverage["inventory_before_department_filter"] == 2
    assert result.coverage["coverage_complete"] is True
    assert result.coverage["certificate"]["public_discovery_certified"] is True
    assert result.coverage["certificate"]["partitions"][0]["outside_scope_count"] == 1
    assert result.coverage["certificate"]["excluded_urls"] == [
        {"url": "https://avoventes.fr/enchere/amiable", "reason": "vente_amiable"}
    ]
    assert result.coverage["certificate"]["returned_validated_urls"] == [
        "https://avoventes.fr/enchere/judicial"
    ]


def test_avoventes_public_proof_uses_data_link_cards_independently():
    from src.catalogue_proof import public_page_proof

    proof = public_page_proof(
        "avoventes",
        '<p>1 résultats</p><article data-link="/enchere/independent">'
        "Maison sans le markup du parseur</article>",
        "https://avoventes.fr/recherche",
    )

    assert proof["card_nodes"] == 1
    assert proof["public_urls"] == ["https://avoventes.fr/enchere/independent"]
    assert proof["unlinked_cards"] == 0


def test_info_encheres_certifies_public_rows_before_department_filter(monkeypatch):
    from src.sources import info_encheres as source

    start_url = source.LIST_URL
    page_url = f"{source.BASE_URL}/recherche.php?1=1&cat=1&snr=1"
    bodies = {
        start_url: _info_page([("1", "33")], next_page=True, total=2),
        page_url: _info_page([("2", "75")], total=2),
    }

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url):
            return bodies[url]

        def coverage_metrics(self):
            return {"requests_attempted": 2, "requests_succeeded": 2}

    monkeypatch.setattr(source, "PoliteHttpClient", Client)
    monkeypatch.setattr(source, "TARGET_DEPARTMENTS", ("33",))
    monkeypatch.setattr(source, "should_fetch_detail", lambda sale, known: False)
    monkeypatch.setattr(source, "validate_raw_sales", lambda source_name, sales, errors: sales)

    result = source.scrape_info_encheres_aquitaine_result(max_pages=10)

    assert len(result.sales) == 1
    assert result.sales[0]["department"] == "33"
    assert result.coverage["linked_pages_complete"] is True
    assert result.coverage["coverage_complete"] is True
    assert result.coverage["certificate"]["public_discovery_certified"] is True
    assert result.coverage["certificate"]["partitions"][0]["parsed_unique_urls"] == 2


def _run_cessions_with_pages(monkeypatch, bodies: dict[str, str], sales: dict[str, list[dict]], max_pages: int = 10):
    from src.sources import cessions_etat as source

    calls: list[str] = []

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url):
            calls.append(url)
            return bodies[url]

        def coverage_metrics(self):
            return {"requests_attempted": len(calls), "requests_succeeded": len(calls)}

    monkeypatch.setattr(source, "PoliteHttpClient", Client)
    monkeypatch.setattr(source, "TARGET_DEPARTMENTS", ("33",))
    monkeypatch.setattr(source, "parse_cessions_etat_html", lambda html, page_url: sales[page_url])
    monkeypatch.setattr(source, "should_fetch_detail", lambda sale, known: False)
    monkeypatch.setattr(source, "validate_raw_sales", lambda source_name, rows, errors: rows)
    result = source.scrape_cessions_etat_aquitaine_result(max_pages=max_pages)
    return result, calls


def test_cessions_uses_announced_terminal_page(monkeypatch):
    from src.sources import cessions_etat as source

    page0 = source.LIST_URL
    page1 = f"{source.LIST_URL}?page=1"
    page2 = f"{source.LIST_URL}?page=2"
    bodies = {
        page0: _cessions_page("/annonce/a", last_page=2),
        page1: _cessions_page("/annonce/b", last_page=2),
        page2: _cessions_page("/annonce/c"),
    }
    sales = {
        page0: [{"source_url": "https://cessions.immobilier-etat.gouv.fr/annonce/a", "department": "33"}],
        page1: [{"source_url": "https://cessions.immobilier-etat.gouv.fr/annonce/b", "department": "33"}],
        page2: [{"source_url": "https://cessions.immobilier-etat.gouv.fr/annonce/c", "department": "33"}],
    }

    result, calls = _run_cessions_with_pages(monkeypatch, bodies, sales)

    assert calls == [page0, page1, page2]
    assert result.coverage["stop_reason"] == "exhausted"
    assert result.coverage["coverage_complete"] is True
    assert result.coverage["certificate"]["public_discovery_certified"] is True


def test_cessions_repeated_page_cannot_become_complete(monkeypatch):
    from src.sources import cessions_etat as source

    page0 = source.LIST_URL
    page1 = f"{source.LIST_URL}?page=1"
    page2 = f"{source.LIST_URL}?page=2"
    bodies = {
        page0: _cessions_page("/annonce/a", last_page=2),
        page1: _cessions_page("/annonce/b", last_page=2),
        page2: _cessions_page("/annonce/b"),
    }
    sales = {
        page0: [{"source_url": "https://cessions.immobilier-etat.gouv.fr/annonce/a", "department": "33"}],
        page1: [{"source_url": "https://cessions.immobilier-etat.gouv.fr/annonce/b", "department": "33"}],
        page2: [{"source_url": "https://cessions.immobilier-etat.gouv.fr/annonce/b", "department": "33"}],
    }

    result, calls = _run_cessions_with_pages(monkeypatch, bodies, sales)

    assert calls == [page0, page1, page2]
    assert result.coverage["stop_reason"] == "repeated_page"
    assert result.coverage["coverage_complete"] is False
    assert result.coverage["certificate"]["public_discovery_certified"] is False
    assert result.coverage["certificate"]["coverage_gate_failed"]["stop_reason"] == "repeated_page"


def test_cessions_public_proof_counts_card_without_url():
    from src.catalogue_proof import public_page_proof

    proof = public_page_proof(
        "cessions_etat",
        '<div id="bien-1" data-url="/annonce/one"><h3>Maison</h3></div>'
        '<div id="bien-2"><h3>Maison sans lien</h3></div>',
        "https://cessions.immobilier-etat.gouv.fr/",
    )

    assert proof["card_nodes"] == 2
    assert proof["public_urls"] == [
        "https://cessions.immobilier-etat.gouv.fr/annonce/one"
    ]
    assert proof["unlinked_cards"] == 1
