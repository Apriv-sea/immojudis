import { describe, expect, it } from "vitest";
import { saleDateBoundary, validSaleDate } from "./sale-date-range";
import { validateSalesSearch, salesSearchToUrlRecord } from "./search-url-state";

describe("French auction calendar dates", () => {
  it("rejects malformed and impossible dates", () => {
    for (const value of ["2026-02-30", "bad", "2026-9-1", "2026-09-11T00:00:00Z"])
      expect(validSaleDate(value)).toBeUndefined();
    expect(validSaleDate("2028-02-29")).toBe("2028-02-29");
  });
  it("includes the entire local day through summer/winter time changes", () => {
    expect(saleDateBoundary("2026-09-11")).toBe("2026-09-10T22:00:00.000Z");
    expect(saleDateBoundary("2026-09-11", true)).toBe("2026-09-11T21:59:59.999Z");
    expect(saleDateBoundary("2026-03-29")).toBe("2026-03-28T23:00:00.000Z");
    expect(saleDateBoundary("2026-03-29", true)).toBe("2026-03-29T21:59:59.999Z");
  });
  it("preserves both boundaries in shared search links", () => {
    const search = { minSaleDate: "2026-09-11", maxSaleDate: "2026-10-01" };
    expect(validateSalesSearch(salesSearchToUrlRecord(search))).toMatchObject(search);
  });
});
