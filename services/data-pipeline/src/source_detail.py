"""Read one public source detail using the existing adapters and access rules."""
from __future__ import annotations

import importlib
from urllib.parse import urlsplit

from src.sources.cessions_etat import cessions_tls_context
from src.sources.common import PoliteHttpClient, is_allowed_origin_url


def fetch_public_detail(source: str, source_url: str, settings: dict, clients: dict):
    module = importlib.import_module('src.sources.' + source)
    endpoint = source_url
    parser = getattr(module, 'parse_' + source + '_detail_html', None)
    base = module.BASE_URL
    if source == 'notaires':
        marker = urlsplit(endpoint).path.rstrip('/').split('/')[-1]
        if not marker.isdigit():
            raise ValueError('Unsupported notarial URL identity')
        endpoint = module._detail_api_url({'external_id': marker})
        def parser(body, url, listing_url=source_url):
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
            tls_context=cessions_tls_context() if source == "cessions_etat" else None,
            accept="application/json,text/plain,*/*" if source == "notaires" or (source == "agrasc" and "pub-services" in endpoint) else "text/html,*/*")
        if source == 'licitor':
            rules = module.RobotsRules.parse(clients[base].get(base + '/robots.txt'), str(settings['user_agent']))
            clients[base].audit_robots = rules
    client = clients[base]
    if source == 'licitor' and not client.audit_robots.can_fetch(endpoint):
        raise ValueError('Robots access refused')
    body = client.get(endpoint)
    raw = parser(body, endpoint)
    return endpoint, body, raw


def prepare_source_revision(existing, raw: dict):
    """Reconcile a verified detail without losing identity or advancing a DB lease."""
    from src.freshness import record_source_checks
    from src.main import _finalize_sale_for_app, _preserve_known_enrichment_payloads
    from src.normalize import normalize_sale
    from src.publication_identity import conflicting_identity, merge_revision

    fetched_url = str(raw.get('source_url') or '')
    if not fetched_url or raw.get('_detail_fetch_failed'):
        raise ValueError('Source detail was not verified')
    known = {fetched_url: existing.to_storage_dict()}
    _preserve_known_enrichment_payloads([raw], known)
    record_source_checks([raw], known)
    incoming = normalize_sale(raw)
    incoming.last_run_id = existing.last_run_id
    _finalize_sale_for_app(incoming, geocode=False)
    if conflicting_identity(existing, incoming):
        result = existing.model_copy(deep=True)
        result.status = 'quarantined'
        result.quality_flags = sorted(set(result.quality_flags) | {'property_identity_conflict'})
        result.raw_payload['publication_identity_conflict'] = {
            'source_url': fetched_url, 'reason': 'verified_detail_identity_conflict',
            'incoming_address': incoming.address, 'incoming_lot': incoming.raw_payload.get('lot_number'),
        }
    else:
        result = merge_revision(existing, incoming)
    # This version is compared under the existing publication row lock.
    result.updated_at = existing.updated_at
    for key, value in existing.raw_payload.items():
        if key.startswith('qualification_'):
            result.raw_payload.setdefault(key, value)
    return result


def publish_source_revision(sale, job: dict, settings: dict) -> bool:
    """Commit a verified existing revision and its owned job atomically.

    A verified past date must reach retention even though new expired listings
    are inadmissible. This path therefore checks both the task lease and the
    existing catalogue version before using the shared table writer.
    """
    from src.storage import supabase_client as storage

    with storage._postgres_connect(str(settings['supabase_db_url'])) as db:
        db.execute("set local lock_timeout = '15s'")
        db.execute("set local statement_timeout = '120s'")
        db.execute("select pg_advisory_xact_lock(hashtextextended('immojudis:outcome_catalogue_bridge:v1',0))")
        owned = db.execute("""select id from public.auction_enrichment_jobs
          where id=%s and source_url=%s and job_type='source_detail' and status='running'
            and attempt_count=%s and locked_at>=now()-interval '30 minutes' for update""",
          (job['id'], sale.source_url, job['attempt_count'])).fetchone()
        if not owned:
            return False
        if not storage._guard_enrichment_revision(db, [sale]):
            db.execute("""update public.auction_enrichment_jobs set status='cancelled',locked_at=null,
              last_error='Catalogue revision changed during source verification',updated_at=now() where id=%s""",
              (job['id'],))
            return False
        db.execute("select set_config('app.pipeline_queue_owner', 'python', true)")
        token = storage._PUBLICATION_CONNECTION.set(db)
        try:
            storage._write_sale_revisions([sale], settings, refresh_last_seen=False)
            db.execute("""update public.auction_enrichment_jobs set status='completed',locked_at=null,
              last_error=null,completed_at=now(),updated_at=now() where id=%s""", (job['id'],))
        finally:
            storage._PUBLICATION_CONNECTION.reset(token)
    return True
