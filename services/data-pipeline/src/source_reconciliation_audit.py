"""Read-only public-page evidence for the remaining unexplained inventory URLs."""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

from src.sources.cessions_etat import cessions_tls_context
from src.sources.common import PoliteHttpClient, is_allowed_origin_url

TARGETS = Path(__file__).resolve().parents[1] / 'config/reconciliation-remaining-20260912.json'
ORIGINS = {'avoventes':'https://avoventes.fr', 'cessions_etat':'https://cessions.immobilier-etat.gouv.fr',
           'agrasc':'https://www.agorastore-immo.fr', 'info_encheres':'https://www.info-encheres.com'}


def audit(source: str, output: Path) -> None:
    rows = [{**r,'status':'not_attempted'} for r in json.loads(TARGETS.read_text()) if r['source_name']==source]
    if source not in ORIGINS or not rows:
        raise ValueError('Source outside the frozen reconciliation scope')
    base = ORIGINS[source]
    client = PoliteHttpClient(base_url=base,user_agent='Immojudis source qualification',delay_seconds=1,timeout_seconds=20,
        tls_context=cessions_tls_context() if source == 'cessions_etat' else None)
    output.parent.mkdir(parents=True,exist_ok=True)

    def save():
        temporary = output.with_suffix('.tmp')
        temporary.write_text(json.dumps({'source':source,'scope':'Read-only public pages; no automatic admission or expiration decision',
            'rows':rows},ensure_ascii=False,indent=2))
        temporary.replace(output)

    save()
    denied = 0
    for row in rows:
        if denied >= 2:
            row.update(status="unverified", reason="source_access_denied_circuit_open")
            save()
            continue
        row.update(status='in_progress_or_interrupted',checked_at=datetime.now(UTC).isoformat())
        save()
        try:
            if not is_allowed_origin_url(row['source_url'],(base,)):
                raise ValueError('Unexpected source origin')
            body = client.get(row['source_url'])
            if source == 'agrasc':
                from src.sources.agrasc_operators import parse_agora_operator_detail
                row['operator_details'] = parse_agora_operator_detail(body, row['source_url'])
            soup = BeautifulSoup(body,'html.parser')
            for node in soup(['script','style','select','nav','footer']):
                node.decompose()
            row.update(status='review_required',response_sha256=hashlib.sha256(body.encode()).hexdigest(),
                title=soup.title.get_text(' ',strip=True) if soup.title else None,
                source_text=soup.get_text('\n',strip=True)[:60000])
        except Exception as exc:
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (401, 403):
                denied += 1
            row.update(status='unverified',reason=str(exc)[:1000])
        save()
    print(json.dumps({'source':source,'rows':len(rows),'fetched':sum(r['status']=='review_required' for r in rows)}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True,choices=list(ORIGINS))
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    audit(args.source,args.output)
