"""Read-only, bounded source verification of the frozen 100-listing sample.

Differences are candidates for review, never automatic assertions that a source
or a PDF is wrong. A parser agreement alone cannot certify document-derived facts.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from psycopg.rows import dict_row

from src.config import load_settings
from src.normalize import normalize_sale
from src.sources.common import PoliteHttpClient, is_allowed_origin_url
from src.storage.supabase_client import _postgres_connect

FIELDS = ('address', 'city', 'postal_code', 'sale_date', 'starting_price_eur',
          'habitable_surface_m2', 'carrez_surface_m2', 'land_surface_m2', 'occupancy_status')
SAMPLE = Path(__file__).resolve().parents[1] / 'config/qualification-sample-20260912.json'


def compare_fields(stored: dict, extracted: dict) -> dict:
    results = {}
    for field in FIELDS:
        before, after = stored.get(field), extracted.get(field)
        if before in (None, '', 'unknown') or after in (None, '', 'unknown'):
            state = 'unverified'
        elif field.endswith('_m2') or field == 'starting_price_eur':
            state = 'matched' if abs(float(before) - float(after)) < 0.01 else 'difference'
        elif field == 'sale_date':
            a = datetime.fromisoformat(str(before).replace('Z', '+00:00'))
            b = datetime.fromisoformat(str(after).replace('Z', '+00:00'))
            state = 'matched' if a == b else 'difference'
        else:
            state = 'matched' if str(before).casefold().strip() == str(after).casefold().strip() else 'difference'
        results[field] = {'state': state, 'stored': before, 'source_extraction': after}
    return results


def audit_source(source: str, output: Path, sample: Path = SAMPLE) -> None:
    targets = [row for row in json.loads(sample.read_text()) if row['source_name'] == source]
    if not targets:
        raise ValueError('Source outside the frozen sample')
    settings = load_settings()
    # Fail closed: this connection cannot write even if future audit code changes.
    with _postgres_connect(str(settings['supabase_db_url'])) as db:
        db.execute('set transaction read only')
        with db.cursor(row_factory=dict_row) as cursor:
            cursor.execute('select * from public.auction_sales where id=any(%s::uuid[])', ([row['id'] for row in targets],))
            stored = {str(row['id']): row for row in cursor.fetchall()}
    module = importlib.import_module('src.sources.' + source)
    clients = {}
    records = [{**target, 'status': 'unverified', 'reason': 'not_attempted'} for target in targets]
    def save_report():
        report = {'source': source, 'sample_file': sample.name, 'checked_at': datetime.now(UTC).isoformat(), 'scope':
            'Frozen sample; read-only source fetch and comparison. PDF evidence is stored provenance, not independently revalidated here.',
            'rows': records}
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str))
        temporary.replace(output)
    save_report()
    for target, record in zip(targets, records, strict=True):
        record.update(checked_at=datetime.now(UTC).isoformat(), reason='verification_in_progress_or_interrupted')
        save_report()
        row = stored.get(target['id'])
        if row is None:
            record['reason'] = 'not_in_current_catalogue; retention evidence must be checked separately'
            save_report()
            continue
        record['stored_status'] = row.get('status')
        payload = row.get('raw_payload') or {}
        record['known_conflicts'] = payload.get('source_conflicts') or []
        record['procedure_issues'] = (row.get('sale_procedure') or {}).get('verification', {}).get('issues', [])
        record['document_evidence'] = {key: payload.get(key) for key in
            ('document_analysis', 'surface_extraction', 'land_surface_extraction', 'starting_price_extraction')}
        record['documents'] = row.get('documents') or []
        try:
            endpoint = target['source_url']
            parser = getattr(module, 'parse_' + source + '_detail_html', None)
            base = module.BASE_URL
            if source == 'notaires':
                marker = urlsplit(endpoint).path.rstrip('/').split('/')[-1]
                if not marker.isdigit():
                    raise ValueError('Unsupported notarial URL identity')
                endpoint = module._detail_api_url({'external_id': marker})
                def parser(body, url, listing_url=target['source_url']):
                    return module.parse_notaires_detail_json(body, fallback={'source_url': listing_url})
            elif source == 'agrasc':
                from src.sources.agrasc_operators import (
                    AGORA_ORIGIN,
                    IMMO_ORIGIN,
                    parse_agora_operator_detail,
                    parse_immo_operator_json,
                )
                from src.sources.notaires import API_URL, BASE_URL
                if is_allowed_origin_url(endpoint, (AGORA_ORIGIN,)):
                    base, parser = AGORA_ORIGIN, parse_agora_operator_detail
                elif is_allowed_origin_url(endpoint, (IMMO_ORIGIN,)):
                    marker = urlsplit(endpoint).path.rstrip('/').split('/')[-1]
                    if not marker.isdigit():
                        raise ValueError('Unsupported operator identity')
                    base, endpoint = BASE_URL, f'{API_URL}/{marker}'
                    def parser(body, url, expected_id=marker):
                        return parse_immo_operator_json(body, expected_id)
                else:
                    raise ValueError('Unsupported operator: document review required')
            if not endpoint or not parser or not is_allowed_origin_url(endpoint, (base,)):
                raise ValueError('Unsupported source endpoint')
            if base not in clients:
                clients[base] = PoliteHttpClient(base_url=base, user_agent=str(settings['user_agent']),
                    delay_seconds=1, timeout_seconds=30,
                    accept="application/json,text/plain,*/*" if source == "notaires" or (source == "agrasc" and "pub-services" in endpoint) else "text/html,*/*")
                if source == 'licitor':
                    rules = module.RobotsRules.parse(clients[base].get(base + '/robots.txt'), str(settings['user_agent']))
                    clients[base].audit_robots = rules
            client = clients[base]
            if source == 'licitor' and not client.audit_robots.can_fetch(endpoint):
                raise ValueError('Robots access refused')
            body = client.get(endpoint)
            raw = parser(body, endpoint)
            extracted = normalize_sale({**raw, 'source_name': source, 'source_url': target['source_url']}).to_storage_dict()
            record.update(status='review_required', endpoint=endpoint,
                response_sha256=hashlib.sha256(body.encode()).hexdigest(),
                source_text=str(raw.get('raw_text') or raw.get('description') or '')[:30000],
                source_lots=raw.get('source_lots'), source_documents=raw.get('documents'),
                checks=compare_fields(row, extracted))
            record.pop('reason', None)
        except Exception as exc:
            record['reason'] = str(exc)[:1200]
        save_report()
    print(json.dumps({'source': source, 'sample_count': len(records),
                      'source_fetched': sum(row['status'] == 'review_required' for row in records)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--sample', type=Path, default=SAMPLE)
    args = parser.parse_args()
    audit_source(args.source, args.output, args.sample)
