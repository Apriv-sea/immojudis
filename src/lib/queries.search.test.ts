import { describe, expect, it } from "vitest";
import { getSales } from "./queries";

describe("Supabase sale search query", () => {
  it.each([false, true])(
    "filters sale types before pagination, including preview=%s",
    async (preview) => {
      const builder = new QueryRecorder();
      await getSales({ sale_venue_type: "notary" }, 12, "price_asc", 24, {
        preview,
        discovery: true,
        client: { from: () => builder } as never,
      });
      expect(builder.calls).toContainEqual(["eq", "sale_venue_type", "notary"]);
      expect(builder.calls).toContainEqual(["range", 24, 35]);
      const columns = String(builder.calls.find((call) => call[0] === "select")?.[1]);
      expect(columns).toContain("sale_venue_type");
      expect(columns).toContain("sale_verification_status");
      if (preview) {
        expect(columns).not.toContain("lawyer_contact");
        expect(columns).not.toContain("sale_procedure");
      } else {
        expect(columns).toContain("sale_procedure");
      }
    },
  );

  it("does not treat legacy online entries as an organizer family", async () => {
    const builder = new QueryRecorder();
    await getSales({ sale_venue_type: "unknown" }, 24, "price_asc", 0, {
      client: { from: () => builder } as never,
    });
    expect(builder.calls).toContainEqual(["in", "sale_venue_type", ["unknown", "online"]]);
  });

  it("applies department names, postal codes and accent-tolerant multi-term text filters", async () => {
    const builder = new QueryRecorder();
    const client = { from: () => builder };

    await getSales(
      {
        departments: ["33"],
        postal_code: "33000",
        keywords: "Nimes centre",
      },
      24,
      "score_desc",
      0,
      { client: client as never },
    );

    expect(builder.calls).toContainEqual(["in", "department", ["33", "Gironde"]]);
    expect(builder.calls).toContainEqual(["eq", "postal_code", "33000"]);

    const orFilters = builder.calls
      .filter((call) => call[0] === "or")
      .map((call) => String(call[1]));
    expect(orFilters).toHaveLength(2);
    expect(orFilters[0]).toContain("city.ilike.%nimes%");
    expect(orFilters[0]).toContain("city.ilike.%n_mes%");
    expect(orFilters[1]).toContain("postal_code.ilike.%centre%");
  });
});

class QueryRecorder implements PromiseLike<{ data: []; error: null }> {
  calls: unknown[][] = [];

  select(...args: unknown[]) {
    return this.record("select", ...args);
  }

  order(...args: unknown[]) {
    return this.record("order", ...args);
  }

  range(...args: unknown[]) {
    return this.record("range", ...args);
  }

  eq(...args: unknown[]) {
    return this.record("eq", ...args);
  }

  gte(...args: unknown[]) {
    return this.record("gte", ...args);
  }

  lte(...args: unknown[]) {
    return this.record("lte", ...args);
  }

  in(...args: unknown[]) {
    return this.record("in", ...args);
  }

  ilike(...args: unknown[]) {
    return this.record("ilike", ...args);
  }

  or(...args: unknown[]) {
    return this.record("or", ...args);
  }

  then<TResult1 = { data: []; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: []; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: [] as [], error: null }).then(onfulfilled, onrejected);
  }

  private record(method: string, ...args: unknown[]) {
    this.calls.push([method, ...args]);
    return this;
  }
}
