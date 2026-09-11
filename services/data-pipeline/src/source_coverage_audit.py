"""Manual, read-only inventory audit: no database, documents, or LLM calls."""
from __future__ import annotations

import argparse
import hashlib
import importlib
import inspect
import json
import os
import time
from contextlib import ExitStack
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from src.catalogue_proof import canonical, certify_catalogue, public_page_proof, record_id

SOURCES = ('avoventes', 'licitor', 'vench', 'info_encheres', 'encheres_publiques',
           'petites_affiches', 'cessions_etat', 'agrasc', 'encheres_immobilieres', 'notaires')


def page_evidence(body: str, url: str) -> dict:
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    if isinstance(data, dict) and 'nbTotalAnnonces' in data:
        return {'kind': 'api', 'advertised_total': data.get('nbTotalAnnonces'),
                'advertised_pages': data.get('nbPages'), 'page': data.get('page'),
                'raw_rows': len(data.get('annonceResumeDto') or [])}
    soup = BeautifulSoup(body, 'html.parser')
    pagination = []
    for a in soup.select('a[href]'):
        href = str(a['href'])
        if ('next' in (a.get('rel') or []) or any(marker in href for marker in ('?page=', '&page=', '?p=', '&p=', 'snr=', 'debut_', '/page/'))):
            pagination.append(urljoin(url, href))
    return {'kind': 'html', 'pagination_links': sorted(set(pagination)),
            'title': soup.title.get_text(' ', strip=True) if soup.title else None,
            'body_text_preview': soup.get_text(' ', strip=True)[:300]}


