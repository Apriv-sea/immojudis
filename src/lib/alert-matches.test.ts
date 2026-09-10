import { describe, expect, it } from "vitest";
import { buildAlertMatchSnapshot, buildAlertMatchSummary } from "@/lib/alert-matches";
import { isDiscoveryAlertCompatible } from "@/lib/discovery-alerts";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { UserAlert } from "@/lib/types";

function makeAlert(overrides: Partial<UserAlert> = {}): UserAlert {
  return {
    id: "alert-1",
    user_id: "user-1",
    name: "Bordeaux décoté",
    department: "33",
    city: "Bordeaux",
    property_type: "house",
    max_price_eur: 150_000,
    min_surface_m2: 70,
    occupancy_status: null,
    min_investment_score: 70,
    max_price_per_m2: 1_800,
    min_yield_pct: 8,
    min_market_discount_pct: 20,
    dpe_classes: ["B", "C"],
    require_house_with_land: true,
    alert_frequency: "daily",
    last_evaluated_at: null,
    last_match_count: 0,
    advanced_criteria: {},
    is_active: true,
    watched_zone_id: null,
    created_at: "2026-07-06T10:00:00.000Z",
    updated_at: "2026-07-06T10:00:00.000Z",
    ...overrides,
  };
}

describe("alert match snapshots", () => {
  it("rejects premium criteria after downgrade", () => {
    expect(isDiscoveryAlertCompatible(makeAlert())).toBe(false);
    const publicAlert = makeAlert({
      min_investment_score: null,
      min_yield_pct: null,
      min_market_discount_pct: null,
      dpe_classes: [],
      require_house_with_land: false,
    });
    expect(isDiscoveryAlertCompatible(publicAlert)).toBe(true);
    expect(isDiscoveryAlertCompatible({ ...publicAlert, alert_frequency: "instant" })).toBe(false);
    expect(
      isDiscoveryAlertCompatible({ ...publicAlert, advanced_criteria: { query: "secret" } }),
    ).toBe(false);
  });
  it("projects a free snapshot without premium or source fields", () => {
    const alert = makeAlert();
    const summary = buildAlertMatchSummary({
      alert,
      sale: EXAMPLE_SALE,
      reasons: [],
      marketDiscountPct: 45,
      matchedAt: "2026-09-09",
    });
    const snapshot = buildAlertMatchSnapshot({
      alert,
      sale: EXAMPLE_SALE,
      summary,
      discovery: true,
    });
    expect(snapshot).toEqual({
      audience: "discovery",
      alert: { id: alert.id, name: alert.name },
      sale: {
        id: EXAMPLE_SALE.id,
        title: "Vente immobilière",
        city: EXAMPLE_SALE.city,
        department: EXAMPLE_SALE.department,
        startingPriceEur: EXAMPLE_SALE.starting_price_eur,
        saleDate: EXAMPLE_SALE.sale_date,
      },
      match: {
        reasons: ["Critères publics correspondants"],
        marketDiscountPct: null,
        matchedAt: "2026-09-09",
      },
    });
  });

  it("builds a stable smart-alert match summary and snapshot", () => {
    const sale = {
      ...EXAMPLE_SALE,
      id: "sale-1",
      title: "Maison judiciaire",
      city: "Bordeaux",
      department: "33",
      property_type: "house",
      starting_price_eur: 120_000,
      app_surface_m2: 80,
      source_blocks: { dpe_classe: "C" },
      status: "active",
      updated_at: "2026-07-06T09:00:00.000Z",
      source_url: "https://example.test/vente",
      documents_rich: [
        {
          url: "https://example.test/cahier.pdf",
          label: "Cahier",
          type: "conditions",
          extraction_status: "completed",
        },
      ],
    };
    const alert = makeAlert();
    const summary = buildAlertMatchSummary({
      alert,
      sale,
      reasons: ["prix au m²", "rendement", "décote"],
      marketDiscountPct: 25.04,
      matchedAt: "2026-07-06T11:00:00.000Z",
    });
    const snapshot = buildAlertMatchSnapshot({ alert, sale, summary });

    expect(summary).toMatchObject({
      alertId: "alert-1",
      saleId: "sale-1",
      saleTitle: "Maison judiciaire",
      marketDiscountPct: 25,
      reasons: ["prix au m²", "rendement", "décote"],
    });
    expect(snapshot).toMatchObject({
      alert: {
        name: "Bordeaux décoté",
        criteria: {
          minMarketDiscountPct: 20,
          dpeClasses: ["B", "C"],
          requireHouseWithLand: true,
          watchedZoneId: null,
        },
      },
      sale: {
        id: "sale-1",
        pricePerM2: 1_500,
        dpe: "C",
        status: "active",
        documentCount: 1,
        updatedAt: "2026-07-06T09:00:00.000Z",
        sourceUrl: "https://example.test/vente",
      },
      match: {
        marketDiscountPct: 25,
      },
    });
  });
});
