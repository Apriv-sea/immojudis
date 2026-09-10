"""Bounded, single-writer Licitor acquisition on Vercel; no publication side effects."""

from __future__ import annotations

import gzip
import hmac
import json
import os
import time
from datetime import UTC, date, datetime, timedelta
from http.server import BaseHTTPRequestHandler
from urllib.parse import urljoin, urlsplit

import httpx
import psycopg

from src.sources.common import RobotsRules, is_allowed_origin_url
from src.sources.licitor import ALLOWED_ORIGINS
from src.sources.licitor_cloud_store import CloudStore, LeaseLost
from src.sources.licitor_history import LICITOR_HISTORY_ZONE_URLS, licitor_window_start, parse_licitor_history_list_html
from src.sources.licitor_history_run import (
    MAX_RESPONSE_BYTES,
    ROBOTS_URL,
    USER_AGENT,
    RunPaused,
    announcement_id,
    next_index_url,
    prepare_candidates,
)


class BatchYield(RuntimeError):
    pass


class SourceHttp:
    def __init__(self, store: CloudStore, run_id: str, *, max_seconds: int = 240, max_requests: int = 100):
        self.store = store
        self.run_id = run_id
        self.started = time.monotonic()
        self.previous = self.started
        self.max_seconds = min(240, max_seconds)
        self.max_requests = min(100, max_requests)
        self.count = 0
        self.rules = RobotsRules()
        self.client = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain"}, timeout=25, follow_redirects=False
        )

    def checkpoint(self):
        if time.monotonic() - self.started >= self.max_seconds - 35 or self.count >= self.max_requests:
            raise BatchYield("bounded_batch_finished")

    def load_robots(self):
        html, _ = self.fetch(ROBOTS_URL, "robots")
        self.rules = RobotsRules.parse(html, USER_AGENT)
        if not all(self.rules.can_fetch(url) for url in LICITOR_HISTORY_ZONE_URLS):
            raise RunPaused("robots_archive_disallowed")

    def fetch(self, url: str, kind: str) -> tuple[str, dict]:
        current = url
        for _ in range(6):
            self.checkpoint()
            path = urlsplit(current).path
            if not is_allowed_origin_url(current, ALLOWED_ORIGINS) or not (
                path == "/robots.txt"
                or path.startswith("/annonce/")
                or path in {urlsplit(zone).path for zone in LICITOR_HISTORY_ZONE_URLS}
            ):
                raise RunPaused("source_origin_or_path_denied")
            if kind != "robots" and not self.rules.can_fetch(current):
                raise RunPaused("robots_path_disallowed")
            time.sleep(max(0, 2 - (time.monotonic() - self.previous)))
            self.checkpoint()
            self.store.request_started(self.run_id)
            self.count += 1
            try:
                with self.client.stream("GET", current) as response:
                    if response.status_code in {401, 403, 429}:
                        raise RunPaused(f"source_http_{response.status_code}")
                    if response.is_redirect:
                        current = urljoin(current, response.headers["location"])
                        continue
                    response.raise_for_status()
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise RunPaused("source_response_size_limit")
                    html = bytes(body).decode(response.encoding or "utf-8", errors="replace")
                    if kind != "robots" and not any(marker in html for marker in ('class="LegalAd"', 'id="zone-list"')):
                        raise ValueError("Unexpected source page structure")
                    with self.store.guarded():
                        capture = self.store.capture(url, kind, html)
                    return html, capture
            finally:
                self.previous = time.monotonic()
        raise RunPaused("source_redirect_limit")


