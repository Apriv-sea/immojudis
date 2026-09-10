import { describe, expect, it } from "vitest";
import {
  listingContactLinks,
  listingAddress,
  listingCoordinates,
  listingDate,
  listingSurface,
  listingVisits,
  parseBudgetAmount,
} from "./sale-listing";
import type { AuctionSale } from "./types";

const sale = (values: Partial<AuctionSale>) => values as AuctionSale;

describe("listing facts", () => {
  it("does not append a commune and postal code already present in the address", () => {
    expect(
      listingAddress(
        sale({
          address: "16 avenue des Elysées, 34350, VALRAS-PLAGE",
          postal_code: "34350",
          city: "Valras-Plage",
        }),
      ),
    ).toBe("16 avenue des Elysées, 34350, VALRAS-PLAGE");
    expect(
      listingAddress(
        sale({ address: "16 avenue des Elysées", postal_code: "34350", city: "Valras-Plage" }),
      ),
    ).toBe("16 avenue des Elysées, 34350 Valras-Plage");
  });
  it("preserves measured decimals and distinguishes the starting unit price", () => {
    const result = listingSurface(
      sale({ app_surface_m2: 42.6, app_surface_kind: "Carrez", starting_price_eur: 92_000 }),
    );
    expect(result.formatted).toBe("42,6 m²");
    expect(result.label).toBe("Surface Carrez");
    expect(result.pricePerM2).toBeCloseTo(2159.62, 2);
  });
  it("does not compute a unit price from an estimated studio surface", () => {
    const result = listingSurface(sale({ property_type: "studio", starting_price_eur: 92_000 }));
    expect(result.label).toBe("Surface estimée");
    expect(result.pricePerM2).toBeNull();
    expect(result.helperText).toContain("provisoire");
  });
  it("does not treat a plot as measured living area", () => {
    const result = listingSurface(
      sale({ property_type: "land", land_surface_m2: 1200, starting_price_eur: 92_000 }),
    );
    expect(result.label).toBe("Surface du terrain");
    expect(result.pricePerM2).toBeNull();
  });
  it("recognizes a land area stored in the normalized app surface", () => {
    const result = listingSurface(
      sale({ app_surface_kind: "land", app_surface_m2: 1200, starting_price_eur: 92_000 }),
    );
    expect(result.label).toBe("Surface du terrain");
    expect(result.value).toBe(1200);
    expect(result.pricePerM2).toBeNull();
  });
  it.each([null, 0, -20, Infinity, NaN])("does not invent a price per m² for %s", (price) => {
    expect(
      listingSurface(sale({ app_surface_m2: 42.6, starting_price_eur: price })).pricePerM2,
    ).toBeNull();
  });
  it("makes missing surfaces explicit", () => {
    expect(listingSurface(sale({})).formatted).toBe("À confirmer");
  });
  it.each([
    [null, 2],
    [91, 2],
    [40, 181],
    [NaN, 2],
    [40, Infinity],
  ])("rejects unusable coordinates %s %s", (latitude, longitude) => {
    expect(listingCoordinates(sale({ latitude, longitude }))).toBeNull();
  });
  it("accepts valid zero coordinates", () => {
    expect(listingCoordinates(sale({ latitude: 0, longitude: 0 }))).toEqual({ lat: 0, lng: 0 });
  });
});

describe("listing dates", () => {
  it("does not invent midnight for a date-only publication", () => {
    expect(listingDate("2026-10-15")).toBe("15 octobre 2026");
  });
  it("displays a zoned auction time in Paris", () => {
    expect(listingDate("2026-10-15T07:30:00Z")).toContain("09:30");
  });
  it.each(["2026-10-02 à 14:00", "2026-10-02T14:00:00"])("keeps the local time of %s", (date) => {
    expect(listingDate(date)).toBe("2 octobre 2026 · 14:00");
  });
  it("keeps published free text and ranges", () => {
    expect(listingDate("Sur rendez-vous uniquement")).toBe("Sur rendez-vous uniquement");
    expect(listingDate("2026-10-02 à 14:00–15:00")).toBe("2 octobre 2026 · 14:00–15:00");
    expect(listingDate("2026-02-31")).toBe("2026-02-31");
    expect(listingDate(null)).toBe("À confirmer");
  });
  it("deduplicates slots and avoids repeating the raw source block", () => {
    expect(
      listingVisits(
        sale({
          visit_dates: [null, "2026-10-02 à 14:00", "2026-10-02 à 14:00"],
          source_blocks: { visites: "Le 2 octobre à 14 heures" },
        }),
      ),
    ).toEqual(["2 octobre 2026 · 14:00"]);
  });
  it("uses published visit text when structured slots are absent", () => {
    expect(listingVisits(sale({ source_blocks: { visites: "Sur rendez-vous" } }))).toEqual([
      "Sur rendez-vous",
    ]);
    expect(listingVisits(sale({ visit_dates: [{ hidden: "not a slot" }] }))).toEqual([]);
  });
});

describe("listing contacts", () => {
  it.each(["Fax :", "FAX.", "Télécopie :", "Télécopieur"])(
    "does not present a %s number as a telephone action",
    (label) => {
      expect(listingContactLinks(`Tél.: 04 72 56 73 33 - ${label} 04 72 56 73 37`)).toEqual([
        { kind: "phone", label: "04 72 56 73 33", href: "tel:0472567333" },
      ]);
    },
  );

  it("separates phone, office hours, email and website safely", () => {
    expect(
      listingContactLinks(
        "01 43 26 82 98 · de 10h à 12h, contact@example.fr — https://example.fr/etude.",
      ),
    ).toEqual([
      { kind: "website", label: "example.fr", href: "https://example.fr/etude" },
      { kind: "email", label: "contact@example.fr", href: "mailto:contact@example.fr" },
      { kind: "phone", label: "01 43 26 82 98", href: "tel:0143268298" },
    ]);
  });
  it("normalizes international French numbers without an extra trunk zero", () => {
    expect(listingContactLinks("+33 (0)1 43 26 82 98")[0]?.href).toBe("tel:+33143268298");
  });
  it("never makes unsafe URL schemes actionable", () => {
    expect(listingContactLinks("javascript:alert(1)")).toEqual([]);
    expect(listingContactLinks("https://name:password@example.fr")).toEqual([]);
    expect(listingContactLinks("79 bd Montparnasse, 75006 Paris, 10h à 12h")).toEqual([]);
  });
});

describe("manual budget inputs", () => {
  it.each([
    ["92 000", 92000],
    ["1 250,50", 1250.5],
    ["0", 0],
    ["1000.20", 1000.2],
  ])("parses %s", (value, expected) => {
    expect(parseBudgetAmount(String(value))).toBe(expected);
  });
  it.each(["", " ", "-1", "1e6", "Infinity", "1,2,3", "abc", "1000000001"])(
    "keeps %s unknown instead of silently turning it into zero",
    (value) => {
      expect(parseBudgetAmount(value)).toBeNull();
    },
  );
});
