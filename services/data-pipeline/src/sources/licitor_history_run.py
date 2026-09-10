"""Resumable private Licitor archive acquisition. Never writes the public catalogue.

Run with an explicit authorization record and environment gate. HTTP captures,
hashes, index positions and normalized candidates are checkpointed per page in
SQLite. A report is diagnostic only; canonical A/B review remains separate.
"""

from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from collections import Counter
from dataclasses import asdict
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx

from src.config import RAW_DIR, load_settings
from src.sources.common import RobotsRules, is_allowed_origin_url
from src.sources.licitor import ALLOWED_ORIGINS
from src.sources.licitor_history import (
    LICITOR_HISTORY_CONNECTOR_VERSION,
    LICITOR_HISTORY_ZONE_URLS,
    LicitorHistoricalAuthorizationError,
    LicitorHistoryIndexEntry,
    build_licitor_price_statistics,
    parse_licitor_historical_detail_html,
    parse_licitor_history_list_html,
)

USER_AGENT = "ImmojudisStatistics/1.0 (+https://immojudis.com)"
ROBOTS_URL = "https://www.licitor.com/robots.txt"
MAX_RESPONSE_BYTES = 3_000_000
ALIAS_FACT_FIELDS = (
    "external_id",
    "city",
    "address",
    "tribunal",
    "sale_date",
    "starting_price_eur",
    "adjudication_price_eur",
    "status",
    "property_type",
)


class RunPaused(RuntimeError):
    """Intentional stop that can be resumed after operator inspection."""


def now() -> str:
    return datetime.now(UTC).isoformat()


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def announcement_id(url: str) -> str:
    match = re.search(r"/(\d+)\.html$", urlsplit(url).path)
    if not is_allowed_origin_url(url, ALLOWED_ORIGINS) or not urlsplit(url).path.startswith("/annonce/") or not match:
        raise ValueError("Detail URL must identify a Licitor announcement")
    return match.group(1)


def log(event: str, **values: Any) -> None:
    print(json_text({"at": now(), "event": event, **values}), flush=True)


def read_authorization(path: Path) -> dict[str, Any]:
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("source") != "licitor_public_results":
        raise LicitorHistoricalAuthorizationError("Authorization must name licitor_public_results")
    if record.get("basis") not in {"operator_reported_verbal_consent", "written_source_consent"}:
        raise LicitorHistoricalAuthorizationError("Authorization basis is missing or unsupported")
    if not record.get("reference") or "public_historical_results" not in record.get("scope", []):
        raise LicitorHistoricalAuthorizationError("Authorization must cover public historical results")
    date.fromisoformat(record["reported_at"])
    return record


def atomic_write(path: Path, text: str) -> None:
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
        temporary = handle.name
    os.replace(temporary, path)
    path.chmod(0o600)


