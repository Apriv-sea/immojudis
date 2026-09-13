"""Evidence for a dated public catalogue, distinct from database completeness."""
from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup

COUNTERS = {
    'avoventes': r'(?<!\d)(\d{1,3}(?:[ \u00a0\u202f]\d{3})*|\d+)\s+résultats',
    'vench': r'(?<!\d)(\d{1,3}(?:[ \u00a0\u202f]\d{3})*|\d+)\s+ventes aux enchères trouvées',
    'info_encheres': r'(?<!\d)(\d{1,3}(?:[ \u00a0\u202f]\d{3})*|\d+)\s+annonces\b',
    'licitor': r'(?<!\d)(\d{1,3}(?:[ \u00a0\u202f]\d{3})*|\d+)\s+annonces\b',
    'encheres_immobilieres': r'(?<!\d)(\d{1,3}(?:[ \u00a0\u202f]\d{3})*|\d+)\s+biens en ventes?',
}


def record_id(url: str, text: str) -> str:
    return hashlib.sha256((canonical(url) + "\n" + " ".join(text.split())).encode()).hexdigest()


def canonical(url: str) -> str:
    return urlparse(url)._replace(fragment='').geturl()


def page_index(source: str, url: str) -> int:
    parsed = urlparse(url)
    if source == 'petites_affiches':
        match = re.search(r'-p(\d+)\.html$', parsed.path)
        return int(match[1]) if match else 1
    key = 'snr' if source == 'info_encheres' else 'p' if source in {'vench', 'licitor'} else 'page'
    first = 0 if source in {'info_encheres', 'agrasc', 'cessions_etat'} else 1
    values = parse_qs(parsed.query).get(key, [str(first)])
    return int(values[0]) if values[0].isdigit() else first


def public_page_proof(source: str, body: str, url: str, partition: str | None = None) -> dict:
    soup = BeautifulSoup(body, 'html.parser')
    if source == 'agrasc':
        soup = soup.select_one('.view-liste-ventes-immobilieres') or soup
    text = soup.get_text(' ', strip=True)
    totals = {int(re.sub(r'\s', '', m[1])) for m in re.finditer(COUNTERS.get(source, r'(?!)'), text, re.I)}
    candidates: set[str] = set()
    excluded: set[str] = set()
    missing_links = 0
    records: set[str] = set()
    unlinked_records = []
    cards = []
    if source == 'avoventes':
        cards = soup.select('[data-link]')
    elif source == 'vench':
        cards = soup.select('.featured-item')
    elif source == 'agrasc':
        cards = soup.select('.card-vente-immo')
    elif source == 'petites_affiches':
        cards = soup.select('div[class*="annonce_lot_"]')
    elif source == 'cessions_etat':
        # Count every public card before looking for its identifier. A card
        # without ``data-url`` is evidence of an unaddressable public
        # announcement and must fail the inventory proof.
        cards = soup.select('div[id^="bien-"]')
    elif source == 'info_encheres':
        cards = [r for r in soup.select('tr') if r.find('td') and r.find('td').get_text(strip=True).isdigit()]
    elif source == 'licitor':
        cards = soup.select('.AdResults a.Ad[href]')
    for card in cards:
        href = card.get('data-link') or card.get('data-url')
        if not href:
            links = card.select('a[href]') if card.name != 'a' else [card]
            if source == 'vench':
                links = [a for a in links if re.search(r'(?:^|/)vente-\d+', str(a['href']))]
            elif source == 'agrasc':
                links = card.select('.fr-card__title a[href]')
            elif source == 'petites_affiches':
                links = card.select('.titreVente a[href]')
            href = links[0]['href'] if links else None
        if not href:
            missing_links += 1
            unlinked_records.append({'id': record_id(urlparse(url)._replace(query='').geturl(), card.get_text(' ', strip=True)),
                                     'sold': 'sold' in (card.get('class') or []),
                                     'title': card.select_one('h3').get_text(' ', strip=True) if card.select_one('h3') else None})
            continue
        target = canonical(urljoin(url, str(href)))
        if source == 'avoventes' and 'vente amiable' in card.get_text(' ', strip=True).lower():
            excluded.add(target)
        else:
            candidates.add(target)
            records.add(record_id(target, card.get_text(" ", strip=True)))
    last_indices = set()
    for a in soup.select('a[href]'):
        markup = str(a).lower()
        if any(marker in markup for marker in ('--last', 'rel="last"', 'dernière page', 'angle-double-right')):
            target = urljoin(url, str(a['href']))
            if urlparse(target).netloc == urlparse(url).netloc:
                last_indices.add(page_index(source, target))
    catalogue_partition = (
        partition if partition is not None else urlparse(url).path if source == 'licitor' else source
    )
    return {'partition': catalogue_partition, 'page_index': page_index(source, url),
            'advertised_totals': sorted(totals), 'advertised_last_pages': sorted(last_indices),
            'public_urls': sorted(candidates), 'outside_scope_urls': sorted(excluded),
            'unlinked_cards': missing_links, 'card_nodes': len(cards), 'public_record_ids': sorted(records), 'unlinked_records': unlinked_records}


