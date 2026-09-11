from src.catalogue_proof import certify_catalogue, public_page_proof


def certificate(pages, parsed, emitted=None):
    return certify_catalogue('info_encheres', pages, parsed, emitted or set(), [], False, {})


def test_date_next_to_counter_is_not_part_of_total():
    p = public_page_proof('info_encheres', '<p>11 septembre 2026 85 annonces</p>', 'https://example.test/list')
    assert p['advertised_totals'] == [85]


def test_exact_counter_match_certifies_discovery_but_not_filtered_output():
    p = public_page_proof('info_encheres', '<p>2 annonces</p>', 'https://example.test/list')
    c = certificate([p], {'info_encheres': {'a', 'b'}}, {'a'})
    assert c['public_discovery_certified']
    assert not c['all_discovered_announcements_emitted']
    assert not c['database_completeness_certified']
    assert c['discovered_but_not_emitted_urls'] == ['b']


def test_changing_total_or_missing_card_refuses_certificate():
    a = public_page_proof('info_encheres', '<p>2 annonces</p>', 'https://example.test/list')
    b = {**a, 'advertised_totals': [3]}
    assert not certificate([a, b], {'info_encheres': {'a', 'b'}})['public_discovery_certified']
    a['public_urls'] = ['a', 'missing']
    assert not certificate([a], {'info_encheres': {'a', 'b'}})['public_discovery_certified']


def test_missing_intermediate_page_prevents_terminal_page_certificate():
    p = {'partition': 'agrasc', 'page_index': 0, 'advertised_totals': [],
         'advertised_last_pages': [2], 'public_urls': ['a'], 'outside_scope_urls': [], 'unlinked_cards': 0}
    c = certify_catalogue('agrasc', [p, {**p, 'page_index': 2}], {'agrasc': {'a'}}, {'a'}, [], False, {})
    assert not c['public_discovery_certified']
    c = certify_catalogue('agrasc', [p, {**p, 'page_index': 1}, {**p, 'page_index': 2}], {'agrasc': {'a'}}, {'a'}, [], False, {})
    assert c['public_discovery_certified']


def test_access_failure_or_budget_prevents_certificate():
    p = public_page_proof('info_encheres', '<p>1 annonce</p>', 'https://example.test/list')
    p['advertised_totals'] = [1]
    for errors, budget in [(['403'], False), ([], True)]:
        c = certify_catalogue('info_encheres', [p], {'info_encheres': {'a'}}, {'a'}, errors, budget, {})
        assert not c['public_discovery_certified']


def test_avoventes_amicable_exclusion_is_explicit():
    p = public_page_proof('avoventes', '<p>2 résultats</p><div data-link="/a">Mise à prix</div>'
                          '<div data-link="/b">Vente amiable</div>', 'https://example.test/list')
    c = certify_catalogue('avoventes', [p], {'avoventes': {'https://example.test/a'}},
                          {'https://example.test/a'}, [], False, {})
    assert c['public_discovery_certified']
    assert c['partitions'][0]['outside_scope_count'] == 1


def test_agrasc_scopes_cards_and_pagination_to_real_estate():
    from src.sources.agrasc import _location, parse_agrasc_html
    assert _location('Paris (75016)') == ('Paris', '75')
    assert _location('Chelles (77500)') == ('Chelles', '77')
    assert _location('Nice (O6)') == ('Nice', '06')
    html = '<div class="card-vente-immo"><h3 class="fr-card__title"><a href="/cars">Cars</a></h3></div>' \
           '<div class="view-liste-ventes-immobilieres"><div class="card-vente-immo">' \
           '<h3 class="fr-card__title"><a href="/house">Maison</a></h3>' \
           '<p class="fr-card__detail">Paris (75016)</p></div>' \
           '<a class="fr-pagination__link--last" href="?page=5">Dernière page</a></div>' \
           '<a class="fr-pagination__link--last" href="?page=8">Dernière page</a>'
    assert len(parse_agrasc_html(html)) == 1
    proof = public_page_proof('agrasc', html, 'https://agrasc.gouv.fr/ventes-aux-encheres')
    assert proof['advertised_last_pages'] == [5]
    assert proof['public_urls'] == ['https://agrasc.gouv.fr/house']


def test_licitor_preserves_distinct_lots_sharing_one_url():
    from src.catalogue_proof import record_id
    from src.sources.licitor import parse_licitor_list_sales
    html = '<p>2 annonces</p><ul class="AdResults">' + ''.join(
        f'<li><a class="Ad" href="/annonce/parking/109985.html"><p><span>33</span><span>Villenave</span></p>'
        f'<p>Un parking</p><p>Lot n°{lot}</p><p>Mise à prix : 4 000 €</p></a></li>'
        for lot in [58, 59]) + '</ul>'
    url = 'https://www.licitor.com/ventes-aux-encheres-immobilieres/sud-ouest-pyrenees/prochaines-ventes.html'
    rows = parse_licitor_list_sales(html, url)
    assert len(rows) == 1 and len(rows[0]['source_lots']) == 2
    assert '59' in rows[0]['raw_text']
    p = public_page_proof('licitor', html, url)
    partition = p['partition']
    records = {record_id(rows[0]['source_url'], lot['raw_text']) for lot in rows[0]['source_lots']}
    c = certify_catalogue('licitor', [p], {partition: {rows[0]['source_url']}}, {rows[0]['source_url']},
                          [], False, {}, {partition: records})
    assert c['public_discovery_certified']
    c = certify_catalogue('licitor', [p], {partition: {rows[0]['source_url']}}, {rows[0]['source_url']},
                          [], False, {}, {partition: {next(iter(records))}})
    assert not c['public_discovery_certified']


