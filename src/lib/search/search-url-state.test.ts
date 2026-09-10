import { describe, expect, it } from "vitest";
import { mergeSalesSearch, salesSearchToUrlRecord, validateSalesSearch } from "./search-url-state";

describe("sales search URL state", () => {
  it("round-trips sale families and resets pagination when the family changes", () => {
    const next = mergeSalesSearch(
      { saleType: "tribunal", page: 4, city: "Bordeaux" },
      { saleType: "notary" },
    );
    expect(next.page).toBeUndefined();
    expect(validateSalesSearch(salesSearchToUrlRecord(next))).toMatchObject({
      saleType: "notary",
      city: "Bordeaux",
    });
    expect(validateSalesSearch({ saleType: "online" }).saleType).toBeUndefined();
    expect(validateSalesSearch({ saleType: "invalid" }).saleType).toBeUndefined();
  });

  it("preserves numeric-looking geographic searches parsed by the router", () => {
    expect(validateSalesSearch({ q: 33000, department: 33 })).toMatchObject({
      query: "33000",
      department: "33",
    });
  });

  it("parses a SeLoger-style base64 bbox as a viewport", () => {
    const search = validateSalesSearch({
      bbox: "LTEuNzU5NDgwMTAyNDU2NzM0Niw0My45NjE1MDg0Mzg5MTY1MjUsMS4yODI2MTcxNTQ0Mzg0MTI0LDQ1LjQzNjcyMzc4NjY3NjEx",
    });

    expect(search.viewport).toEqual({
      east: 1.2826171544384124,
      north: 45.43672378667611,
      south: 43.961508438916525,
      west: -1.7594801024567346,
    });
  });

  it("serializes viewport filters as a shareable bbox", () => {
    const record = salesSearchToUrlRecord({
      viewport: {
        east: 1.2826171544384124,
        north: 45.43672378667611,
        south: 43.961508438916525,
        west: -1.7594801024567346,
      },
    });

    expect(record).toMatchObject({
      bbox: "-1.75948,43.96151,1.28262,45.43672",
    });
    expect(record.viewport).toBeUndefined();
  });
});
