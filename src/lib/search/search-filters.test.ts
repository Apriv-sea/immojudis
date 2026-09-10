import { describe, expect, it } from "vitest";
import {
  applyClientSearchFilters,
  dataFiltersFromSearch,
  countActiveSearchFilters,
  hasClientOnlyFilters,
  saleIsInViewport,
} from "./search-filters";
import type { ViewportBounds } from "./search-url-state";
import type { AuctionSale } from "@/lib/types";

describe("sales search filters", () => {
  it("filters the family on the server and consistently in derived local results", () => {
    expect(dataFiltersFromSearch({ saleType: "notary" })).toMatchObject({
      sale_venue_type: "notary",
    });
    expect(hasClientOnlyFilters({ saleType: "notary" })).toBe(false);
    expect(countActiveSearchFilters({ saleType: "notary" })).toBe(1);
    const items = ["tribunal", "notary", "state", "online", "unknown"].map(
      (type) => ({ id: type, sale_venue_type: type }) as AuctionSale,
    );
    expect(applyClientSearchFilters(items, { saleType: "notary" }, null).map((s) => s.id)).toEqual([
      "notary",
    ]);
    expect(applyClientSearchFilters(items, { saleType: "unknown" }, null).map((s) => s.id)).toEqual(
      ["online", "unknown"],
    );
  });

  it.each([
    [
      "Nouvelle-Aquitaine",
      { departments: ["16", "17", "19", "23", "24", "33", "40", "47", "64", "79", "86", "87"] },
    ],
    ["Gironde", { departments: ["33"] }],
    ["33", { departments: ["33"] }],
    ["33000", { postal_code: "33000" }],
    ["Bordeaux", { keywords: "Bordeaux" }],
  ])("turns the main query %s into the expected data filter", (query, expected) => {
    expect(dataFiltersFromSearch({ query })).toMatchObject(expected);
  });

  it("accepts a department name in the dedicated department filter", () => {
    expect(dataFiltersFromSearch({ department: "département de la Gironde" })).toMatchObject({
      departments: ["33"],
    });
  });

  it("keeps all free-text terms when advanced keywords are also present", () => {
    expect(dataFiltersFromSearch({ query: "Bordeaux", keywords: "maison jardin" })).toMatchObject({
      keywords: "Bordeaux maison jardin",
    });
  });

  it("passes viewport bounds to server-side filters", () => {
    const viewport: ViewportBounds = {
      east: 1.28,
      north: 45.43,
      south: 43.96,
      west: -1.75,
    };

    expect(dataFiltersFromSearch({ viewport })).toMatchObject({ viewport });
    expect(hasClientOnlyFilters({ viewport })).toBe(false);
  });

  it("filters visible sales when the map viewport changes", () => {
    const bordeauxViewport: ViewportBounds = {
      east: -0.1,
      north: 45.1,
      south: 44.5,
      west: -0.9,
    };
    const bordeauxSale = sale("bordeaux", 44.8378, -0.5792);
    const parisSale = sale("paris", 48.8566, 2.3522);
    const hiddenSale = sale("hidden", null, null);

    expect(saleIsInViewport(bordeauxSale, bordeauxViewport)).toBe(true);
    expect(saleIsInViewport(parisSale, bordeauxViewport)).toBe(false);
    expect(
      applyClientSearchFilters(
        [bordeauxSale, parisSale, hiddenSale],
        { viewport: bordeauxViewport },
        null,
      ).map((item) => item.id),
    ).toEqual(["bordeaux"]);
  });

  it("applies region, postal-code and accent-insensitive city searches on loaded results", () => {
    const bordeauxSale = {
      ...sale("bordeaux", 44.8378, -0.5792),
      city: "Bordeaux",
      department: "33",
      postal_code: "33000",
    };
    const nimesSale = {
      ...sale("nimes", 43.8367, 4.3601),
      city: "Nîmes",
      department: "30",
      postal_code: "30000",
    };

    expect(
      applyClientSearchFilters(
        [bordeauxSale, nimesSale],
        { query: "Nouvelle-Aquitaine" },
        null,
      ).map((item) => item.id),
    ).toEqual(["bordeaux"]);
    expect(
      applyClientSearchFilters([bordeauxSale, nimesSale], { query: "33000" }, null).map(
        (item) => item.id,
      ),
    ).toEqual(["bordeaux"]);
    expect(
      applyClientSearchFilters([bordeauxSale, nimesSale], { query: "Nimes" }, null).map(
        (item) => item.id,
      ),
    ).toEqual(["nimes"]);
  });
});

function sale(id: string, latitude: number | null, longitude: number | null): AuctionSale {
  return {
    id,
    title: id,
    latitude,
    longitude,
    source_blocks: null,
    documents_rich: null,
  } as AuctionSale;
}
