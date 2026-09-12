"""Read-only backlog and coverage reporting for scheduled pipeline runs."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from src.config import load_settings
from src.storage.supabase_client import _postgres_connect


def main(*, report_only: bool = False) -> int:
    settings = load_settings()
    if not settings.get("supabase_db_url"):
        raise RuntimeError("Pipeline health requires SUPABASE_DB_URL")
    with _postgres_connect(str(settings["supabase_db_url"])) as connection:
        connection.execute("set transaction read only")
        rows = connection.execute("""
            select job_type, status, count(*),
                   count(*) filter (where attempt_count >= max_attempts and status in ('queued', 'running', 'failed')),
                   count(*) filter (where status in ('queued', 'running', 'failed') and created_at < now() - interval '48 hours')
            from public.auction_enrichment_jobs
            group by job_type, status order by job_type, status
        """).fetchall()
        report = {"queue": [dict(zip(("type", "status", "count", "exhausted", "overdue"), row, strict=True)) for row in rows]}
        latest = connection.execute("""
            select status, summary->'scrape_coverage', summary->'stage_status'
            from public.auction_runs where source <> 'llm-description-backfill'
            order by created_at desc limit 1
        """).fetchone()
        if latest:
            report["latest_collection"] = dict(zip(("status", "coverage", "stages"), latest, strict=True))
        report["stalled_runs"] = connection.execute("""
            select count(*) from public.auction_runs where status = 'running'
            and coalesce(started_at, created_at) < now() - interval '100 minutes'
        """).fetchone()[0]
        sources = connection.execute("""
            select source_name, count(*),
                count(*) filter (where sale_date >= now()),
                count(*) filter (where sale_date >= now() and nullif(btrim(raw_payload->>'llm_display_description'), '') is null),
                count(*) filter (where sale_date >= now() and last_seen_at < now() - interval '7 days'),
                max(last_seen_at)
            from public.auction_sales group by source_name order by source_name
        """).fetchall()
        report["sources"] = [dict(zip(("source", "total", "future", "missing_synthesis", "stale", "last_seen"), row, strict=True)) for row in sources]
    failed = health_failed(report)
    report["global_health_status"] = "degraded" if failed else "healthy"
    output = json.dumps(report, ensure_ascii=False, indent=2, default=str)
    print(output)
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as handle:
            handle.write("\n### Pipeline coverage and backlog\n```json\n" + output + "\n```\n")
    if failed and report_only:
        print("::warning::Global pipeline health is degraded; see the backlog report and operational incidents. Collection status is reported separately.")
    return int(failed and not report_only)


def health_failed(report: dict) -> bool:
    latest = report.get("latest_collection") or {}
    return bool(
        report.get("stalled_runs")
        or any(row["exhausted"] or row["overdue"] for row in report["queue"])
        or any(row["stale"] for row in report.get("sources", []))
        or latest.get("status") == "failed"
        or (latest.get("stages") or {}).get("collection") in {"failed", "partial"}
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-only", action="store_true", help="Report global incidents without changing this collection run result")
    raise SystemExit(main(report_only=parser.parse_args().report_only))