def _normalise_exclusions(exclusions: Mapping[str, str] | list[dict[str, str]] | None) -> dict[str, str]:
    """Return URL -> reason without turning validation failures into exclusions."""
    if not exclusions:
        return {}
    entries: list[tuple[Any, Any]] = (
        list(exclusions.items()) if isinstance(exclusions, Mapping)
        else [
            (item.get('url') or item.get('source_url'), item.get('reason'))
            for item in exclusions if isinstance(item, Mapping)
        ]
    )
    result: dict[str, str] = {}
    for raw_url, raw_reason in entries:
        if not raw_url:
            continue
        url = canonical(str(raw_url))
        reason = str(raw_reason or '').strip() or 'unspecified'
        result[url] = reason
    return result


def certify_catalogue(
    source: str,
    pages: list[dict],
    parsed: dict[str, set[str]],
    emitted: set[str],
    errors: list,
    budget_exhausted: bool,
    coverage: dict,
    parsed_records: dict[str, set[str]] | None = None,
    exclusions: Mapping[str, str] | list[dict[str, str]] | None = None,
    scope: Any = None,
) -> dict:
    """Fail closed; every positive certificate names its exact scope and evidence."""
    partitions = []
    discovered: set[str] = set()
    unhandled_urls: set[str] = set()
    public_urls_all = {canonical(str(u)) for p in pages for u in p.get('public_urls', []) if u}
    outside_urls_all = {canonical(str(u)) for p in pages for u in p.get('outside_scope_urls', []) if u}
    parsed_urls_all = {canonical(str(u)) for values in parsed.values() for u in values if u}
    emitted = {canonical(str(u)) for u in emitted if u}
    explicit_exclusions = _normalise_exclusions(exclusions)
    # Outside-scope cards are still public evidence. Give them a reason even
    # when an adapter did not supply a source-specific label; adapters such as
    # Avoventes override this with ``vente_amiable``.
    effective_exclusions = {**{url: 'outside_scope' for url in outside_urls_all}, **explicit_exclusions}
    valid_exclusion_urls = public_urls_all | outside_urls_all | parsed_urls_all
    invalid_exclusion_urls = sorted(set(effective_exclusions) - valid_exclusion_urls)
    for partition in sorted({p['partition'] for p in pages}):
        group = [p for p in pages if p['partition'] == partition]
        urls = {canonical(str(u)) for p in group for u in p.get('public_urls', []) if u}
        outside = {canonical(str(u)) for p in group for u in p.get('outside_scope_urls', []) if u}
        extracted = {canonical(str(u)) for u in parsed.get(partition, set()) if u}
        totals = {n for p in group for n in p['advertised_totals']}
        lasts = {n for p in group for n in p['advertised_last_pages']}
        indices = {p['page_index'] for p in group}
        first = 0 if source in {'agrasc', 'cessions_etat', 'info_encheres'} else 1
        missing_pages = sorted(set(range(first, max(lasts) + 1)) - indices) if lasts else []
        # Avoventes exposes amicable sales on the same page. They are an
        # explicit outside-of-scope part of the public proof, so a parser may
        # see them without making the judicial catalogue incomplete.
        scoped_extracted = extracted - outside
        discovered.update(scoped_extracted)
        required = urls or scoped_extracted
        omitted = sorted(urls - scoped_extracted)
        extra = sorted(scoped_extracted - urls) if urls else []
        expected = next(iter(totals)) - len(outside) if len(totals) == 1 else None
        count_proof = expected is not None and expected == len(scoped_extracted)
        public_records = {r for p in group for r in p.get('public_record_ids', [])}
        extracted_records = (parsed_records or {}).get(partition, set())
        source_rows = sum({p['page_index']: p.get('card_nodes', 0) for p in group}.values())
        if source == 'licitor':
            count_proof = bool(expected is not None and expected == source_rows
                               and public_records == extracted_records)
        page_proof = bool(lasts and len(lasts) == 1 and not missing_pages and urls and urls == scoped_extracted)
        reasons = []
        if len(totals) > 1:
            reasons.append('advertised_total_changed_or_ambiguous')
        if omitted:
            reasons.append('public_announcements_not_parsed')
        if extra:
            reasons.append('parsed_announcements_not_in_public_cards')
        if any(p['unlinked_cards'] for p in group):
            reasons.append('public_cards_without_identifiers')
        if missing_pages:
            reasons.append('advertised_pages_not_fetched')
        if not count_proof and not page_proof:
            reasons.append('no_matching_total_or_terminal_page_proof')
        unlinked = {r['id']: r for p in group for r in p.get('unlinked_records', [])}
        certified = not reasons and bool(count_proof or page_proof)
        addressable_certified = bool(certified or (reasons == ['public_cards_without_identifiers']
                                                  and unlinked and all(r['sold'] for r in unlinked.values())
                                                  and (count_proof or page_proof)))
        partition_exclusions = {
            url: reason for url, reason in effective_exclusions.items()
            if url in required or url in outside or url in extracted
        }
        partition_emitted = emitted & (required | outside | extracted)
        partition_unhandled = required - partition_emitted - set(partition_exclusions)
        unhandled_urls.update(partition_unhandled)
        partitions.append({'partition': partition, 'certified': certified,
                           'addressable_inventory_certified': addressable_certified,
                           'unlinked_public_cards': list(unlinked.values()),
                           'basis': 'advertised_total' if count_proof else 'advertised_terminal_page_and_all_public_cards' if page_proof else None,
                           'advertised_totals': sorted(totals), 'outside_scope_count': len(outside),
                           'public_unique_urls': len(urls), 'parsed_unique_urls': len(scoped_extracted),
                           'public_parsed_urls': sorted(extracted),
                           'returned_validated_urls': sorted(partition_emitted),
                           'excluded_urls': [{'url': url, 'reason': partition_exclusions[url]}
                                             for url in sorted(partition_exclusions)],
                           'unhandled_urls': sorted(partition_unhandled),
                           'public_records': len(public_records), 'parsed_records': len(extracted_records),
                           'source_rows_seen': source_rows,
                           'identical_repeated_rows': max(0, source_rows - len(public_records)) if source == 'licitor' else None,
                           'visited_page_indices': sorted(indices), 'advertised_last_pages': sorted(lasts),
                           'missing_page_indices': missing_pages, 'omitted_urls': omitted,
                           'extra_urls': extra, 'reasons': reasons})
    if source == 'notaires':
        discovery = coverage.get('coverage_complete') is True
        discovered = set(emitted)
    else:
        discovery = bool(partitions) and all(p['certified'] for p in partitions)
    discovery = bool(discovery and not errors and not budget_exhausted)
    not_emitted = unhandled_urls
    scope_value = scope if scope is not None else (
        'Public catalogue exposed by the configured listing pages at audit time; '
        'not private inventory, field completeness or database persistence.'
    )
    discovery = bool(discovery and not invalid_exclusion_urls)
    all_handled = bool(discovery and not unhandled_urls and not invalid_exclusion_urls)
    return {'scope': scope_value,
            'scope_detail': scope_value,
            'public_discovery_certified': discovery,
            'addressable_public_inventory_certified': bool((discovery or (partitions and all(p['addressable_inventory_certified'] for p in partitions))) and not errors and not budget_exhausted),
            'all_discovered_announcements_emitted': all_handled,
            'database_completeness_certified': False,
            'discovered_but_not_emitted_count': len(not_emitted),
            'discovered_but_not_emitted_urls': sorted(not_emitted),
            'public_parsed_urls': sorted(parsed_urls_all),
            'returned_validated_urls': sorted(emitted),
            'excluded_urls': [{'url': url, 'reason': effective_exclusions[url]}
                             for url in sorted(effective_exclusions)],
            'unhandled_public_urls': sorted(unhandled_urls),
            'invalid_exclusion_urls': invalid_exclusion_urls,
            'partitions': partitions}