def process_index(store: CloudStore, http: SourceHttp, task: dict, run: dict) -> None:
    cached = store.latest_capture(task["url"])
    if cached and not task["refresh"]:
        html = gzip.decompress(bytes(cached["html_gzip"])).decode("utf-8")
    else:
        html, _ = http.fetch(task["url"], "index")
    page = parse_licitor_history_list_html(html, task["url"])
    if not page.entries:
        raise ValueError("Empty/unrecognized source index")
    following = next_index_url(task["url"], page.next_urls)
    if following is None and page.declared_pages and task["page_number"] < page.declared_pages:
        raise ValueError("Source pagination ended before its declared last page")
    if task["page_number"] >= 4000 and following:
        raise RunPaused("source_pagination_budget_reached")
    known = {entry.source_url: store.known_alias(entry.source_url) for entry in page.entries}
    cutoff = max(run["cutoff_date"] or date.min, licitor_window_start(datetime.now(UTC).date()))
    campaign_month = date.fromisoformat(run["id"].removeprefix("monthly-") + "-01") if run["mode"] == "monthly" else run["created_at"].date().replace(day=1)
    refresh_since = campaign_month - timedelta(days=90)
    # Stop at two dated boundary pages even when their old announcements are unknown.
    # Monthly refresh may stop earlier only when every entry is already parsed.
    old_known = all(
        entry.result_date is not None and (
            entry.result_date < cutoff
            or (run["mode"] == "monthly" and entry.result_date < refresh_since and known[entry.source_url])
        )
        for entry in page.entries
    )
    previous = store.one(
        """select old_known_page from licitor_ingestion.index_pages
        where run_id=%s and zone=%s and page_number=%s""",
        (run["id"], task["zone"], task["page_number"] - 1),
    )
    if old_known and previous and previous["old_known_page"]:
        following = None
    refresh_ids = {
        announcement_id(entry.source_url)
        for entry in page.entries
        if run["mode"] == "monthly"
        and (not known[entry.source_url] or entry.result_date is None or entry.result_date >= refresh_since)
    }
    eligible_ids = {
        announcement_id(entry.source_url) for entry in page.entries
        if entry.result_date is None or entry.result_date >= cutoff
    }
    store.save_page(task, page, following, old_known=old_known, refresh_ids=refresh_ids, eligible_ids=eligible_ids)


def process_detail(store: CloudStore, http: SourceHttp, task: dict, run: dict, authorization: dict) -> None:
    cutoff = max(run["cutoff_date"] or date.min, licitor_window_start(datetime.now(UTC).date()))
    entries = store.entries(announcement_id(task["url"]))
    if entries and all(entry.result_date is not None and entry.result_date < cutoff for entry in entries):
        with store.guarded():
            store.done(task)
            store.event(run["id"], "detail_outside_window", {"announcement_id": announcement_id(task["url"])})
        return
    cached = store.latest_capture(task["url"])
    # Every monthly campaign refreshes recent pages, but aliases do not cause repeat downloads.
    if cached and (not task["refresh"] or cached["last_seen_at"] >= run["created_at"]):
        capture = cached
        html = gzip.decompress(bytes(capture["html_gzip"])).decode("utf-8")
    else:
        html, capture = http.fetch(task["url"], "detail")
    rows = prepare_candidates(
        html,
        task["url"],
        entries,
        authorization,
        capture["last_seen_at"].isoformat(),
    )
    store.save_candidates(task, rows, capture, cutoff=cutoff)


