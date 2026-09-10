import { describe, expect, it } from "vitest";
import { alertMatchesSale, isHouseWithLand } from "@/lib/alerts";
import type { AuctionSale, UserWatchedZone } from "@/lib/types";

type AlertCriteria = Parameters<typeof alertMatchesSale>[0];

function makeSale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "sale-1",
    title: "Maison avec jardin",
    description: null,
    source_description: null,
    llm_display_description: null,
    about_description: null,
    city: "Bordeaux",
    department: "33",
    postal_code: null,
    address: null,
    tribunal: null,
    tribunal_code: null,
    tribunal_name: null,
    tribunal_city: null,
    property_type: "house",
    starting_price_eur: 100_000,
    sale_date: null,
    visit_dates: null,
    lawyer_name: null,
    lawyer_contact: null,
    adjudication_price_eur: null,
    latitude: null,
    longitude: null,
    occupancy_status: "free",
    habitable_surface_m2: 100,
    carrez_surface_m2: null,
    land_surface_m2: 220,
    app_surface_m2: 100,
    app_surface_kind: null,
    surface_scope: null,
    surface_source: null,
    surface_confidence: null,
    surface_evidence: null,
    rooms_count: 4,
    bedrooms_count: 3,
    bathrooms_count: 1,
    parking_count: null,
    has_garden: true,
    has_terrace: null,
    has_garage: null,
    has_pool: null,
    has_air_conditioning: null,
    has_double_glazing: null,
    investment_score: 82,
    investment_summary: null,
    score_version: null,
    score_confidence: null,
    score_factors: null,
    risk_notes: null,
    source_name: null,
    source_url: null,
    primary_source: null,
    source_urls: null,
    source_blocks: { dpe_classe: "B" },
    source_blocks_by_source: null,
    dedupe_confidence: null,
    quality_flags: null,
    documents: null,
    documents_rich: [],
    media: null,
    risks: null,
    status: "active",
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function makeAlert(overrides: Partial<AlertCriteria> = {}): AlertCriteria {
  return {
    city: "Bordeaux",
    department: "33",
    property_type: "house",
    max_price_eur: 150_000,
    min_surface_m2: 80,
    occupancy_status: "free",
    min_investment_score: 70,
    max_price_per_m2: 1_500,
    min_yield_pct: 10,
    min_market_discount_pct: 20,
    dpe_classes: ["B"],
    require_house_with_land: true,
    ...overrides,
  };
}

function makeWatchedZone(overrides: Partial<UserWatchedZone> = {}): UserWatchedZone {
  return {
    id: "zone-1",
    user_id: "user-1",
    name: "Bordeaux centre",
    zone_kind: "radius",
    department: "33",
    city: null,
    postal_code_prefix: null,
    center_lat: 44.8378,
    center_lng: -0.5792,
    radius_km: 8,
    alert_defaults: {},
    is_active: true,
    created_at: "2026-07-06T10:00:00.000Z",
    updated_at: "2026-07-06T10:00:00.000Z",
    ...overrides,
  };
}

describe("smart alert matching", () => {
  it("respects the saved sale family, including judicial-origin notarial sales", () => {
    const alert = makeAlert({ advanced_criteria: { sale_type: "notary" } });
    expect(
      alertMatchesSale(alert, makeSale({ sale_venue_type: "tribunal" }), { marketDiscountPct: 30 })
        .matches,
    ).toBe(false);
    expect(
      alertMatchesSale(
        alert,
        makeSale({ sale_venue_type: "notary", sale_legal_framework: "judicial_partition" }),
        { marketDiscountPct: 30 },
      ).matches,
    ).toBe(true);
  });

  it("matches a sale when all advanced criteria are satisfied", () => {
    const result = alertMatchesSale(makeAlert(), makeSale(), { marketDiscountPct: 28 });

    expect(result.matches).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["prix au m²", "rendement", "DPE B", "terrain", "décote"]),
    );
  });

  it("rejects a sale when a house with land is required but absent", () => {
    const result = alertMatchesSale(
      makeAlert(),
      makeSale({
        title: "Maison de ville",
        property_type: "house",
        land_surface_m2: null,
        has_garden: false,
      }),
      { marketDiscountPct: 28 },
    );

    expect(isHouseWithLand(makeSale())).toBe(true);
    expect(result).toEqual({
      matches: false,
      reasons: ["maison avec terrain absente"],
    });
  });

  it("requires an explicit market discount context for discount alerts", () => {
    const result = alertMatchesSale(
      makeAlert({
        min_market_discount_pct: 25,
        require_house_with_land: false,
      }),
      makeSale(),
    );

    expect(result).toEqual({
      matches: false,
      reasons: ["décote marché insuffisante"],
    });
  });

  it("adds the watched zone to successful alert reasons", () => {
    const result = alertMatchesSale(
      makeAlert({ min_market_discount_pct: null }),
      makeSale({
        latitude: 44.84,
        longitude: -0.58,
      }),
      { watchedZone: makeWatchedZone() },
    );

    expect(result.matches).toBe(true);
    expect(result.reasons).toContain("rayon Bordeaux centre");
  });

  it("rejects a sale outside the watched zone", () => {
    const result = alertMatchesSale(
      makeAlert({ min_market_discount_pct: null }),
      makeSale({
        latitude: 45.764,
        longitude: 4.8357,
      }),
      { watchedZone: makeWatchedZone() },
    );

    expect(result).toEqual({
      matches: false,
      reasons: ["hors zone surveillée"],
    });
  });
});
