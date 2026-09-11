"""Revalidate stored extractions with current checks, without calling an AI provider."""
from __future__ import annotations

import argparse
import json

from src.config import load_settings
from src.enrichment.display_quality import has_current_display
from src.enrichment.extract_structured import apply_cached_llm_extraction_to_sale
from src.storage.supabase_client import fetch_sales_needing_llm_descriptions, upsert_sales_to_supabase


def revalidate_cached_displays(limit: int = 1000) -> dict[str, int]:
    if not 1 <= limit <= 5000:
        raise ValueError('Revalidation limit must be between 1 and 5000')
    version = str(load_settings()['llm_prompt_version'])
    sales = fetch_sales_needing_llm_descriptions(limit=limit, prompt_version=version)
    report = {'selected': len(sales), 'revalidated': 0, 'rejected': 0, 'without_cache': 0, 'persisted': 0}
    for sale in sales:
        if not isinstance(sale.raw_payload.get('llm_extraction'), dict):
            report['without_cache'] += 1
            continue
        before = json.dumps(sale.to_storage_dict(), sort_keys=True, default=str)
        apply_cached_llm_extraction_to_sale(sale, prompt_version=version)
        valid = has_current_display(sale.raw_payload, version)
        report['revalidated' if valid else 'rejected'] += 1
        if before != json.dumps(sale.to_storage_dict(), sort_keys=True, default=str):
            count = upsert_sales_to_supabase([sale], refresh_last_seen=False)
            if count != 1:
                raise RuntimeError('Cached revalidation was not persisted')
            report['persisted'] += count
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limit', type=int, default=1000)
    args = parser.parse_args()
    print(json.dumps(revalidate_cached_displays(args.limit)))


if __name__ == '__main__':
    main()
