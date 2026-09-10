// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { useSaleComparison } from "./use-sale-comparison";

afterEach(cleanup);

function sale(id: string, overrides: Partial<AuctionSale> = {}): AuctionSale {
  return { id, city: "Bordeaux", property_type: "apartment", ...overrides } as AuctionSale;
}

describe("temporary catalogue comparison", () => {
  it("keeps selection across catalogue rerenders, caps rapid additions and permits replacement", () => {
    const { result, rerender } = renderHook(() => useSaleComparison("anonymous:preview"));
    act(() => {
      for (const id of ["a", "b", "c", "d"]) result.current.toggle(sale(id));
    });
    rerender();
    expect(result.current.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    act(() => result.current.toggle(sale("b")));
    act(() => result.current.toggle(sale("d")));
    expect(result.current.items.map((item) => item.id)).toEqual(["a", "c", "d"]);
    act(() => result.current.remove("a"));
    expect(result.current.items.map((item) => item.id)).toEqual(["c", "d"]);
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
    act(() =>
      result.current.replace(
        ["e", "f", "g", "h"].map((id) => ({
          id,
          city: null,
          department: null,
          propertyType: null,
          venueType: "unknown",
          saleDate: null,
          startingPriceEur: null,
          surfaceM2: null,
          surfaceKind: null,
          rooms: null,
          bedrooms: null,
          bathrooms: null,
        })),
      ),
    );
    expect(result.current.items.map((item) => item.id)).toEqual(["e", "f", "g"]);
  });

  it("never renders the previous selection across account, loading or entitlement changes", () => {
    const renders: string[][] = [];
    const { result, rerender } = renderHook(
      ({ scope }: { scope: string | null }) => {
        const comparison = useSaleComparison(scope);
        renders.push(comparison.items.map((item) => item.id));
        return comparison;
      },
      { initialProps: { scope: "alice:analysis" as string | null } },
    );
    for (const scope of [
      "bob:analysis",
      "bob:discovery",
      null,
      "anonymous:preview",
      "alice:analysis",
    ]) {
      act(() => result.current.toggle(sale("private-selection")));
      renders.length = 0;
      rerender({ scope });
      expect(renders.every((items) => items.length === 0)).toBe(true);
      if (scope == null) {
        act(() => result.current.toggle(sale("ignored-while-loading")));
        expect(result.current.items).toEqual([]);
      }
    }
  });

  it("retains only public facts without inferring missing area or replacing bedrooms with rooms", () => {
    const { result } = renderHook(() => useSaleComparison("alice:analysis"));
    act(() =>
      result.current.toggle(
        sale("a", {
          title: "Secret studio address",
          address: "Private street",
          investment_score: 99,
          lawyer_contact: "private@example.test",
          app_surface_m2: null,
          habitable_surface_m2: 42,
          rooms_count: 1,
          bedrooms_count: null,
          bathrooms_count: 0,
          starting_price_eur: 0,
          app_surface_kind: "habitable",
        }),
      ),
    );
    expect(result.current.items[0]).toEqual({
      id: "a",
      city: "Bordeaux",
      department: null,
      propertyType: "apartment",
      venueType: "unknown",
      saleDate: null,
      startingPriceEur: 0,
      surfaceM2: null,
      surfaceKind: "habitable",
      rooms: 1,
      bedrooms: null,
      bathrooms: 0,
    });
  });

  it("discards invalid numeric and date values", () => {
    const { result } = renderHook(() => useSaleComparison("anonymous:preview"));
    act(() =>
      result.current.toggle(
        sale("a", {
          app_surface_m2: Infinity,
          starting_price_eur: NaN,
          rooms_count: -2,
          bedrooms_count: 1.5,
          bathrooms_count: Infinity,
          sale_date: "invalid",
        }),
      ),
    );
    expect(result.current.items[0]).toMatchObject({
      surfaceM2: null,
      startingPriceEur: null,
      rooms: null,
      bedrooms: null,
      bathrooms: null,
      saleDate: null,
    });
  });
});
