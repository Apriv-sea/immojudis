"""Replay the sale retention function against disposable PostgreSQL."""
import os
from datetime import UTC, datetime

import pytest
from psycopg.types.json import Jsonb
from test_autonomy_postgres import migration

from src.storage.supabase_client import _postgres_connect


def test_sale_retention_date_only_and_existing_safety_conditions():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            db.execute("create schema if not exists app_private")
            for role in ("anon", "authenticated", "service_role"):
                db.execute(
                    f"do $$ begin if not exists(select from pg_roles where rolname='{role}') "
                    f"then create role {role}; end if; end $$"
                )
            db.execute(migration("20260913100110_sale_retention_date_only_deadline.sql"))

            def deadline(sale_date, status="upcoming", procedure=None, raw=None):
                return db.execute(
                    "select app_private.sale_retention_deadline(%s,%s,%s,%s)",
                    (sale_date, status, Jsonb(procedure or {}), Jsonb(raw or {})),
                ).fetchone()[0]

            assert deadline("2026-09-10 00:00Z", raw={"sale_date": "10/09/2026"}) == datetime(
                2026, 9, 11, 22, tzinfo=UTC
            )
            assert deadline("2026-03-29 00:00Z", raw={"sale_date": "2026-03-29"}) == datetime(
                2026, 3, 30, 22, tzinfo=UTC
            )
            assert deadline("2026-10-25 00:00Z", raw={"sale_date": "2026-10-25"}) == datetime(
                2026, 10, 26, 23, tzinfo=UTC
            )
            assert deadline(
                "2026-09-10 00:00Z",
                raw={
                    "sale_date": "2026-09-10T00:00:00Z",
                    "date_precision": "  ",
                    "sale_date_precision": " day ",
                },
            ) == datetime(2026, 9, 11, 22, tzinfo=UTC)
            assert deadline(
                "2026-10-25 00:00:00+02:00",
                raw={"sale_date": "2026-10-25T00:00:00+02:00", "date_precision": "day"},
            ) == datetime(2026, 10, 26, 23, tzinfo=UTC)
            assert deadline("2026-09-10 12:00Z", raw={"sale_date": "10/09/2026 à 14h"}) == datetime(
                2026, 9, 11, 12, tzinfo=UTC
            )
            assert deadline("2026-09-10 00:00Z", raw={"source_date": "2026-09-10"}) == datetime(
                2026, 9, 11, tzinfo=UTC
            )
            assert deadline(
                "2026-09-10 00:00Z",
                procedure={"sale_window": {"opens_at": "2026-09-10T10:00:00Z", "closes_at": "2026-09-10T14:00:00Z"}},
                raw={"sale_date": "2026-09-10"},
            ) == datetime(2026, 9, 11, 14, tzinfo=UTC)
            assert deadline("2026-09-10 00:00Z", status="postponed") is None
            assert deadline(
                "2026-09-10 00:00Z", raw={"source_conflicts": [{"field": "sale_date"}]}
            ) is None
            assert deadline(
                "2026-09-10 00:00Z",
                procedure={"sale_window": {"opens_at": "bad", "closes_at": "bad"}},
            ) is None
        finally:
            db.rollback()
