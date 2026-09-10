import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, test } from "vitest";
import { publishStoredEstimateForClaim } from "./sale-market-estimates";

// Explicit opt-in: this test creates and removes a fixture on loopback only.
const databaseUrl = process.env.ANNONCE_LOCAL_DB_URL;
test.skipIf(!databaseUrl)(
  "an expired lease cannot overwrite a renewed lease with identical inputs",
  async () => {
    expect(new URL(databaseUrl!).hostname).toBe("127.0.0.1");
    expect(new URL(process.env.SUPABASE_URL!).hostname).toBe("127.0.0.1");
    const sql = postgres(databaseUrl!, { max: 3 });
    const id = randomUUID();
    const fingerprint = `lease-test:${id}`;
    const oldClaim = { attempt_count: 1, last_started_at: "2026-09-10T08:00:00.000Z" };
    const newClaim = { attempt_count: 2, last_started_at: "2026-09-10T08:02:00.000Z" };
    let stale: Promise<boolean> | undefined;
    try {
      await sql`insert into auction_sales (id, source_name, source_url) values (${id}, 'annonce-local-concurrency-test', ${`https://example.invalid/${id}`})`;
      await sql`insert into auction_sale_market_estimates (auction_sale_id, status, input_fingerprint, attempt_count, last_started_at) values (${id}, 'processing', ${fingerprint}, 1, ${oldClaim.last_started_at}) on conflict (auction_sale_id) do update set status = excluded.status, input_fingerprint = excluded.input_fingerprint, attempt_count = excluded.attempt_count, last_started_at = excluded.last_started_at`;
      await sql.begin(async (transaction) => {
        const [{ pid }] = await transaction`select pg_backend_pid() as pid`;
        await transaction`update auction_sale_market_estimates set attempt_count = 2, last_started_at = ${newClaim.last_started_at} where auction_sale_id = ${id}`;
        stale = publishStoredEstimateForClaim(id, fingerprint, oldClaim, {
          status: "failed",
          error_message: "stale worker",
        });
        // Prove overlap using PostgreSQL's actual blocker, not an arbitrary delay.
        await expect
          .poll(
            async () => {
              const [{ blocked }] =
                await sql`select exists(select 1 from pg_stat_activity where ${pid}::integer = any(pg_blocking_pids(pid))) as blocked`;
              return blocked;
            },
            { timeout: 5000 },
          )
          .toBe(true);
      });
      expect(await stale).toBe(false);
      expect(
        await publishStoredEstimateForClaim(id, fingerprint, newClaim, {
          status: "insufficient_data",
          error_message: "fresh worker",
        }),
      ).toBe(true);
      expect(
        await publishStoredEstimateForClaim(id, fingerprint, oldClaim, {
          status: "failed",
          error_message: "stale worker",
        }),
      ).toBe(false);
      const [row] =
        await sql`select status, error_message, attempt_count from auction_sale_market_estimates where auction_sale_id = ${id}`;
      expect(row).toEqual({
        status: "insufficient_data",
        error_message: "fresh worker",
        attempt_count: 2,
      });
    } finally {
      await stale?.catch(() => undefined);
      // Local synthetic fixtures must not create permanent Outcome Graph history.
      await sql.begin(async (cleanup) => {
        await cleanup`set local session_replication_role = replica`;
        await cleanup`delete from auction_sale_market_estimates where auction_sale_id = ${id}`;
        await cleanup`delete from auction_sales where id = ${id} and source_name = 'annonce-local-concurrency-test'`;
      });
      const [{ count }] =
        await sql`select count(*)::integer as count from auction_sale_market_estimates where auction_sale_id = ${id}`;
      expect(count).toBe(0);
      await sql.end();
    }
  },
  15000,
);
