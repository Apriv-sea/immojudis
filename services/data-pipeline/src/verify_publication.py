"""Exercise production publication SQL in a transaction that always rolls back."""
from src.config import load_settings
from src.storage import supabase_client as storage


class VerificationRollback(Exception):
    pass


def main() -> int:
    settings = load_settings()
    if not settings.get("supabase_db_url"):
        raise RuntimeError("Publication verification requires SUPABASE_DB_URL")
    with storage._postgres_connect(str(settings["supabase_db_url"])) as connection:
        source = connection.execute("""
            select source_url from public.auction_sales
            where status in ('active', 'upcoming') order by updated_at desc limit 1
        """).fetchone()
    if not source:
        raise RuntimeError("No active sale available for verification")
    sale = storage.fetch_sale_for_data_refresh(source[0])
    if sale is None:
        raise RuntimeError("Cannot hydrate verification sale")
    try:
        with storage._postgres_connect(str(settings["supabase_db_url"])) as connection:
            connection.execute("set local lock_timeout='10s'")
            connection.execute("set local statement_timeout='60s'")
            token = storage._PUBLICATION_CONNECTION.set(connection)
            try:
                storage.upsert_sales_to_supabase([sale], refresh_last_seen=False)
                raise VerificationRollback()
            finally:
                storage._PUBLICATION_CONNECTION.reset(token)
    except VerificationRollback:
        print("Publication schema verified; transaction rolled back. No changes committed.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
