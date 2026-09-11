"""Close only this workflow's unfinished run; preserve existing progress."""
from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID

from src.config import load_settings
from src.storage.supabase_client import _postgres_connect


def register_run(run_id: str | None) -> None:
    if run_id and os.getenv('GITHUB_ENV'):
        value = str(UUID(run_id))
        with Path(os.environ['GITHUB_ENV']).open('a') as handle:
            handle.write(f'PIPELINE_CURRENT_RUN_ID={value}\n')


def main() -> int:
    run_id = os.getenv('PIPELINE_CURRENT_RUN_ID') or os.getenv('REQUESTED_RUN_ID')
    if not run_id:
        return 0
    run_id = str(UUID(run_id))
    settings = load_settings()
    if not settings.get('supabase_db_url'):
        raise RuntimeError('Run finalization requires SUPABASE_DB_URL')
    with _postgres_connect(str(settings['supabase_db_url'])) as db:
        db.execute("""
            update public.auction_runs set status = 'failed', finished_at = now(), updated_at = now(),
                summary = coalesce(summary, '{}'::jsonb) || '{"completion_status":"interrupted"}'::jsonb,
                errors = coalesce(errors, '{}'::jsonb) ||
                    '{"runner":["Workflow ended without a completed pipeline run; committed checkpoints are preserved"]}'::jsonb
            where id = %s and status in ('running', 'queued')
        """, (run_id,))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
