"""Check the raw-jsonb retention optimization against the prior function."""

import os

import pytest
from psycopg.types.json import Jsonb
from test_autonomy_postgres import migration

from src.storage.supabase_client import _postgres_connect

BASELINE_MIGRATION = "20260913100110_sale_retention_date_only_deadline.sql"
OPTIMIZED_MIGRATION = "20260913113416_optimize_sale_retention_raw_jsonb.sql"


class _SqlNull:
    pass


SQL_NULL = _SqlNull()


def _prepare(db) -> None:
    db.execute("create schema if not exists app_private")
    for role in ("anon", "authenticated", "service_role"):
        db.execute(
            f"do $$ begin if not exists(select from pg_roles where rolname='{role}') "
            f"then create role {role}; end if; end $$"
        )
    db.execute(migration(BASELINE_MIGRATION))
    db.execute(
        "alter function app_private.sale_retention_deadline(timestamptz,text,jsonb,jsonb) "
        "rename to sale_retention_deadline_reference"
    )
    db.execute(migration(OPTIMIZED_MIGRATION))


def _json_parameter(value):
    return None if value is SQL_NULL else Jsonb(value)


CASES = [
    ("timed date", "2026-09-10 12:00Z", "upcoming", {}, {"sale_date": "10/09/2026 à 14h"}),
    ("date only", "2026-09-10 00:00Z", "upcoming", {}, {"sale_date": "2026-09-10"}),
    ("date precision day", "2026-09-10 00:00Z", "upcoming", {}, {"date_precision": "day"}),
    ("date precision alias", "2026-09-10 00:00Z", "upcoming", {}, {"sale_date_precision": " unknown_time "}),
    ("date without hour", "2026-03-29 00:00Z", "upcoming", {}, {"sale_date": "2026-03-29"}),
    ("date at autumn timezone", "2026-10-25 00:00:00+02:00", "upcoming", {}, {"sale_date": "2026-10-25", "date_precision": "date_only"}),
    ("explicit timezone", "2026-09-10 12:00+05:30", "upcoming", {}, {"sale_date": "2026-09-10T12:00:00+05:30"}),
    ("missing raw date", "2026-09-10 00:00Z", "upcoming", {}, {"source_date": "2026-09-10"}),
    ("raw postponed", "2026-09-10 00:00Z", "upcoming", {}, {"status": "postponed"}),
    ("raw reported accent", "2026-09-10 00:00Z", "upcoming", {}, {"status": "REPORTÉE"}),
    ("raw reported english", "2026-09-10 00:00Z", "upcoming", {}, {"status": "reported"}),
    ("status postponed", "2026-09-10 00:00Z", "postponed", {}, {}),
    ("status reported accent", "2026-09-10 00:00Z", "reportée", {}, {}),
    ("sale date contradiction", "2026-09-10 00:00Z", "upcoming", {}, {"source_conflicts": [{"field": "sale_date"}]}),
    ("other conflict only", "2026-09-10 00:00Z", "upcoming", {}, {"source_conflicts": [{"field": "price"}]}),
    (
        "VNI sale window",
        "2026-09-10 00:00Z",
        "upcoming",
        {"sale_window": {"opens_at": "2026-09-10T10:00:00Z", "closes_at": "2026-09-10T14:00:00Z"}},
        {"typeTransaction": "VNI", "vni": {"dateFinEncheres": "2026-09-10T14:00:00Z"}},
    ),
    (
        "VNI source schedule",
        "2026-09-10 00:00Z",
        "upcoming",
        {},
        {"typeTransaction": "VNI", "source_sale_schedule": {"opens_at": "2026-09-10T10:00:00Z", "closes_at": "2026-09-10T14:00:00Z"}},
    ),
    (
        "invalid schedule",
        "2026-09-10 00:00Z",
        "upcoming",
        {"sale_window": {"opens_at": "invalid", "closes_at": "also-invalid"}},
        {},
    ),
    (
        "reversed schedule",
        "2026-09-10 00:00Z",
        "upcoming",
        {"sale_session": {"opens_at": "2026-09-10T15:00:00Z", "closes_at": "2026-09-10T14:00:00Z"}},
        {},
    ),
    ("raw json array", "2026-09-10 00:00Z", "upcoming", {}, ["not-an-object"]),
    ("raw json scalar", "2026-09-10 00:00Z", "upcoming", {}, 7),
    ("raw json null", "2026-09-10 00:00Z", "upcoming", {}, None),
    ("raw SQL null", "2026-09-10 00:00Z", "upcoming", {}, SQL_NULL),
    ("procedure json array", "2026-09-10 00:00Z", "upcoming", [], {}),
    ("procedure json null", "2026-09-10 00:00Z", "upcoming", None, {}),
    ("null sale date", None, "upcoming", {}, {}),
    ("invalid raw date", "2026-09-10 00:00Z", "upcoming", {}, {"sale_date": "not-a-date"}),
]


def test_optimized_sale_retention_deadline_matches_reference_for_edge_fixtures():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _prepare(db)
            definition = db.execute(
                "select pg_get_functiondef('app_private.sale_retention_deadline(timestamptz,text,jsonb,jsonb)'::regprocedure)"
            ).fetchone()[0]
            assert "v_raw jsonb" in definition
            assert "v_raw->>" in definition
            assert "p_raw->>" not in definition

            for label, sale_date, status, procedure, raw in CASES:
                parameters = (
                    sale_date,
                    status,
                    _json_parameter(procedure),
                    _json_parameter(raw),
                )
                result = db.execute(
                    """
                    select
                      app_private.sale_retention_deadline_reference(%s,%s,%s,%s),
                      app_private.sale_retention_deadline(%s,%s,%s,%s)
                    """,
                    parameters + parameters,
                ).fetchone()
                assert result[0] == result[1], label
        finally:
            db.rollback()
