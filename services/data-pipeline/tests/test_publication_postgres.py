"""Integration test against a disposable database, never the application DB."""
import os

import pytest

from src.storage import supabase_client as storage


def test_real_postgres_typed_writes_and_atomic_rollback():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("PIPELINE_TEST_DB_URL must name a disposable database")
    with storage._postgres_connect(url) as connection:
        connection.execute("create table if not exists public.pipeline_test_parent (id text primary key, data jsonb, tags text[], amount numeric)")
        connection.execute("create table if not exists public.pipeline_test_child (id text references public.pipeline_test_parent(id), kind text, value integer check(value > 0), primary key(id, kind))")
        connection.execute("truncate public.pipeline_test_parent, public.pipeline_test_child")
    try:
        with storage._postgres_connect(url) as connection:
            token = storage._PUBLICATION_CONNECTION.set(connection)
            try:
                storage._transaction_write("pipeline_test_parent", [{"id": "a", "data": {"preuve": "écrite"}, "tags": ["a", "b"], "amount": 12.5}], "id")
                storage._transaction_write("pipeline_test_child", [{"id": "a", "kind": "surface", "value": 42}], "id,kind")
                storage._transaction_write("pipeline_test_child", [{"id": "a", "kind": "surface", "value": 43}], "id,kind")
            finally:
                storage._PUBLICATION_CONNECTION.reset(token)
        with storage._postgres_connect(url) as connection:
            assert connection.execute("select value from public.pipeline_test_child").fetchone()[0] == 43
            assert connection.execute("select data->>'preuve', tags from public.pipeline_test_parent").fetchone() == ("écrite", ["a", "b"])
        with pytest.raises(storage.psycopg.errors.CheckViolation):
            with storage._postgres_connect(url) as connection:
                token = storage._PUBLICATION_CONNECTION.set(connection)
                try:
                    storage._transaction_write("pipeline_test_parent", [{"id": "b", "amount": 1}], "id")
                    storage._transaction_write("pipeline_test_child", [{"id": "b", "kind": "surface", "value": -1}], "id,kind")
                finally:
                    storage._PUBLICATION_CONNECTION.reset(token)
        with storage._postgres_connect(url) as connection:
            assert connection.execute("select count(*) from public.pipeline_test_parent where id='b'").fetchone()[0] == 0
    finally:
        with storage._postgres_connect(url) as connection:
            connection.execute("drop table public.pipeline_test_child, public.pipeline_test_parent")
