"""Local handoff utilities. Secrets stay in a private file, never command arguments."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from src.sources.licitor_cloud import connect_store
from src.sources.licitor_cloud_import import import_snapshot, snapshot_archive
from src.sources.licitor_history import licitor_window_start


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("db-check")
    commands.add_parser("start-window-backfill")
    configure = commands.add_parser("configure-vercel")
    configure.add_argument("--directory", type=Path, required=True)
    configure.add_argument("--replace", action="store_true", help="Explicitly replace these two collector-only secrets")
    request = commands.add_parser("request")
    request.add_argument("--base-url", required=True)
    request.add_argument("--endpoint", choices=("status", "tick", "monthly"), default="status")
    transfer = commands.add_parser("import")
    transfer.add_argument("--archive", type=Path, required=True)
    transfer.add_argument("--snapshot", type=Path, required=True)
    transfer.add_argument("--run-id", default="backfill-2026-08-28")
    args = parser.parse_args()
    if args.credentials.stat().st_mode & 0o077:
        raise ValueError("Credential file must be owner-only (0600)")
    credentials = json.loads(args.credentials.read_text())
    if set(credentials) != {"LICITOR_DATABASE_URL", "CRON_SECRET"}:
        raise ValueError("Unexpected credential names")
    os.environ.update(credentials)
    if args.command == "configure-vercel":
        for key, value in credentials.items():
            result = subprocess.run(
                [
                    "npx",
                    "--yes",
                    "vercel@56.2.0",
                    "env",
                    "add",
                    key,
                    "production",
                    "--sensitive",
                    "--scope",
                    "antoine-s-projects7",
                    "--cwd",
                    str(args.directory.resolve()),
                    *(["--force"] if args.replace else []),
                ],
                input=value,
                text=True,
                capture_output=True,
                check=False,
            )
            output = result.stdout + result.stderr
            for secret in credentials.values():
                output = output.replace(secret, "[REDACTED]")
            print(output, flush=True)
            if result.returncode:
                raise RuntimeError("Vercel environment configuration failed")
        return
    if args.command == "request":
        parsed = urlsplit(args.base_url)
        if parsed.scheme != "https" or not (parsed.hostname or "").endswith(".vercel.app") or parsed.username:
            raise ValueError("Expected the dedicated HTTPS Vercel deployment")
        response = httpx.get(
            args.base_url.rstrip("/") + "/api/" + args.endpoint,
            headers={"Authorization": "Bearer " + credentials["CRON_SECRET"]},
            timeout=280,
            follow_redirects=False,
        )
        print("HTTP", response.status_code)
        if response.headers.get("content-type", "").startswith("application/json"):
            print(json.dumps(response.json(), ensure_ascii=False))
        if response.status_code != 200:
            raise RuntimeError("Collector health check failed")
        return
    if args.command == "import":
        snapshot_archive(args.archive, args.snapshot)
    store = connect_store()
    try:
        if args.command == "start-window-backfill":
            with store.db.transaction():
                control = store.one("select * from licitor_ingestion.control where singleton for update")
                if control["enabled"] or (control["lease_until"] and control["lease_until"] > datetime.now(UTC)):
                    raise ValueError("Disable collection and wait for the lease before changing campaigns")
                today = datetime.now(UTC).date()
                run_id = f"backfill-three-years-{today.isoformat()}"
                store.db.execute("""update licitor_ingestion.runs set status='paused',
                    stop_reason='superseded_by_three_year_window',updated_at=now()
                    where id='backfill-2026-08-28' and status in ('ready','running','paused')""")
                created = store.create_run(run_id, "backfill", licitor_window_start(today), 20000)
                if created:
                    # Fresh lists cover results published during the maintenance pause;
                    # existing detail captures remain reusable without another download.
                    store.db.execute("update licitor_ingestion.tasks set refresh=true where run_id=%s and kind='index'", (run_id,))
                report = {"run_id": run_id, "created": created, "cutoff": licitor_window_start(today)}
        elif args.command == "import":
            report = import_snapshot(store, args.snapshot, args.run_id)
        else:
            report = {"role": store.one("select current_user as name")["name"], **store.summary()}
        print(json.dumps(report, ensure_ascii=False, default=str))
    finally:
        store.db.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Database/HTTP exceptions can contain URLs or secrets. No traceback here.
        message = str(error)
        for secret in (
            os.environ.get("LICITOR_DATABASE_URL"),
            os.environ.get("CRON_SECRET"),
            urlsplit(os.environ.get("LICITOR_DATABASE_URL", "")).password,
        ):
            if secret:
                message = message.replace(secret, "[REDACTED]")
        print("Collector administration failed:", type(error).__name__, message[:500])
        raise SystemExit(1) from None
