"""Private Postgres checkpoints for the dedicated Licitor Vercel collector."""

from __future__ import annotations

import gzip
import hashlib
import json
import uuid
from contextlib import contextmanager
from dataclasses import asdict
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from src.sources.licitor_history import (
    LICITOR_HISTORY_CONNECTOR_VERSION,
    LICITOR_HISTORY_ZONE_URLS,
    LicitorHistoryIndexEntry,
    licitor_window_start,
)
from src.sources.licitor_history_run import announcement_id, json_text


class LeaseLost(RuntimeError):
    pass


class CloudStore:
    def __init__(self, db: psycopg.Connection) -> None:
        self.db = db
        self.db.row_factory = dict_row
        self.token: str | None = None

    def one(self, query: str, params: tuple = ()) -> dict | None:
        return self.db.execute(query, params).fetchone()

    def control(self) -> dict | None:
        return self.one("select * from licitor_ingestion.control where singleton")

    def acquire(self) -> bool:
        self.token = str(uuid.uuid4())
        row = self.one(
            """update licitor_ingestion.control set lease_token=%s, lease_until=now()+interval '330 seconds',
            updated_at=now() where singleton and enabled and not network_paused
            and (lease_until is null or lease_until < now()) returning singleton""",
            (self.token,),
        )
        if not row:
            self.token = None
            return False
        with self.guarded():
            self.db.execute("update licitor_ingestion.tasks set status='pending' where status='working'")
        return True

    def release(self) -> None:
        if self.token:
            self.db.execute(
                """update licitor_ingestion.control set lease_token=null,lease_until=null,updated_at=now()
                where singleton and lease_token=%s""",
                (self.token,),
            )
            self.token = None

    @contextmanager
    def guarded(self):
        with self.db.transaction():
            if not self.token or not self.one(
                """select singleton from licitor_ingestion.control where singleton and enabled
                and not network_paused and lease_token=%s and lease_until>now() for update""",
                (self.token,),
            ):
                raise LeaseLost("Collector lease expired or collection disabled")
            yield

    def active_run(self) -> dict | None:
        return self.one("""select * from licitor_ingestion.runs where status in ('ready','running')
            order by created_at,id limit 1""")

    def create_run(self, run_id: str, mode: str, cutoff: date | None, max_requests: int) -> bool:
        cutoff = max(cutoff or date.min, licitor_window_start(datetime.now(UTC).date()))
        with self.db.transaction():
            added = self.one(
                """insert into licitor_ingestion.runs (id,mode,cutoff_date,max_requests)
                values (%s,%s,%s,%s) on conflict do nothing returning id""",
                (run_id, mode, cutoff, max_requests),
            )
            if not added:
                return False
            for zone in LICITOR_HISTORY_ZONE_URLS:
                self.enqueue(run_id, "index", zone, zone=zone, page_number=1, refresh=mode == "monthly")
            self.event(run_id, "campaign_created", {"mode": mode, "cutoff": str(cutoff) if cutoff else None})
        return True

    def enqueue(
        self,
        run_id: str,
        kind: str,
        url: str,
        *,
        zone: str | None = None,
        page_number: int = 0,
        refresh: bool = False,
        status: str = "pending",
    ) -> None:
        key = f"detail:{announcement_id(url)}" if kind == "detail" else f"index:{url}"
        self.db.execute(
            """insert into licitor_ingestion.tasks
            (run_id,task_key,kind,url,zone,page_number,refresh,status) values (%s,%s,%s,%s,%s,%s,%s,%s)
            on conflict (run_id,task_key) do update set refresh=licitor_ingestion.tasks.refresh or excluded.refresh,
            status=case when (excluded.refresh and not licitor_ingestion.tasks.refresh)
                or (excluded.kind='detail' and licitor_ingestion.tasks.status='done')
                then 'pending' else licitor_ingestion.tasks.status end""",
            (run_id, key, kind, url, zone, page_number, refresh, status),
        )

    def claim_task(self, run: dict) -> dict | None:
        with self.guarded():
            task = self.one(
                """update licitor_ingestion.tasks set status='working',attempts=attempts+1,updated_at=now()
                where (run_id,task_key) = (select run_id,task_key from licitor_ingestion.tasks
                where run_id=%s and status='pending' and retry_at<=now()
                order by case kind when 'detail' then 0 else 1 end,page_number,task_key
                limit 1 for update skip locked) returning *""",
                (run["id"],),
            )
            if task:
                self.db.execute(
                    "update licitor_ingestion.runs set status='running',updated_at=now() where id=%s", (run["id"],)
                )
            return task

    def finish_if_idle(self, run_id: str) -> bool:
        with self.guarded():
            counts = self.one(
                """select count(*) filter(where status in ('pending','working')) as pending,
                count(*) filter(where status='error') as errors from licitor_ingestion.tasks where run_id=%s""",
                (run_id,),
            )
            if counts["pending"]:
                return False
            status = "completed_with_errors" if counts["errors"] else "completed"
            self.db.execute(
                """update licitor_ingestion.runs set status=%s,finished_at=now(),updated_at=now()
                where id=%s""",
                (status, run_id),
            )
            self.event(run_id, "campaign_finished", {"status": status, "errors": counts["errors"]})
            return True

    def done(self, task: dict) -> None:
        self.db.execute(
            """update licitor_ingestion.tasks set status='done',last_error=null,updated_at=now()
            where run_id=%s and task_key=%s""",
            (task["run_id"], task["task_key"]),
        )
        self.db.execute(
            "update licitor_ingestion.runs set consecutive_failures=0,updated_at=now() where id=%s", (task["run_id"],)
        )

    def fail(self, task: dict, message: str, *, transient: bool = False) -> None:
        with self.guarded():
            status = "pending" if transient and task["attempts"] < 3 else "error"
            self.db.execute(
                """update licitor_ingestion.tasks set status=%s,last_error=%s,
                retry_at=now()+interval '10 minutes',updated_at=now() where run_id=%s and task_key=%s""",
                (status, message[:1000], task["run_id"], task["task_key"]),
            )
            self.db.execute(
                """update licitor_ingestion.runs set consecutive_failures=consecutive_failures+1,
                updated_at=now() where id=%s""",
                (task["run_id"],),
            )
            self.event(
                task["run_id"],
                "task_failed",
                {"key": task["task_key"], "error": message[:1000], "retry": status == "pending"},
            )

    def pause(self, run_id: str, reason: str, *, source_blocked: bool = True) -> None:
        with self.guarded():
            self.db.execute(
                "update licitor_ingestion.runs set status='paused',stop_reason=%s,updated_at=now() where id=%s",
                (reason, run_id),
            )
            self.db.execute(
                "update licitor_ingestion.tasks set status='pending' where run_id=%s and status='working'", (run_id,)
            )
            self.event(run_id, "campaign_paused", {"reason": reason})
            if source_blocked:
                self.db.execute("update licitor_ingestion.control set network_paused=true where singleton")

    def request_started(self, run_id: str) -> None:
        with self.guarded():
            row = self.one(
                """update licitor_ingestion.runs set network_requests=network_requests+1,updated_at=now()
                where id=%s and network_requests<max_requests returning id""",
                (run_id,),
            )
            if not row:
                raise RuntimeError("campaign_request_budget_reached")
            self.db.execute("update licitor_ingestion.control set last_request_at=now() where singleton")

    def latest_capture(self, url: str) -> dict | None:
        return self.one(
            "select * from licitor_ingestion.captures where url=%s order by last_seen_at desc limit 1", (url,)
        )

    def capture(self, url: str, kind: str, html: str, at: str | datetime | None = None) -> dict:
        body = html.encode("utf-8")
        digest = hashlib.sha256(body).hexdigest()
        observed = at or datetime.now(UTC)
        self.db.execute(
            """insert into licitor_ingestion.captures values (%s,%s,%s,%s,%s,%s)
            on conflict (url,sha256) do update set last_seen_at=greatest(licitor_ingestion.captures.last_seen_at,excluded.last_seen_at)""",
            (url, digest, kind, observed, observed, gzip.compress(body)),
        )
        return self.one("select * from licitor_ingestion.captures where url=%s and sha256=%s", (url, digest))

    def register(self, url: str) -> dict:
        identity = announcement_id(url)
        self.db.execute(
            "insert into licitor_ingestion.announcements(id,canonical_url) values (%s,%s) on conflict do nothing",
            (identity, url),
        )
        self.db.execute("insert into licitor_ingestion.aliases values (%s,%s) on conflict do nothing", (url, identity))
        return self.one("select * from licitor_ingestion.announcements where id=%s", (identity,))

    def known_alias(self, url: str) -> bool:
        return bool(
            self.one(
                """select a.url from licitor_ingestion.aliases a join licitor_ingestion.announcements n
            on n.id=a.announcement_id where a.url=%s and n.current_capture_hash is not null""",
                (url,),
            )
        )

    def entries(self, identity: str) -> list[LicitorHistoryIndexEntry]:
        rows = self.db.execute(
            """select distinct on (e.detail_url,e.payload->>'city') e.payload
            from licitor_ingestion.index_entries e join licitor_ingestion.runs r on r.id=e.run_id
            where e.announcement_id=%s order by e.detail_url,e.payload->>'city',r.created_at desc,e.position""",
            (identity,),
        ).fetchall()
        entries = []
        for item in rows:
            value = item["payload"]
            value["result_date"] = date.fromisoformat(value["result_date"]) if value.get("result_date") else None
            value["hammer_price_eur"] = (
                Decimal(value["hammer_price_eur"]) if value.get("hammer_price_eur") is not None else None
            )
            entries.append(LicitorHistoryIndexEntry(**value))
        return entries

    def save_page(
        self, task: dict, page: Any, following: str | None, *, old_known: bool, refresh_ids: set[str],
        eligible_ids: set[str] | None = None,
    ) -> None:
        with self.guarded():
            self.db.execute(
                """insert into licitor_ingestion.index_pages
                (run_id,url,zone,page_number,entry_count,declared_total,declared_pages,next_url,old_known_page)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict (run_id,url) do update
                set entry_count=excluded.entry_count,declared_total=excluded.declared_total,declared_pages=excluded.declared_pages,
                next_url=excluded.next_url,old_known_page=excluded.old_known_page,observed_at=now()""",
                (
                    task["run_id"],
                    task["url"],
                    task["zone"],
                    task["page_number"],
                    len(page.entries),
                    page.declared_total,
                    page.declared_pages,
                    following,
                    old_known,
                ),
            )
            self.db.execute(
                "delete from licitor_ingestion.index_entries where run_id=%s and page_url=%s",
                (task["run_id"], task["url"]),
            )
            for entry in page.entries:
                announcement = self.register(entry.source_url)
                value = json.loads(json_text(asdict(entry)))
                self.db.execute(
                    "insert into licitor_ingestion.index_entries values (%s,%s,%s,%s,%s,%s)",
                    (
                        task["run_id"],
                        task["url"],
                        entry.page_position,
                        announcement["id"],
                        entry.source_url,
                        Jsonb(value),
                    ),
                )
                if eligible_ids is None or announcement["id"] in eligible_ids:
                    self.enqueue(
                        task["run_id"], "detail", announcement["canonical_url"], refresh=announcement["id"] in refresh_ids
                    )
            if following:
                self.enqueue(
                    task["run_id"],
                    "index",
                    following,
                    zone=task["zone"],
                    page_number=task["page_number"] + 1,
                    refresh=task["refresh"],
                )
            self.done(task)

    def save_candidates(self, task: dict, rows: list[dict], capture: dict, *, cutoff: date | None = None) -> None:
        identity = announcement_id(task["url"])
        aliases = [
            item["url"]
            for item in self.db.execute(
                "select url from licitor_ingestion.aliases where announcement_id=%s order by url", (identity,)
            )
        ]
        with self.guarded():
            previous = {
                r["external_id"]: r["payload"]
                for r in self.db.execute(
                    "select external_id,payload from licitor_ingestion.candidates where announcement_id=%s", (identity,)
                )
            }
            new_ids = {row["external_id"] for row in rows}
            # A disappearing lot is retained and quarantined, never silently deleted.
            for missing_id in previous.keys() - new_ids:
                old = previous[missing_id]
                if cutoff and (not old.get("sale_date") or old["sale_date"] < cutoff.isoformat()):
                    continue
                old["quality_flags"] = sorted(set(old["quality_flags"]) | {"lot_missing_in_latest_capture"})
                self.upsert_candidate(old, identity)
            for row in rows:
                if cutoff and (not row.get("sale_date") or not cutoff.isoformat() <= row["sale_date"] <= datetime.now(UTC).date().isoformat()):
                    self.event(task["run_id"], "candidate_outside_window", {"external_id": row["external_id"]})
                    continue
                old = previous.get(row["external_id"])
                if old:
                    row["quality_flags"] = sorted(
                        set(row["quality_flags"])
                        | (
                            set(old["quality_flags"])
                            & {"source_result_changed_pending_review", "conflicting_announcement_alias_capture"}
                        )
                    )
                if old and any(
                    old.get(k) != row.get(k)
                    for k in ("starting_price_eur", "adjudication_price_eur", "sale_date", "tribunal")
                ):
                    row["quality_flags"].append("source_result_changed_pending_review")
                row.update(
                    source_announcement_id=identity, source_alias_urls=aliases, collector_version="licitor-cloud/2"
                )
                evidence = list(old.get("source_capture_evidence", [])) if old else []
                observed = {
                    "url": task["url"],
                    "captured_at": capture["last_seen_at"].isoformat(),
                    "sha256": capture["sha256"],
                }
                if observed not in evidence:
                    evidence.append(observed)
                row["source_capture_evidence"] = evidence
                self.upsert_candidate(row, identity)
            self.db.execute(
                """update licitor_ingestion.announcements set current_capture_hash=%s,parsed_at=now(),
                parser_version=%s where id=%s""",
                (capture["sha256"], LICITOR_HISTORY_CONNECTOR_VERSION, identity),
            )
            self.done(task)

    def upsert_candidate(self, row: dict, identity: str) -> None:
        payload = Jsonb(row)
        digest = hashlib.sha256(json_text(row).encode()).hexdigest()
        self.db.execute(
            "insert into licitor_ingestion.candidate_versions(external_id,version_hash,payload) values (%s,%s,%s) on conflict do nothing",
            (row["external_id"], digest, payload),
        )
        self.db.execute(
            """insert into licitor_ingestion.candidates(external_id,announcement_id,payload) values (%s,%s,%s)
            on conflict (external_id) do update set payload=excluded.payload,updated_at=now()""",
            (row["external_id"], identity, payload),
        )

    def event(self, run_id: str | None, event: str, summary: dict) -> None:
        self.db.execute(
            "insert into licitor_ingestion.events(run_id,event,summary) values (%s,%s,%s)",
            (run_id, event, Jsonb(summary)),
        )

    def summary(self) -> dict:
        control = self.control()
        counts = self.one("""select (select count(*) from licitor_ingestion.candidates) as candidate_lots,
            (select count(*) from licitor_ingestion.active_candidates) as active_candidate_lots,
            (select count(*) from licitor_ingestion.announcements where current_capture_hash is not null) as parsed_announcements,
            (select count(*) from licitor_ingestion.captures) as source_captures""")
        runs = self.db.execute("""select r.*, (select count(*) from licitor_ingestion.tasks t where t.run_id=r.id and t.status='error') as errors,
            (select count(*) from licitor_ingestion.tasks t where t.run_id=r.id and t.status in ('pending','working')) as pending_tasks
            from licitor_ingestion.runs r order by created_at desc limit 5""").fetchall()
        return {
            "enabled": bool(control and control["enabled"]),
            "monthly_enabled": bool(control and control["monthly_enabled"]),
            "network_paused": bool(control and control["network_paused"]),
            "lease_until": control.get("lease_until") if control else None,
            **counts,
            "outside_window_candidate_lots": counts["candidate_lots"] - counts["active_candidate_lots"],
            "window_start": licitor_window_start(datetime.now(UTC).date()),
            "window_end": datetime.now(UTC).date(),
            "window_months": 36,
            "runs": runs,
            "publication_eligible": False,
            "collector_version": "licitor-cloud/2",
        }
