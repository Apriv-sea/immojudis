import { describe, expect, it, vi } from "vitest";
import { deleteWatchedZone, watchedZoneInputSchema } from "@/lib/watched-zones";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { watchedZoneMatchesSale } from "@/lib/watched-zones-shared";
import type { AuctionSale, UserWatchedZone } from "@/lib/types";

function makeZone(overrides: Partial<UserWatchedZone> = {}): UserWatchedZone {
  return {
    id: "zone-1",
    user_id: "user-1",
    name: "Gironde",
    zone_kind: "department",
    department: "33",
    city: null,
    postal_code_prefix: null,
    center_lat: null,
    center_lng: null,
    radius_km: null,
    alert_defaults: {},
    is_active: true,
    created_at: "2026-07-06T10:00:00.000Z",
    updated_at: "2026-07-06T10:00:00.000Z",
    ...overrides,
  };
}

function makeSale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "sale-1",
    title: "Maison judiciaire",
    description: null,
    source_description: null,
    llm_display_description: null,
    about_description: null,
    city: "Bordeaux",
    department: "33",
    postal_code: "33000",
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
    latitude: 44.8378,
    longitude: -0.5792,
    occupancy_status: null,
    habitable_surface_m2: null,
    carrez_surface_m2: null,
    land_surface_m2: null,
    app_surface_m2: null,
    app_surface_kind: null,
    surface_scope: null,
    surface_source: null,
    surface_confidence: null,
    surface_evidence: null,
    rooms_count: null,
    bedrooms_count: null,
    bathrooms_count: null,
    parking_count: null,
    has_garden: null,
    has_terrace: null,
    has_garage: null,
    has_pool: null,
    has_air_conditioning: null,
    has_double_glazing: null,
    investment_score: null,
    investment_summary: null,
    score_version: null,
    score_confidence: null,
    score_factors: null,
    risk_notes: null,
    source_name: null,
    source_url: null,
    primary_source: null,
    source_urls: null,
    source_blocks: null,
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

describe("watched zones", () => {
  it.each([false, true])(
    "disables linked alerts before deletion (update failure: %s)",
    async (fails) => {
      const events: string[] = [];
      const alertError = fails ? new Error("update refused") : null;
      const alertQuery = {
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (value: { error: Error | null }) => unknown) => {
          events.push("alerts");
          return Promise.resolve(resolve({ error: alertError }));
        },
      };
      const update = vi.fn(() => alertQuery);
      const deletion = {
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (value: { error: null }) => unknown) => {
          events.push("delete");
          return Promise.resolve(resolve({ error: null }));
        },
      };
      const remove = vi.fn(() => deletion);
      const zoneQuery = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: makeZone(), error: null }),
        delete: remove,
      };
      const auth = {
        userId: "user-1",
        supabase: { from: (table: string) => (table === "user_alerts" ? { update } : zoneQuery) },
      } as unknown as SupabaseAuthContext;

      const result = deleteWatchedZone({ auth, zoneId: "zone-1" });
      if (fails) {
        await expect(result).rejects.toThrow("update refused");
        expect(remove).not.toHaveBeenCalled();
        expect(events).toEqual(["alerts"]);
      } else {
        await expect(result).resolves.toEqual({ ok: true });
        expect(events).toEqual(["alerts", "delete"]);
        expect(deletion.eq.mock.calls).toEqual([
          ["id", "zone-1"],
          ["user_id", "user-1"],
        ]);
      }
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ watched_zone_id: null, is_active: false }),
      );
      expect(alertQuery.eq.mock.calls).toEqual([
        ["user_id", "user-1"],
        ["watched_zone_id", "zone-1"],
      ]);
    },
  );

  it("validates required fields for each zone kind", () => {
    expect(() =>
      watchedZoneInputSchema.parse({
        name: "Rayon incomplet",
        zoneKind: "radius",
        radiusKm: 10,
      }),
    ).toThrow();

    expect(
      watchedZoneInputSchema.parse({
        name: "Bordeaux centre",
        zoneKind: "radius",
        centerLat: 44.8378,
        centerLng: -0.5792,
        radiusKm: 8,
      }),
    ).toMatchObject({
      zoneKind: "radius",
      radiusKm: 8,
    });
  });

  it("matches sales by department, city, postal prefix and radius", () => {
    expect(watchedZoneMatchesSale(makeZone(), makeSale())).toBe(true);
    expect(
      watchedZoneMatchesSale(
        makeZone({ zone_kind: "city", name: "Bordeaux", city: "Bordeaux" }),
        makeSale(),
      ),
    ).toBe(true);
    expect(
      watchedZoneMatchesSale(
        makeZone({ zone_kind: "postal_code", postal_code_prefix: "33" }),
        makeSale(),
      ),
    ).toBe(true);
    expect(
      watchedZoneMatchesSale(
        makeZone({
          zone_kind: "radius",
          center_lat: 44.8378,
          center_lng: -0.5792,
          radius_km: 5,
        }),
        makeSale(),
      ),
    ).toBe(true);
    expect(
      watchedZoneMatchesSale(
        makeZone({
          zone_kind: "radius",
          center_lat: 44.8378,
          center_lng: -0.5792,
          radius_km: 5,
        }),
        makeSale({ latitude: 45.764, longitude: 4.8357 }),
      ),
    ).toBe(false);
  });
});