class CatalogueEvidence:
    """Use the same independent public-card proof during normal collection."""

    def __init__(self, source: str):
        self.source = source
        self.pages = []
        self.parsed = {}
        self.records = {}

    def observe(self, body: str, url: str, rows: list[dict], partition: str | None = None) -> dict:
        proof = public_page_proof(self.source, body, url, partition=partition)
        self.pages.append(proof)
        partition = proof['partition']
        self.parsed.setdefault(partition, set()).update(canonical(str(r['source_url'])) for r in rows if r.get('source_url'))
        self.records.setdefault(partition, set()).update(record_id(str(r['source_url']), lot['raw_text'])
            for r in rows for lot in r.get('source_lots', []) if r.get('source_url') and lot.get('raw_text'))
        return proof

    def metrics(
        self,
        rows: list[dict],
        errors: list[str],
        coverage: dict | None = None,
        budget_exhausted: bool = False,
        exclusions: Mapping[str, str] | list[dict[str, str]] | None = None,
        scope: Any = None,
    ) -> dict:
        certificate = certify_catalogue(
            self.source,
            self.pages,
            self.parsed,
            {canonical(str(r['source_url'])) for r in rows if r.get('source_url')},
            errors,
            budget_exhausted,
            coverage or {},
            self.records,
            exclusions=exclusions,
            scope=scope,
        )
        pagination_complete = coverage is None or coverage.get('coverage_complete') is not False
        if not pagination_complete:
            certificate['coverage_gate_failed'] = {
                'coverage_complete': coverage.get('coverage_complete'),
                'stop_reason': coverage.get('stop_reason'),
            }
            certificate['public_discovery_certified'] = False
            certificate['addressable_public_inventory_certified'] = False
            certificate['all_discovered_announcements_emitted'] = False
        return {'certificate': certificate, 'coverage_complete': bool(
            pagination_complete and certificate['all_discovered_announcements_emitted'])}
