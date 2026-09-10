import { describe, expect, it } from "vitest";
import {
  getDisplaySurface,
  getMarketValuationSurfaces,
  getSaleSurface,
  STUDIO_ESTIMATED_SURFACE_M2,
} from "./surface";

describe("getSaleSurface", () => {
  it("prefers app surface over habitable and carrez surfaces", () => {
    const surface = getSaleSurface({
      app_surface_m2: 42,
      habitable_surface_m2: 45,
      carrez_surface_m2: 40,
    });

    expect(surface.value).toBe(42);
    expect(surface.estimated).toBe(false);
    expect(surface.kind).toBe("recorded");
  });

  it("estimates a missing studio surface conservatively", () => {
    const surface = getSaleSurface({ title: "Studio vendu occupé" });

    expect(surface.value).toBe(STUDIO_ESTIMATED_SURFACE_M2);
    expect(surface.estimated).toBe(true);
    expect(surface.kind).toBe("estimated");
  });
});

describe("getDisplaySurface", () => {
  it("falls back to land surface for display only", () => {
    const surface = getDisplaySurface({ property_type: "terrain", land_surface_m2: 720 });

    expect(surface.value).toBe(720);
    expect(surface.metricLabel).toBe("Terrain");
    expect(surface.kind).toBe("land");
  });
});

describe("getMarketValuationSurfaces", () => {
  it("never exposes a land application surface as built area", () => {
    expect(
      getMarketValuationSurfaces({
        property_type: "land",
        app_surface_m2: 800,
        app_surface_kind: "land",
        surface_scope: "land",
        land_surface_m2: 800,
      }),
    ).toEqual({
      builtSurfaceM2: null,
      landSurfaceM2: 800,
      builtSurfaceEstimated: false,
      builtSurfaceAssumption: null,
      builtSurfaceUncertaintyPct: null,
      surfaceKind: "land",
      surfaceScope: "land",
    });
  });

  it.each(["commercial", "building", "mixed"])(
    "does not invent a built area for a %s lot from rooms or a default",
    (property_type) => {
      for (const rooms_count of [2, null]) {
        expect(getMarketValuationSurfaces({ property_type, rooms_count })).toMatchObject({
          builtSurfaceM2: null,
          builtSurfaceEstimated: false,
          builtSurfaceAssumption: null,
        });
      }
      expect(
        getMarketValuationSurfaces({ property_type, rooms_count: 2, app_surface_m2: 83 }),
      ).toMatchObject({ builtSurfaceM2: 83, builtSurfaceEstimated: false });
    },
  );

  it("estimates a missing apartment surface from the room count", () => {
    expect(
      getMarketValuationSurfaces({
        property_type: "apartment",
        rooms_count: 3,
      }),
    ).toMatchObject({
      builtSurfaceM2: 62,
      builtSurfaceEstimated: true,
    });
  });

  it("estimates a missing house surface from bedrooms when rooms are absent", () => {
    expect(
      getMarketValuationSurfaces({
        property_type: "house",
        bedrooms_count: 3,
      }),
    ).toMatchObject({
      builtSurfaceM2: 100,
      builtSurfaceEstimated: true,
    });
  });

  it("uses a wide, explicit fallback when no surface or room count is published", () => {
    expect(getMarketValuationSurfaces({ property_type: "house" })).toMatchObject({
      builtSurfaceM2: 100,
      builtSurfaceEstimated: true,
      builtSurfaceUncertaintyPct: 45,
    });
  });
});
