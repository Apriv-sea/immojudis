import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Result<T> = { data: T | null; error: { message?: string } | null };
type StorageItem = { id: string; bucket: string; object_path: string };
type RetentionClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Result<{ deleted: number; remaining: number | null; busy: boolean }>>;
  from(name: string): {
    select(columns: string): {
      order(column: string): { limit(count: number): Promise<Result<StorageItem[]>> };
    };
    delete(): { eq(column: string, value: string): Promise<Result<unknown>> };
  };
  storage: { from(bucket: string): { remove(paths: string[]): Promise<Result<unknown>> } };
};

/** Bounded transactions; the durable outbox survives Storage API failures. */
export async function runSaleRetention(
  now = new Date(),
  client = supabaseAdmin as unknown as RetentionClient,
): Promise<Record<string, unknown>> {
  let deleted = 0;
  let remaining: number | null = null;
  let busy = false;
  const started = Date.now();
  for (let batch = 0; batch < 12 && Date.now() - started < 180_000; batch++) {
    const result = await client.rpc("purge_expired_auction_sales", {
      p_now: now.toISOString(),
      p_limit: 25,
    });
    if (result.error || !result.data)
      throw new Error(result.error?.message || "Missing retention result");
    deleted += result.data.deleted;
    remaining = result.data.remaining;
    busy = result.data.busy;
    if (busy || !remaining || !result.data.deleted) break;
  }
  const queue = await client
    .from("sale_retention_storage_queue")
    .select("id,bucket,object_path")
    .order("created_at")
    .limit(100);
  if (queue.error) throw new Error(queue.error.message || "Storage retention queue unavailable");
  let filesDeleted = 0;
  for (const item of queue.data ?? []) {
    if (!["information-agent-evidence", "information-agent-approved"].includes(item.bucket)) {
      throw new Error("Unexpected retention bucket");
    }
    const removal = await client.storage.from(item.bucket).remove([item.object_path]);
    if (removal.error) throw new Error(removal.error.message || "Storage retention failed");
    const ack = await client.from("sale_retention_storage_queue").delete().eq("id", item.id);
    if (ack.error) throw new Error(ack.error.message || "Storage retention acknowledgement failed");
    filesDeleted++;
  }
  return { deleted, remaining, busy, filesDeleted };
}