class ArchiveState:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root.chmod(0o700)
        self.db = sqlite3.connect(root / "archive.sqlite3")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            pragma journal_mode=wal;
            create table if not exists metadata (key text primary key, value text not null);
            create table if not exists captures (
                url text primary key, kind text not null, captured_at text not null,
                sha256 text not null, html_gzip blob not null
            );
            create table if not exists index_pages (
                url text primary key, zone text not null, page_number integer not null,
                entry_count integer not null, declared_total integer, declared_pages integer,
                next_url text
            );
            create table if not exists index_entries (
                page_url text not null, position integer not null, detail_url text not null,
                payload text not null, primary key(page_url, position)
            );
            create index if not exists entries_detail on index_entries(detail_url);
            create table if not exists details (
                url text primary key, lot_count integer not null, parser_version text not null
            );
            create table if not exists announcements (
                announcement_id text primary key, canonical_url text not null unique
            );
            create table if not exists detail_aliases (
                url text primary key, announcement_id text not null
            );
            create index if not exists aliases_announcement on detail_aliases(announcement_id);
            create table if not exists lots (
                external_id text primary key, detail_url text not null, payload text not null
            );
            create table if not exists errors (
                url text primary key, kind text not null, message text not null,
                attempts integer not null, last_at text not null
            );
        """)
        (root / "archive.sqlite3").chmod(0o600)

    def set(self, key: str, value: Any) -> None:
        with self.db:
            self.db.execute("insert or replace into metadata values (?, ?)", (key, json_text(value)))

    def get(self, key: str, default: Any = None) -> Any:
        row = self.db.execute("select value from metadata where key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def bind(self, authorization: dict[str, Any], *, reparse: bool = False) -> None:
        digest = hashlib.sha256(json_text(authorization).encode()).hexdigest()
        if self.get("authorization_hash", digest) != digest:
            raise ValueError("Authorization changed: use a new archive directory")
        if (
            not reparse
            and self.get("parser_version", LICITOR_HISTORY_CONNECTOR_VERSION) != LICITOR_HISTORY_CONNECTOR_VERSION
        ):
            raise ValueError("Parser version changed: use --reparse-cached or a new archive directory")
        self.set("authorization", authorization)
        self.set("authorization_hash", digest)
        self.set("parser_version", LICITOR_HISTORY_CONNECTOR_VERSION)
        if self.get("started_at") is None:
            self.set("started_at", now())

    def cached(self, url: str) -> str | None:
        row = self.db.execute("select html_gzip from captures where url = ?", (url,)).fetchone()
        return gzip.decompress(row[0]).decode("utf-8") if row else None

    def capture(self, url: str, kind: str, html: str) -> None:
        content = html.encode("utf-8")
        with self.db:
            self.db.execute(
                "insert or replace into captures values (?, ?, ?, ?, ?)",
                (url, kind, now(), hashlib.sha256(content).hexdigest(), gzip.compress(content)),
            )

    def error(self, url: str, kind: str, message: str) -> None:
        with self.db:
            self.db.execute(
                """insert into errors values (?, ?, ?, 1, ?)
                on conflict(url) do update set kind=excluded.kind, message=excluded.message, attempts=errors.attempts+1,
                    last_at=excluded.last_at""",
                (url, kind, message[:1000], now()),
            )

    def records(self) -> list[dict[str, Any]]:
        return [json.loads(row[0]) for row in self.db.execute("select payload from lots order by external_id")]

    def register_detail(self, url: str) -> str:
        identity = announcement_id(url)
        with self.db:
            self.db.execute("insert or ignore into announcements values (?, ?)", (identity, url))
            self.db.execute("insert or ignore into detail_aliases values (?, ?)", (url, identity))
        return self.db.execute(
            "select canonical_url from announcements where announcement_id=?", (identity,)
        ).fetchone()[0]

    def backfill_aliases(self) -> None:
        # The oldest retained capture is the frozen source for an announcement.
        # All other captures remain available for conflict detection and audit.
        for row in self.db.execute("select url from captures where kind='detail' order by captured_at, url").fetchall():
            self.register_detail(row[0])
        for row in self.db.execute("select distinct detail_url from index_entries").fetchall():
            self.register_detail(row[0])


class ArchiveHttp:
    def __init__(self, state: ArchiveState, *, delay: float, max_requests: int, max_seconds: int) -> None:
        self.state = state
        self.delay = max(2.0, delay)
        self.max_requests = max_requests
        self.max_seconds = max_seconds
        self.count = 0
        self.started = time.monotonic()
        self.previous = 0.0
        self.stop_requested = False
        self.rules = RobotsRules()
        self.client = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain"}, timeout=30, follow_redirects=False
        )
        robots = self.fetch(ROBOTS_URL, "robots", refresh=True)
        self.rules = RobotsRules.parse(robots, USER_AGENT)
        if not all(self.rules.can_fetch(url) for url in LICITOR_HISTORY_ZONE_URLS):
            raise RunPaused("robots.txt disallows an archive zone")
        self.state.set("robots_checked_at", now())

    def checkpoint(self) -> None:
        if self.stop_requested or (self.state.root / "STOP").exists():
            raise RunPaused("operator_stop")
        if time.monotonic() - self.started >= self.max_seconds:
            raise RunPaused("runtime_budget_reached")

    def fetch(self, url: str, kind: str, *, refresh: bool = False) -> str:
        self.checkpoint()
        if not refresh and (html := self.state.cached(url)) is not None:
            return html
        current = url
        for _ in range(6):
            self.checkpoint()
            if not is_allowed_origin_url(current, ALLOWED_ORIGINS):
                raise RunPaused("redirect_outside_licitor")
            path = urlsplit(current).path
            allowed_path = (
                path == "/robots.txt"
                or path.startswith("/annonce/")
                or path in {urlsplit(zone).path for zone in LICITOR_HISTORY_ZONE_URLS}
            )
            if not allowed_path or (kind != "robots" and not self.rules.can_fetch(current)):
                raise RunPaused("robots_or_path_policy_denied")
            if self.count >= self.max_requests:
                raise RunPaused("request_budget_reached")
            time.sleep(max(0, self.delay - (time.monotonic() - self.previous)))
            self.count += 1
            self.state.set("network_requests", self.state.get("network_requests", 0) + 1)
            try:
                with self.client.stream("GET", current) as response:
                    if response.status_code in {401, 403, 429}:
                        raise RunPaused(
                            f"source_http_{response.status_code}; retry_after={response.headers.get('retry-after')}"
                        )
                    if response.is_redirect:
                        current = urljoin(current, response.headers["location"])
                        continue
                    response.raise_for_status()
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise RunPaused("response_size_limit")
                    html = bytes(body).decode(response.encoding or "utf-8", errors="replace")
                    if kind != "robots" and not any(marker in html for marker in ('class="LegalAd"', 'id="zone-list"')):
                        raise ValueError("Unexpected page structure (no archive or legal notice)")
                    self.state.capture(url, kind, html)
                    return html
            finally:
                self.previous = time.monotonic()
        raise RunPaused("redirect_limit")


def prepare_candidates(
    html: str, url: str, entries: list[LicitorHistoryIndexEntry], authorization: dict[str, Any], captured_at: str
) -> list[dict[str, Any]]:
    rows = parse_licitor_historical_detail_html(html, url)
    if not rows:
        raise ValueError("No unambiguous result lots parsed; source retained for review")
    if len({row["external_id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate lot identities on detail page; manual review required")
    if any(not row["external_id"].startswith(f"{announcement_id(url)}:lot:") for row in rows):
        raise ValueError("Parsed lot identity differs from its source announcement")
    cities = {entry.city for entry in entries if entry.city}
    dates = {entry.result_date.isoformat() for entry in entries if entry.result_date}
    for row in rows:
        flags = [flag for flag in row["quality_flags"] if flag != "commercial_reuse_rights_pending"]
        flags.append("source_authorization_reported_by_operator")
        city_entries = [
            entry for entry in entries if (entry.city or "").casefold() == (row.get("city") or "").casefold()
        ]
        departments = {entry.department for entry in city_entries if entry.department}
        if len(departments) == 1:
            row["department"] = next(iter(departments))
        else:
            row["department"] = None
            flags.append("department_not_matched_to_index_city")
        if not row.get("city") and len(cities) == 1:
            flags.append("lot_city_missing_in_source")
        if row["sale_venue_type"] != "tribunal":
            flags.append("non_tribunal_venue_excluded_from_statistics")
        if dates and dates != {row.get("sale_date")}:
            flags.append("index_detail_date_conflict")
        row.update(
            {
                "authorization_reference": authorization["reference"],
                "authorization_basis": authorization["basis"],
                "captured_at": captured_at,
                "quality_flags": flags,
                "publication_eligible": False,
                "review_status": "pending",
                "training_eligible": False,
                "source_content_hash": hashlib.sha256(html.encode()).hexdigest(),
                "connector_version": LICITOR_HISTORY_CONNECTOR_VERSION,
            }
        )
    return rows


def stored_entries(state: ArchiveState, url: str) -> list[LicitorHistoryIndexEntry]:
    entries = []
    for item in state.db.execute(
        """select e.payload from index_entries e join detail_aliases a on a.url=e.detail_url
        where a.announcement_id=? order by e.page_url, e.position""",
        (announcement_id(url),),
    ):
        value = json.loads(item[0])
        value["result_date"] = date.fromisoformat(value["result_date"]) if value["result_date"] else None
        value["hammer_price_eur"] = (
            Decimal(value["hammer_price_eur"]) if value["hammer_price_eur"] is not None else None
        )
        entries.append(LicitorHistoryIndexEntry(**value))
    return entries


def save_announcement(state: ArchiveState, url: str, authorization: dict[str, Any]) -> None:
    canonical_url = state.register_detail(url)
    identity = announcement_id(url)
    captures = state.db.execute(
        """select c.* from captures c join detail_aliases a on a.url=c.url
        where a.announcement_id=? and c.kind='detail' order by c.captured_at, c.url""",
        (identity,),
    ).fetchall()
    canonical = next((capture for capture in captures if capture["url"] == canonical_url), None)
    if canonical is None:
        raise ValueError("Canonical announcement capture is missing")
    entries = stored_entries(state, url)
    rows = prepare_candidates(
        gzip.decompress(canonical["html_gzip"]).decode(),
        canonical_url,
        entries,
        authorization,
        canonical["captured_at"],
    )
    facts = sorted(json_text({key: row.get(key) for key in ALIAS_FACT_FIELDS}) for row in rows)
    conflict = False
    for capture in captures:
        if capture["url"] == canonical_url:
            continue
        try:
            alternate = prepare_candidates(
                gzip.decompress(capture["html_gzip"]).decode(),
                capture["url"],
                entries,
                authorization,
                capture["captured_at"],
            )
            conflict |= facts != sorted(
                json_text({key: row.get(key) for key in ALIAS_FACT_FIELDS}) for row in alternate
            )
        except ValueError:
            conflict = True
    aliases = [
        row[0]
        for row in state.db.execute("select url from detail_aliases where announcement_id=? order by url", (identity,))
    ]
    evidence = [{key: capture[key] for key in ("url", "captured_at", "sha256")} for capture in captures]
    for row in rows:
        row["source_announcement_id"] = identity
        row["source_alias_urls"] = aliases
        row["source_capture_evidence"] = evidence
        if conflict:
            row["quality_flags"].append("conflicting_announcement_alias_capture")
    with state.db:
        state.db.execute(
            "delete from lots where detail_url in (select url from detail_aliases where announcement_id=?)", (identity,)
        )
        state.db.executemany(
            "insert into lots values (?, ?, ?)", [(row["external_id"], canonical_url, json_text(row)) for row in rows]
        )
        state.db.executemany(
            "insert or replace into details values (?, ?, ?)",
            [(alias, len(rows), LICITOR_HISTORY_CONNECTOR_VERSION) for alias in aliases],
        )
        state.db.execute(
            "delete from errors where url in (select url from detail_aliases where announcement_id=?)", (identity,)
        )
    if conflict:
        state.error(
            canonical_url, "detail_alias_conflict", "Cached alias captures disagree; lots quarantined from statistics"
        )


def reparse_captures(state: ArchiveState, authorization: dict[str, Any]) -> None:
    state.backfill_aliases()
    announcements = state.db.execute(
        """select a.canonical_url from announcements a join captures c on c.url=a.canonical_url
        where c.kind='detail' order by c.captured_at, c.url"""
    ).fetchall()
    for announcement in announcements:
        url = announcement[0]
        try:
            save_announcement(state, url, authorization)
        except Exception as exc:
            identity = announcement_id(url)
            with state.db:
                state.db.execute(
                    "delete from details where url in (select url from detail_aliases where announcement_id=?)",
                    (identity,),
                )
                for item in state.db.execute(
                    "select external_id, payload from lots where detail_url in "
                    "(select url from detail_aliases where announcement_id=?)",
                    (identity,),
                ).fetchall():
                    row = json.loads(item["payload"])
                    row["quality_flags"] = sorted(set(row["quality_flags"]) | {"cached_reparse_failed"})
                    state.db.execute(
                        "update lots set payload=? where external_id=?", (json_text(row), item["external_id"])
                    )
            state.error(url, "detail_reparse", str(exc))
    log("cached_details_reparsed", announcements=len(announcements), parser_version=LICITOR_HISTORY_CONNECTOR_VERSION)


def next_index_url(url: str, candidates: tuple[str, ...]) -> str | None:
    parsed = urlsplit(url)
    current = int(parse_qs(parsed.query).get("p", ["1"])[0])
    following = []
    for candidate in candidates:
        target = urlsplit(candidate)
        try:
            page = int(parse_qs(target.query).get("p", ["0"])[0])
        except ValueError:
            continue
        if target.path == parsed.path and page > current:
            following.append((page, candidate))
    return min(following)[1] if following else None


def write_report(
    state: ArchiveState, *, status: str, reason: str | None = None, export: bool = False
) -> dict[str, Any]:
    rows = state.records()
    diagnostic = build_licitor_price_statistics(rows, as_of=date.today())
    zones = [
        dict(row)
        for row in state.db.execute("""select zone, count(*) as fetched_pages,
        max(declared_total) as declared_entries, max(declared_pages) as declared_pages,
        sum(entry_count) as captured_index_entries from index_pages group by zone order by zone""")
    ]
    dates = [row["sale_date"] for row in rows if row.get("sale_date")]
    for zone in zones:
        zone["pagination_complete"] = bool(
            state.db.execute("select 1 from index_pages where zone=? and next_url is null", (zone["zone"],)).fetchone()
        )
        zone["index_count_matches_declared_total"] = zone["captured_index_entries"] == zone["declared_entries"]
    report = {
        "status": status,
        "stop_reason": reason,
        "updated_at": now(),
        "pid": state.get("pid"),
        "started_at": state.get("started_at"),
        "authorization": state.get("authorization"),
        "parser_version": LICITOR_HISTORY_CONNECTOR_VERSION,
        "network_requests": state.get("network_requests", 0),
        "zones": zones,
        "detail_pages": state.db.execute("""select count(*) from announcements a
            join details d on d.url=a.canonical_url""").fetchone()[0],
        "detail_urls_resolved": state.db.execute("select count(*) from details").fetchone()[0],
        "alias_urls_discovered": state.db.execute("select count(*) from detail_aliases").fetchone()[0]
        - state.db.execute("select count(*) from announcements").fetchone()[0],
        "pending_detail_pages": state.db.execute("""select count(distinct detail_url) from index_entries
            where detail_url not in (select url from details)""").fetchone()[0],
        "candidate_lots": len(rows),
        "candidate_no_bid": sum("held_no_bid_candidate" in row["quality_flags"] for row in rows),
        "non_tribunal_lots": sum(row.get("sale_venue_type") != "tribunal" for row in rows),
        "rows_with_initial_and_hammer_prices": sum(
            bool(row.get("starting_price_eur") and row.get("adjudication_price_eur")) for row in rows
        ),
        "date_start": min(dates, default=None),
        "date_end": max(dates, default=None),
        "quality_flags": dict(Counter(flag for row in rows for flag in row["quality_flags"])),
        "unresolved_errors": [dict(row) for row in state.db.execute("select * from errors order by last_at")],
        "publication_eligible": False,
        "reviewed_results": 0,
        "diagnostic_statistics_not_for_publication": diagnostic,
        "limitations": [
            "Corpus partiel tant que les six paginations et toutes les fiches ne sont pas terminées.",
            "Résultats déclarés par une source tierce, finalité et revue A/B non établies.",
            "Libellés tribunal source : rapprochement officiel encore requis avant publication locale.",
            "Sous-lots immobiliers groupés non assimilés automatiquement à plusieurs adjudications.",
        ],
    }
    atomic_write(state.root / "report.json", json.dumps(report, ensure_ascii=False, indent=2))
    if export:
        atomic_write(state.root / "candidates.jsonl", "".join(json_text(row) + "\n" for row in rows))
    return report


def collect(state: ArchiveState, http: ArchiveHttp, authorization: dict[str, Any], *, max_pages: int) -> None:
    active = {zone: zone for zone in LICITOR_HISTORY_ZONE_URLS}
    failures = 0
    processed = 0
    for page_number in range(1, max_pages + 1):
        for zone, url in list(active.items()):
            http.checkpoint()
            html = http.fetch(url, "index")
            page = parse_licitor_history_list_html(html, url)
            if not page.entries:
                raise ValueError(f"Empty/unrecognized archive page: {url}")
            following = next_index_url(url, page.next_urls)
            if following is None and page.declared_pages and page_number < page.declared_pages:
                raise ValueError(f"Pagination ended before declared final page: {url}")
            with state.db:
                state.db.execute(
                    "insert or replace into index_pages values (?, ?, ?, ?, ?, ?, ?)",
                    (url, zone, page_number, len(page.entries), page.declared_total, page.declared_pages, following),
                )
                state.db.executemany(
                    "insert or replace into index_entries values (?, ?, ?, ?)",
                    [(url, entry.page_position, entry.source_url, json_text(asdict(entry))) for entry in page.entries],
                )
            canonical_urls = dict.fromkeys(state.register_detail(entry.source_url) for entry in page.entries)
            if following:
                active[zone] = following
            else:
                del active[zone]
            for detail_url in canonical_urls:
                http.checkpoint()
                previously_parsed = bool(
                    state.db.execute("select 1 from details where url=?", (detail_url,)).fetchone()
                )
                try:
                    http.fetch(detail_url, "detail")
                    save_announcement(state, detail_url, authorization)
                    failures = 0
                    processed += not previously_parsed
                except RunPaused:
                    raise
                except Exception as exc:
                    failures += 1
                    state.error(detail_url, "detail", str(exc))
                    log("detail_failed", url=detail_url, message=str(exc))
                    if failures >= 3:
                        raise RunPaused("three_consecutive_detail_failures") from exc
            log(
                "page_checkpoint",
                zone=urlsplit(zone).path.split("/")[-2],
                page=page_number,
                index_entries=len(page.entries),
                new_details_this_run=processed,
                requests_this_run=http.count,
            )
            write_report(state, status="running")
        if not active:
            break
    status = "captured_pending_review" if not active else "paused_at_page_limit"
    if not active and state.db.execute("select count(*) from errors").fetchone()[0]:
        status = "pagination_exhausted_with_errors"
    state.set("status", status)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=RAW_DIR / "licitor_history" / date.today().isoformat())
    parser.add_argument("--authorization-record", type=Path)
    parser.add_argument("--authorization-confirmed", action="store_true")
    parser.add_argument("--max-pages-per-zone", type=int, default=1)
    parser.add_argument("--max-requests", type=int, default=250)
    parser.add_argument("--max-runtime-seconds", type=int, default=1800)
    parser.add_argument("--delay-seconds", type=float, default=2.0)
    parser.add_argument("--background", action="store_true")
    parser.add_argument("--report-only", action="store_true")
    parser.add_argument(
        "--reparse-cached", action="store_true", help="Explicitly rebuild candidates from retained captures"
    )
    args = parser.parse_args(argv)
    os.umask(0o077)
    if args.report_only:
        if not (args.output_dir / "archive.sqlite3").is_file():
            parser.error("Archive does not exist")
        state = ArchiveState(args.output_dir)
        report = write_report(
            state, status=state.get("status", "unknown"), reason=state.get("stop_reason"), export=True
        )
        log(
            "report",
            **{key: report[key] for key in ("status", "detail_pages", "candidate_lots", "pending_detail_pages")},
        )
        state.db.close()
        return 0
    if not args.authorization_confirmed or not args.authorization_record:
        parser.error("Explicit source authorization and its record are required")
    if not load_settings()["licitor_historical_authorized"]:
        parser.error("LICITOR_HISTORICAL_AUTHORIZED must be true for this authorized run")
    authorization = read_authorization(args.authorization_record)
    if min(args.max_pages_per_zone, args.max_requests, args.max_runtime_seconds) < 1:
        parser.error("Budgets must be positive")
    args.output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.background:
        with (args.output_dir / "runner.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        child_args = [arg for arg in (argv if argv is not None else sys.argv[1:]) if arg != "--background"]
        with (args.output_dir / "run.log").open("a", encoding="utf-8") as output:
            child = subprocess.Popen(
                [sys.executable, "-u", "-m", "src.sources.licitor_history_run", *child_args],
                stdout=output,
                stderr=output,
                start_new_session=True,
            )
        atomic_write(args.output_dir / "runner.pid", str(child.pid) + "\n")
        log("background_started", pid=child.pid, output_dir=str(args.output_dir.resolve()))
        return 0
    with (args.output_dir / "runner.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = ArchiveState(args.output_dir)
        state.bind(authorization, reparse=args.reparse_cached)
        if args.reparse_cached:
            reparse_captures(state, authorization)
        state.set("status", "running")
        state.set("pid", os.getpid())
        http = None
        reason = None
        exit_code = 0
        try:
            http = ArchiveHttp(
                state, delay=args.delay_seconds, max_requests=args.max_requests, max_seconds=args.max_runtime_seconds
            )

            def stop(_signal: int, _frame: Any) -> None:
                http.stop_requested = True

            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            log(
                "run_started",
                pid=os.getpid(),
                authorization=authorization["reference"],
                max_pages_per_zone=args.max_pages_per_zone,
                max_requests=args.max_requests,
                delay_seconds=http.delay,
            )
            collect(state, http, authorization, max_pages=args.max_pages_per_zone)
        except RunPaused as exc:
            reason = str(exc)
            state.set("status", "paused")
        except Exception as exc:
            reason = str(exc)
            state.set("status", "failed")
            exit_code = 1
        finally:
            state.set("stop_reason", reason)
            report = write_report(state, status=state.get("status"), reason=reason, export=True)
            log(
                "run_finished",
                status=report["status"],
                reason=reason,
                candidate_lots=report["candidate_lots"],
                detail_pages=report["detail_pages"],
            )
            if http:
                http.client.close()
            state.db.close()
        return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