def run_audit(source: str, output: Path, *, max_pages: int = 100,
              max_requests: int = 300, max_seconds: int = 600, resolve_missing_locations: bool = False) -> dict:
    if source not in SOURCES or not 1 <= max_pages <= 150 or not 1 <= max_requests <= 500 or not 1 <= max_seconds <= 900:
        raise ValueError('Invalid source or audit budget')
    # Configuration is read after clearing credentials. No enrichment runner is imported.
    for key in ('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'REPLICATE_API_TOKEN'):
        os.environ[key] = ''
    os.environ.update(LLM_ENABLED='false', TARGET_DEPARTMENTS='all', REQUEST_TIMEOUT_SECONDS='15', REQUEST_DELAY_SECONDS='1')
    module = importlib.import_module('src.sources.' + source)
    collector = getattr(module, 'scrape_' + source + '_aquitaine_result')
    started = time.monotonic()
    trace: list[dict] = []
    proofs: list[dict] = []
    parsed: dict[str, set[str]] = {}
    parsed_records: dict[str, set[str]] = {}
    skipped_details = 0
    location_details = 0
    in_detail = False
    original_detail = getattr(module, "_enrich_sale_from_detail", None)
    budget_exhausted = False
    original_send = httpx.Client.send

    def send(client, request, **kwargs):
        nonlocal budget_exhausted
        # The outer request represents the source response. Counting the inner
        # relay request too duplicates pages and assigns them a Supabase URL.
        if str(request.url) == os.environ.get('SOURCE_FETCH_RELAY_URL'):
            return original_send(client, request, **kwargs)
        if len(trace) >= max_requests or time.monotonic() - started >= max_seconds:
            budget_exhausted = True
            raise RuntimeError('AUDIT_BUDGET_EXHAUSTED')
        entry = {'url': str(request.url), 'method': request.method}
        trace.append(entry)
        try:
            response = original_send(client, request, **kwargs)
            entry['status'] = response.status_code
            entry['response_headers'] = {key: response.headers[key] for key in
                                         ('server', 'cf-mitigated', 'content-type', 'retry-after', 'x-sb-edge-region') if key in response.headers}
            if response.status_code in {401, 403, 429} and not kwargs.get('stream'):
                block = BeautifulSoup(response.text, 'html.parser')
                entry['refusal_title'] = block.title.get_text(' ', strip=True) if block.title else None
                entry['refusal_text'] = block.get_text(' ', strip=True)[:350]
            if not kwargs.get('stream'):
                entry['sha256'] = hashlib.sha256(response.content).hexdigest()
                entry['bytes'] = len(response.content)
                if response.status_code == 200 and not request.url.path.endswith('/robots.txt') and not in_detail:
                    entry['evidence'] = page_evidence(response.text, str(request.url))
                    proof = public_page_proof(source, response.text, str(request.url))
                    entry['catalogue_proof'] = proof
                    proofs.append(proof)
            return response
        except Exception as exc:
            entry['error'] = str(exc)[:250]
            raise

    def skip_detail(*args, **kwargs):
        nonlocal skipped_details, location_details, in_detail
        if resolve_missing_locations and source == 'avoventes' and len(args) > 1 and not args[1].get('department'):
            location_details += 1
            in_detail = True
            try:
                return original_detail(*args, **kwargs)
            finally:
                in_detail = False
        skipped_details += 1
        return True

    def observe_parser(original):
        def wrapper(*args, **kwargs):
            rows = original(*args, **kwargs)
            if proofs:
                partition = proofs[-1]['partition']
                parsed.setdefault(partition, set()).update(canonical(str(r['source_url'])) for r in rows if r.get('source_url'))
                parsed_records.setdefault(partition, set()).update(
                    record_id(str(r['source_url']), lot['raw_text']) for r in rows
                    for lot in r.get('source_lots', []) if r.get('source_url') and lot.get('raw_text'))
            return rows
        return wrapper

    result = None
    fatal = None
    with ExitStack() as stack:
        stack.enter_context(patch.object(httpx.Client, 'send', send))
        for name in ('_enrich_sale_from_detail', 'enrich_agrasc_operator'):
            if hasattr(module, name):
                stack.enter_context(patch.object(module, name, skip_detail))
        parser_names = {
            'avoventes': 'parse_avoventes_html', 'licitor': 'parse_licitor_list_sales',
            'vench': 'parse_vench_list_html', 'info_encheres': 'parse_info_encheres_list_html',
            'agrasc': 'parse_agrasc_html', 'petites_affiches': 'parse_petites_affiches_html',
            'cessions_etat': 'parse_cessions_etat_html', 'encheres_immobilieres': 'parse_encheres_immobilieres_html',
        }
        if source in parser_names:
            name = parser_names[source]
            stack.enter_context(patch.object(module, name, observe_parser(getattr(module, name))))
        arguments = {'max_pages': max_pages} if 'max_pages' in inspect.signature(collector).parameters else {}
        if source == 'licitor':
            arguments['fetch_details'] = False
        try:
            result = collector(**arguments)
        except Exception as exc:
            fatal = str(exc)[:500]
    sales = result.sales if result else []
    coverage = result.coverage if result else {}
    errors = result.errors if result else [fatal]
    certificate = certify_catalogue(source, proofs, parsed,
                                    {canonical(str(s['source_url'])) for s in sales},
                                    errors, budget_exhausted, coverage, parsed_records)
    report = {
        'certificate': certificate,
        'parser_record_ids': {key: sorted(value) for key, value in parsed_records.items()},
        'source': source, 'utc': datetime.now(UTC).isoformat(),
        'scope': 'national configured inventory; listing pages and optional missing-location details; no DB, PDF or AI',
        'location_details_requested': location_details,
        'budgets': {'pages_per_partition': max_pages, 'requests': max_requests, 'seconds': max_seconds},
        'budget_exhausted': budget_exhausted, 'duration_seconds': round(time.monotonic() - started, 2),
        'listings_emitted': len(sales), 'unique_listing_urls': len({s.get('source_url') for s in sales}),
        'details_skipped': skipped_details, 'coverage': coverage,
        'audit_status': 'budget_exhausted' if budget_exhausted else 'source_error' if errors else 'inspected',
        'inventory_certified': certificate['all_discovered_announcements_emitted'],
        'error_count': len(errors), 'errors': errors[:20], 'requests': trace,
        'inventory': [{'url': s.get('source_url'), 'external_id': s.get('external_id'),
                       'department': s.get('department'), 'sale_date': s.get('sale_date')} for s in sales],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    print(json.dumps({key: report[key] for key in ('source', 'utc', 'audit_status', 'unique_listing_urls', 'inventory_certified', 'error_count', 'budget_exhausted', 'duration_seconds')}, ensure_ascii=False))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=SOURCES, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resolve-missing-locations', action='store_true')
    parser.add_argument('--max-pages', type=int, default=100)
    parser.add_argument('--max-requests', type=int, default=300)
    parser.add_argument('--max-seconds', type=int, default=600)
    args = parser.parse_args()
    run_audit(args.source, args.output, max_pages=args.max_pages,
              max_requests=args.max_requests, max_seconds=args.max_seconds,
              resolve_missing_locations=args.resolve_missing_locations)


if __name__ == '__main__':
    main()
