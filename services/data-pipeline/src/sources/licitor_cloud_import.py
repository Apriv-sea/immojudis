"""Transfer an immutable SQLite snapshot into the disabled private cloud collector."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sqlite3
from pathlib import Path

from psycopg.types.json import Jsonb

from src.sources.licitor_cloud import connect_store
from src.sources.licitor_cloud_store import CloudStore
from src.sources.licitor_history import LICITOR_HISTORY_CONNECTOR_VERSION
from src.sources.licitor_history_run import announcement_id, json_text


def snapshot_archive(source: Path, destination: Path) -> None:
    if not source.is_file() or destination.exists():
        raise ValueError("Require an existing archive and a NEW snapshot path")
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    # SQLite backup includes committed WAL data while the local collector is running.
    with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as original:
        with sqlite3.connect(destination) as backup:
            original.backup(backup)


def import_snapshot(store: CloudStore, snapshot: Path, run_id: str) -> dict:
    with sqlite3.connect(snapshot.resolve().as_uri() + "?mode=ro", uri=True) as source:
        source.row_factory = sqlite3.Row
        metadata = {r["key"]: json.loads(r["value"]) for r in source.execute("select * from metadata")}
        if metadata.get("parser_version") != LICITOR_HISTORY_CONNECTOR_VERSION:
            raise ValueError("Reparse the local archive with the current parser before transferring")
        captures = [dict(r) for r in source.execute("select * from captures order by captured_at,url")]
        pages = [dict(r) for r in source.execute("select * from index_pages order by page_number,zone")]
        entries = [dict(r) for r in source.execute("select * from index_entries order by page_url,position")]
        announcements = {
            r["announcement_id"]: r["canonical_url"] for r in source.execute("select * from announcements")
        }
        aliases = {r["url"]: r["announcement_id"] for r in source.execute("select * from detail_aliases")}
        details = {r["url"]: r["parser_version"] for r in source.execute("select * from details")}
        lots = [dict(r) for r in source.execute("select * from lots order by external_id")]
        errors = [dict(r) for r in source.execute("select * from errors")]

    # A snapshot can fall between an index commit and alias registration. Preserve
    # that newly discovered work too, without changing any established canonical URL.
    for url in [r["url"] for r in captures if r["kind"] == "detail"] + [r["detail_url"] for r in entries]:
        identity = announcement_id(url)
        aliases.setdefault(url, identity)
        announcements.setdefault(identity, url)
    capture_by_url = {r["url"]: r for r in captures}
    for capture in captures:
        if hashlib.sha256(gzip.decompress(capture["html_gzip"])).hexdigest() != capture["sha256"]:
            raise ValueError("Source capture integrity check failed")
    rows = [json.loads(r["payload"]) for r in lots]
    for row in rows:
        if not (
            row.get("publication_eligible") is False
            and row.get("training_eligible") is False
            and row.get("candidate_grade") == "C"
            and row.get("evidence_grade") == "C"
            and row.get("review_status") == "pending"
        ):
            raise ValueError("Only private, unreviewed candidates may be transferred")

    with store.db.transaction():
        control = store.one("select * from licitor_ingestion.control where singleton for update")
        if not control or control["enabled"] or control["lease_token"]:
            raise ValueError("Disable the cloud collector and wait for its lease before importing")
        if control["authorization_record"] != metadata.get("authorization"):
            raise ValueError("The source and destination authorization records differ")
        existing = store.active_run()
        if existing and existing["id"] != run_id:
            raise ValueError("Another campaign exists; refuse to merge its checkpoints")
        store.create_run(run_id, "backfill", None, 45000)
        run = store.one("select * from licitor_ingestion.runs where id=%s", (run_id,))
        if run["network_requests"] or run["status"] != "ready":
            raise ValueError("Cloud work has already started; never overwrite cloud progress")
        for old in store.db.execute("select id,canonical_url from licitor_ingestion.announcements"):
            if announcements.get(old["id"]) != old["canonical_url"]:
                raise ValueError("Snapshot is older than the destination or canonical identities differ")
        with store.db.cursor() as cursor:
            cursor.executemany(
                """insert into licitor_ingestion.captures values (%s,%s,%s,%s,%s,%s)
                on conflict (url,sha256) do update set last_seen_at=greatest(licitor_ingestion.captures.last_seen_at,excluded.last_seen_at)""",
                [
                    (r["url"], r["sha256"], r["kind"], r["captured_at"], r["captured_at"], r["html_gzip"])
                    for r in captures
                ],
            )
            parsed = []
            for identity, url in announcements.items():
                capture = capture_by_url.get(url) if url in details else None
                parsed.append(
                    (
                        identity,
                        url,
                        capture["sha256"] if capture else None,
                        capture["captured_at"] if capture else None,
                        details.get(url),
                    )
                )
            cursor.executemany(
                """insert into licitor_ingestion.announcements values (%s,%s,%s,%s,%s)
                on conflict (id) do update set current_capture_hash=excluded.current_capture_hash,
                parsed_at=excluded.parsed_at,parser_version=excluded.parser_version""",
                parsed,
            )
            cursor.executemany(
                "insert into licitor_ingestion.aliases values (%s,%s) on conflict do nothing", list(aliases.items())
            )
            cursor.executemany(
                """insert into licitor_ingestion.index_pages
                (run_id,url,zone,page_number,entry_count,declared_total,declared_pages,next_url)
                values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict (run_id,url) do nothing""",
                [
                    (
                        run_id,
                        r["url"],
                        r["zone"],
                        r["page_number"],
                        r["entry_count"],
                        r["declared_total"],
                        r["declared_pages"],
                        r["next_url"],
                    )
                    for r in pages
                ],
            )
            cursor.executemany(
                """insert into licitor_ingestion.index_entries values (%s,%s,%s,%s,%s,%s)
                on conflict (run_id,page_url,position) do update set payload=excluded.payload""",
                [
                    (
                        run_id,
                        r["page_url"],
                        r["position"],
                        announcement_id(r["detail_url"]),
                        r["detail_url"],
                        Jsonb(json.loads(r["payload"])),
                    )
                    for r in entries
                ],
            )
            cursor.executemany(
                """insert into licitor_ingestion.candidate_versions(external_id,version_hash,payload) values (%s,%s,%s)
                on conflict do nothing""",
                [(r["external_id"], hashlib.sha256(json_text(r).encode()).hexdigest(), Jsonb(r)) for r in rows],
            )
            cursor.executemany(
                """insert into licitor_ingestion.candidates(external_id,announcement_id,payload) values (%s,%s,%s)
                on conflict (external_id) do update set payload=excluded.payload,updated_at=now()""",
                [
                    (r["external_id"], announcement_id(lot["detail_url"]), Jsonb(r))
                    for r, lot in zip(rows, lots, strict=True)
                ],
            )
            tasks = {}
            for page in pages:
                key = "index:" + page["url"]
                tasks[key] = (run_id, key, "index", page["url"], page["zone"], page["page_number"], "done", 0, None)
            for page in pages:
                if page["next_url"]:
                    key = "index:" + page["next_url"]
                    tasks.setdefault(
                        key,
                        (
                            run_id,
                            key,
                            "index",
                            page["next_url"],
                            page["zone"],
                            page["page_number"] + 1,
                            "pending",
                            0,
                            None,
                        ),
                    )
            for identity, url in announcements.items():
                key = "detail:" + identity
                tasks[key] = (run_id, key, "detail", url, None, 0, "done" if url in details else "pending", 0, None)
            for error in errors:
                if error["kind"].startswith("detail"):
                    key = "detail:" + announcement_id(error["url"])
                    if key in tasks:
                        tasks[key] = (*tasks[key][:6], "error", error["attempts"], error["message"])
                else:
                    key = "index:" + error["url"]
                    if key in tasks:
                        tasks[key] = (*tasks[key][:6], "error", error["attempts"], error["message"])
            cursor.executemany(
                """insert into licitor_ingestion.tasks
                (run_id,task_key,kind,url,zone,page_number,status,attempts,last_error) values (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                on conflict (run_id,task_key) do update set status=excluded.status,attempts=excluded.attempts,
                last_error=excluded.last_error,updated_at=now()""",
                list(tasks.values()),
            )
        transferred = {
            r["external_id"]: r["payload"]
            for r in store.db.execute("select external_id,payload from licitor_ingestion.candidates")
        }
        if transferred != {r["external_id"]: r for r in rows}:
            raise ValueError("Candidate verification failed; the whole import is rolled back")
        report = {
            "candidate_lots": len(rows),
            "announcements": len(announcements),
            "source_captures": len(captures),
            "index_pages": len(pages),
            "index_entries": len(entries),
            "preserved_errors": len(errors),
            "local_network_requests": metadata.get("network_requests"),
            "snapshot": snapshot.name,
        }
        counts = store.one(
            """select (select count(*) from licitor_ingestion.captures) as captures,
            (select count(*) from licitor_ingestion.index_entries where run_id=%s) as entries""",
            (run_id,),
        )
        if counts != {"captures": len(captures), "entries": len(entries)}:
            raise ValueError("Capture/index verification failed; the whole import is rolled back")
        store.event(run_id, "local_snapshot_imported", report)
        return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--run-id", default="backfill-2026-08-28")
    args = parser.parse_args()
    snapshot_archive(args.archive, args.snapshot)
    store = connect_store()
    try:
        print(json.dumps(import_snapshot(store, args.snapshot, args.run_id), ensure_ascii=False))
    finally:
        store.db.close()


if __name__ == "__main__":
    main()