def run_tick(store: CloudStore, *, http_factory=SourceHttp) -> dict:
    control = store.control()
    if not control or not control["enabled"] or control["network_paused"]:
        return {"status": "disabled_or_paused"}
    if not store.acquire():
        return {"status": "busy"}
    http = None
    task = None
    run = None
    processed = 0
    try:
        run = store.active_run()
        if not run:
            return {"status": "idle"}
        if run["network_requests"] >= run["max_requests"]:
            store.pause(run["id"], "campaign_request_budget_reached", source_blocked=False)
            return {"status": "paused", "reason": "request_budget"}
        http = http_factory(store, run["id"])
        http.load_robots()
        while True:
            http.checkpoint()
            task = store.claim_task(run)
            if not task:
                completed = store.finish_if_idle(run["id"])
                return {
                    "status": "completed" if completed else "waiting_retry",
                    "run_id": run["id"],
                    "processed": processed,
                }
            try:
                if task["kind"] == "index":
                    process_index(store, http, task, run)
                else:
                    process_detail(store, http, task, run, control["authorization_record"])
                processed += 1
                task = None
            except (RunPaused, BatchYield, LeaseLost):
                raise
            except Exception as exc:
                if str(exc) == "campaign_request_budget_reached":
                    store.pause(run["id"], str(exc), source_blocked=False)
                    return {"status": "paused", "reason": "request_budget"}
                transient = isinstance(exc, (httpx.TransportError,)) or (
                    isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500
                )
                store.fail(task, str(exc), transient=transient)
                task = None
                failures = store.one(
                    "select consecutive_failures from licitor_ingestion.runs where id=%s", (run["id"],)
                )
                if failures["consecutive_failures"] >= 3:
                    raise RunPaused("three_consecutive_failures") from exc
    except BatchYield:
        if task:
            with store.guarded():
                store.db.execute(
                    "update licitor_ingestion.tasks set status='pending' where run_id=%s and task_key=%s",
                    (task["run_id"], task["task_key"]),
                )
        return {"status": "checkpointed", "run_id": run["id"], "processed": processed}
    except RunPaused as exc:
        store.pause(run["id"], str(exc))
        return {"status": "paused", "run_id": run["id"], "reason": str(exc)}
    except httpx.HTTPError as exc:
        # A robots.txt/network startup failure must also be recorded and bounded.
        with store.guarded():
            failure = store.one(
                """update licitor_ingestion.runs set consecutive_failures=consecutive_failures+1,
                updated_at=now() where id=%s returning consecutive_failures""",
                (run["id"],),
            )
            store.event(run["id"], "startup_failed", {"error_type": type(exc).__name__})
        if failure["consecutive_failures"] >= 3:
            store.pause(run["id"], "three_startup_failures")
        return {"status": "retry_later", "run_id": run["id"]}
    finally:
        if http:
            http.client.close()
        store.release()


def start_monthly(store: CloudStore, *, today: date | None = None) -> dict:
    today = today or datetime.now(UTC).date()
    with store.db.transaction():
        control = store.one("select * from licitor_ingestion.control where singleton for update")
        if not control or not control["enabled"] or not control["monthly_enabled"] or control["network_paused"]:
            return {"status": "disabled_or_paused"}
        run_id = f"monthly-{today:%Y-%m}"
        created = store.create_run(run_id, "monthly", licitor_window_start(today), 10000)
        return {"status": "queued" if created else "already_exists", "run_id": run_id}


def connect_store() -> CloudStore:
    url = os.environ.get("LICITOR_DATABASE_URL", "")
    parsed = urlsplit(url)
    if parsed.scheme not in {"postgres", "postgresql"} or not (parsed.username or "").startswith("licitor_collector"):
        raise ValueError("Dedicated collector database credentials are required")
    if not parsed.hostname or not parsed.hostname.endswith((".supabase.co", ".supabase.com")):
        raise ValueError("Collector database host is outside Supabase")
    return CloudStore(
        psycopg.connect(
            url,
            autocommit=True,
            prepare_threshold=None,
            connect_timeout=10,
            options="-c statement_timeout=15000 -c lock_timeout=3000",
            sslmode="require",
        )
    )


def request_authorized(header: str | None) -> bool:
    secret = os.environ.get("CRON_SECRET")
    return bool(secret and header and hmac.compare_digest(header.encode(), f"Bearer {secret}".encode()))


class CollectorHandler(BaseHTTPRequestHandler):
    action = "status"

    def do_GET(self):
        if not request_authorized(self.headers.get("Authorization")):
            self.respond(401, {"ok": False, "error": "Unauthorized"})
            return
        if os.environ.get("VERCEL_ENV") != "production":
            self.respond(409, {"ok": False, "error": "Collection is production-only"})
            return
        store = None
        try:
            store = connect_store()
            if self.action == "tick":
                result = run_tick(store)
            elif self.action == "monthly":
                result = start_monthly(store)
            else:
                result = store.summary()
            print(
                json.dumps({"collector": "licitor", "action": self.action, "result": result}, default=str), flush=True
            )
            self.respond(200, {"ok": True, **result})
        except Exception as exc:
            # Never emit credentials or raw database exception strings into an HTTP response.
            print(
                json.dumps({"collector": "licitor", "action": self.action, "error_type": type(exc).__name__}),
                flush=True,
            )
            self.respond(500, {"ok": False, "error": "Collector execution failed"})
        finally:
            if store:
                store.db.close()

    def respond(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass
