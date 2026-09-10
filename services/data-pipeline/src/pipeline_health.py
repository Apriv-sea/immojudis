"""Read-only backlog and coverage reporting for scheduled pipeline runs."""
from __future__ import annotations

import json
import os
from pathlib import Path

from src.config import load_settings
from src.storage.supabase_client import _postgres_connect


def main() -> int:
    settings = load_settings()
    if not settings.get("supabase_db_url"):
        raise RuntimeError("Pipeline health requires SUPABASE_DB_URL")
    with _postgres_connect(str(settings["supabase_db_url"])) as connection:
        connection.execute("set transaction read only")
        rows = connection.execute("""
            select job_type, status, count(*),
                   count(*) filter (where attempt_count >= max_attempts and status <> 'completed'),
                   count(*) filter (where status <> 'completed' and created_at < now() - interval '48 hours')
            from public.auction_enrichment_jobs
            where input_hash like 'pipeline_v2:%'
            group by job_type, status order by job_type, status
        """).fetchall()
        report = {"queue": [dict(zip(("type", "status", "count", "exhausted", "overdue"), row, strict=True)) for row in rows]}
        latest = connection.execute("""
            select status, summary->'scrape_coverage', summary->'stage_status'
            from public.auction_runs where summary ? 'scrape_coverage'
            order by created_at desc limit 1
        """).fetchone()
        if latest:
            report["latest_collection"] = dict(zip(("status", "coverage", "stages"), latest, strict=True))
    output = json.dumps(report, ensure_ascii=False, indent=2, default=str)
    print(output)
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as handle:
            handle.write("\n### Pipeline coverage and backlog\n```json\n" + output + "\n```\n")
    return int(any(row["exhausted"] or row["overdue"] for row in report["queue"]))


if __name__ == "__main__":
    raise SystemExit(main())
