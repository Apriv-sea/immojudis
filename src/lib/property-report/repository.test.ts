import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { queryActiveComparableSales } from "./repository";

function database(rows: unknown[], failureAt?: number) {
  const query = {
    select: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    range: vi.fn(async (start: number, end: number) => ({
      data: rows.slice(start, end + 1),
      error: start === failureAt ? new Error("Page indisponible") : null,
    })),
  };
  return { query, client: { from: () => query } as unknown as SupabaseClient };
}
const options = {
  sale: EXAMPLE_SALE,
  scope: { label: "Même ville", city: EXAMPLE_SALE.city },
  nowIso: "2026-09-17T08:00:00Z",
  limit: 2,
};
const closed = Array.from({ length: 64 }, (_, index) => ({
  ...EXAMPLE_SALE,
  id: `closed-${index}`,
  status: "cancelled",
  sale_date: "2026-09-18T12:00:00Z",
}));
const open = {
  ...EXAMPLE_SALE,
  id: "ongoing",
  status: "upcoming",
  sale_date: "2026-09-16T13:00:00Z",
  sale_procedure: {
    sale_window: { opens_at: "2026-09-16T13:00:00Z", closes_at: "2026-09-17T13:00:00Z" },
  },
};

describe("active comparable query pagination", () => {
  it("finds active candidates beyond an entirely excluded first page, before applying the limit", async () => {
    const { client, query } = database([
      ...closed,
      open,
      { ...open, id: "second" },
      { ...open, id: "third" },
    ]);
    const rows = await queryActiveComparableSales({ ...options, supabase: client });
    expect(rows.map((row) => row.id)).toEqual(["ongoing", "second"]);
    expect(query.range.mock.calls).toEqual([
      [0, 63],
      [64, 127],
    ]);
  });
  it("terminates after an empty page when a full page has no eligible candidates", async () => {
    const { client, query } = database(closed);
    expect(await queryActiveComparableSales({ ...options, supabase: client })).toEqual([]);
    expect(query.range).toHaveBeenCalledTimes(2);
  });
  it("propagates later-page failures instead of returning an apparently complete selection", async () => {
    const { client } = database(closed, 64);
    await expect(queryActiveComparableSales({ ...options, supabase: client })).rejects.toThrow(
      "Page indisponible",
    );
  });
});
