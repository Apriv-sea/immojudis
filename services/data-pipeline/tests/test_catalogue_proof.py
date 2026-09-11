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
