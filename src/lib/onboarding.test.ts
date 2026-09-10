import { describe, expect, it } from "vitest";
import { firstSearchToUrl, postAuthDestination } from "./onboarding";
import { validateSalesSearch } from "./search/search-url-state";

describe("first-search onboarding", () => {
  it("guides new investors, including a generic catalogue redirect", () => {
    expect(postAuthDestination({ mode: "investor", professional: false })).toBe("/bienvenue");
    expect(postAuthDestination({ mode: "investor", professional: false, redirect: "/sales" })).toBe(
      "/bienvenue",
    );
  });
  it.each([
    "/sales/sale-1",
    "/sales?query=Bordeaux",
    "/accompagnement?checkout=success",
    "/mes-droits",
  ])("preserves an explicit destination: %s", (redirect) => {
    expect(postAuthDestination({ mode: "investor", professional: false, redirect })).toBe(redirect);
  });
  it("leaves login and professional destinations unchanged", () => {
    expect(postAuthDestination({ mode: "login", professional: false })).toBe("/sales");
    expect(postAuthDestination({ mode: "professional", professional: true })).toBe("/publish");
    expect(postAuthDestination({ mode: "login", professional: true })).toBe("/publish");
  });
  it("uses the catalogue URL contract without enabling paid filters", () => {
    const record = firstSearchToUrl({
      area: "  Bordeaux  ",
      maxPrice: "150000",
      homeType: "house",
    });
    expect(record).toEqual({ query: "Bordeaux", maxPrice: 150000, homeTypes: "house" });
    expect(validateSalesSearch(record)).toMatchObject({
      query: "Bordeaux",
      maxPrice: 150000,
      homeTypes: ["house"],
    });
  });
  it.each(["", "-1", "Infinity", "NaN", "1e20"])(
    "ignores an invalid optional ceiling: %s",
    (maxPrice) => {
      expect(firstSearchToUrl({ area: "  ", maxPrice, homeType: "unknown" })).toEqual({
        query: undefined,
        maxPrice: undefined,
        homeTypes: undefined,
      });
    },
  );
});