def test_cessions_supports_corsica_and_unpadded_departments():
    from src.sources.cessions_etat import _location
    assert _location('Ajaccio - 2A') == ('Ajaccio', '2A')
    assert _location('Bastia - 2B') == ('Bastia', '2B')
    assert _location('Alloz - 4') == ('Alloz', '04')
    assert _location('VEBRE - 9') == ('VEBRE', '09')


def test_cessions_department_fallback_requires_title_and_url_agreement():
    from src.sources.cessions_etat import parse_cessions_etat_html
    html = '<div id="bien-1" data-url="/biens/maisons-la-motte-04" data-titre="Deux maisons à La Motte 04" data-localisation="La Motte"></div>'
    assert parse_cessions_etat_html(html)[0]['department'] == '04'
    assert parse_cessions_etat_html(html.replace('maisons-la-motte-04', 'maisons-la-motte'))[0]['department'] is None


def test_unlinked_sold_archive_only_allows_qualified_certificate():
    html = '<div class="view-liste-ventes-immobilieres"><div class="card-vente-immo">' \
           '<h3 class="fr-card__title"><a href="/a">Maison</a></h3></div>' \
           '<div class="card-vente-immo sold no-link"><h3>Archive vendue</h3></div>' \
           '<a class="fr-pagination__link--last" href="?page=0">Dernière page</a></div>'
    p = public_page_proof('agrasc', html, 'https://agrasc.gouv.fr/list')
    c = certify_catalogue('agrasc', [p], {'agrasc': {'https://agrasc.gouv.fr/a'}},
                          {'https://agrasc.gouv.fr/a'}, [], False, {})
    assert not c['public_discovery_certified']
    assert c['addressable_public_inventory_certified']
    assert len(c['partitions'][0]['unlinked_public_cards']) == 1


def test_licitor_detail_collection_carries_all_listing_lots(monkeypatch):
    from src.sources import licitor
    url = 'https://www.licitor.com/annonce/parking/109985.html'
    lots = [{'raw_text': 'Parking lot 58'}, {'raw_text': 'Parking lot 59'}]

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url):
            return '<html></html>'

    monkeypatch.setattr(licitor, 'LicitorClient', Client)
    monkeypatch.setattr(licitor, 'TARGET_DEPARTMENTS', ('33',))
    monkeypatch.setattr(licitor, '_collect_list_sales', lambda *args, **kwargs: [{'source_url': url, 'source_lots': lots}])
    monkeypatch.setattr(licitor, 'parse_licitor_detail_html', lambda *args: {'source_name': 'licitor', 'source_url': url, 'department': '33', 'title': 'Deux parkings', 'raw_text': 'Deux parkings lot 58 et lot 59'})
    result = licitor.scrape_licitor_aquitaine_result()
    assert result.sales[0]['source_lots'] == lots
    assert 'lot 58' in result.sales[0]['source_blocks']['lots_publics']
    assert 'lot 59' in result.sales[0]['source_blocks']['lots_publics']


def test_licitor_identical_duplicate_rows_are_counted_without_inventing_lots():
    p = {'partition': 'zone', 'page_index': 1, 'advertised_totals': [2],
         'advertised_last_pages': [], 'public_urls': ['a'], 'outside_scope_urls': [],
         'unlinked_cards': 0, 'card_nodes': 2, 'public_record_ids': ['same-lot']}
    c = certify_catalogue('licitor', [p], {'zone': {'a'}}, {'a'}, [], False, {}, {'zone': {'same-lot'}})
    assert c['public_discovery_certified']
    assert c['partitions'][0]['identical_repeated_rows'] == 1
    p['card_nodes'] = 1
    assert not certify_catalogue('licitor', [p], {'zone': {'a'}}, {'a'}, [], False, {}, {'zone': {'same-lot'}})['public_discovery_certified']


def test_avoventes_location_uses_property_description_not_lawyer_address():
    from src.sources.avoventes import _property_location_codes, parse_avoventes_detail_html
    assert _property_location_codes('Immeuble à MARSEILLE (13014)') == {'department': '13', 'postal_code': '13014'}
    assert _property_location_codes('Biens à NICE (06) et GUILLAUMES (06470)')['department'] == '06'
    assert _property_location_codes('Biens à PARIS (75016) et NICE (06000)') == {}
    result = parse_avoventes_detail_html('<footer>Cabinet 11 rue Armeny 13006 MARSEILLE</footer>', 'https://avoventes.fr/enchere/test')
    assert not result.get('department')


def test_encheres_immobilieres_stops_on_unavailable_inventory(monkeypatch):
    from src.sources import encheres_immobilieres as source
    calls = []

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url):
            calls.append(url)
            raise TimeoutError('source unavailable')

    monkeypatch.setattr(source, 'PoliteHttpClient', Client)
    result = source.scrape_encheres_immobilieres_aquitaine_result(max_pages=100)
    assert len(calls) == 1
    assert result.errors and result.coverage['coverage_complete'] is False
