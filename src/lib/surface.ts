import { formatSurface } from "@/lib/format";

// Surface provisoire retenue pour les très petits logements sans surface publiée :
// les studios et les appartements 1 pièce (T1). À confirmer avant d'enchérir.
export const STUDIO_ESTIMATED_SURFACE_M2 = 20;

type SurfaceSaleLike = {
  title?: string | null;
  property_type?: string | null;
  app_surface_m2?: number | null;
  habitable_surface_m2?: number | null;
  carrez_surface_m2?: number | null;
  land_surface_m2?: number | null;
  app_surface_kind?: string | null;
  surface_scope?: string | null;
  rooms_count?: number | null;
  bedrooms_count?: number | null;
};

export type MarketValuationSurfaces = {
  builtSurfaceM2: number | null;
  landSurfaceM2: number | null;
  builtSurfaceEstimated: boolean;
  builtSurfaceAssumption: string | null;
  builtSurfaceUncertaintyPct: number | null;
  surfaceKind: string | null;
  surfaceScope: string | null;
};

export type SaleSurface = {
  value: number | null;
  estimated: boolean;
  label: string;
  metricLabel: string;
  kind: "recorded" | "estimated" | "land" | "none";
  helperText: string | null;
};

function positiveSurface(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function typeText(sale: SurfaceSaleLike): string {
  return [sale.property_type, sale.title].filter(Boolean).join(" ").toLowerCase();
}

export function isStudioSale(sale: SurfaceSaleLike): boolean {
  return /\b(studio|studette)\b/.test(typeText(sale));
}

// property_type est normalisé en "apartment" ; on tolère aussi les variantes FR/abrégées.
export function isApartmentSale(sale: SurfaceSaleLike): boolean {
  return /\bapartment\b|\bappart|\bapt\b/.test(typeText(sale));
}

// Appartement 1 pièce (T1) : même estimation qu'un studio, mais uniquement si le
// nombre de pièces est renseigné et ne dépasse pas 1.
function isSingleRoomApartment(sale: SurfaceSaleLike): boolean {
  const rooms = sale.rooms_count;
  const hasAtMostOneRoom = rooms != null && Number.isFinite(rooms) && rooms >= 0 && rooms <= 1;
  return hasAtMostOneRoom && isApartmentSale(sale);
}

export function getRecordedSurface(sale: SurfaceSaleLike): number | null {
  return (
    positiveSurface(sale.app_surface_m2) ??
    positiveSurface(sale.habitable_surface_m2) ??
    positiveSurface(sale.carrez_surface_m2)
  );
}

export function getSaleSurface(sale: SurfaceSaleLike): SaleSurface {
  const recorded = getRecordedSurface(sale);
  if (recorded != null) {
    return {
      value: recorded,
      estimated: false,
      label: formatSurface(recorded),
      metricLabel: "Surface",
      kind: "recorded",
      helperText: null,
    };
  }

  const estimate = (kind: string): SaleSurface => ({
    value: STUDIO_ESTIMATED_SURFACE_M2,
    estimated: true,
    label: `${formatSurface(STUDIO_ESTIMATED_SURFACE_M2)} estimés`,
    metricLabel: "Surface estimée",
    kind: "estimated",
    helperText: `Surface provisoire retenue pour ${kind} sans surface publiée. À confirmer dans les pièces avant d'enchérir.`,
  });

  if (isStudioSale(sale)) return estimate("un studio");
  if (isSingleRoomApartment(sale)) return estimate("un appartement 1 pièce");

  return {
    value: null,
    estimated: false,
    label: "—",
    metricLabel: "Surface",
    kind: "none",
    helperText: null,
  };
}

export function getMarketValuationSurfaces(sale: SurfaceSaleLike): MarketValuationSurfaces {
  const landSurfaceM2 = positiveSurface(sale.land_surface_m2);
  const type = typeText(sale);
  const landOnly =
    sale.app_surface_kind === "land" ||
    sale.surface_scope === "land" ||
    /\b(land|terrain|parcelle)\b/.test(type);
  const rawRecordedBuiltSurface = landOnly ? null : getRecordedSurface(sale);
  const recordedBuiltSurface =
    rawRecordedBuiltSurface != null && rawRecordedBuiltSurface >= 9
      ? rawRecordedBuiltSurface
      : null;
  const estimatedBuiltSurface =
    landOnly || recordedBuiltSurface ? null : estimateBuiltSurface(sale);
  return {
    builtSurfaceM2: recordedBuiltSurface ?? estimatedBuiltSurface?.value ?? null,
    landSurfaceM2: landSurfaceM2 ?? (landOnly ? positiveSurface(sale.app_surface_m2) : null),
    builtSurfaceEstimated: estimatedBuiltSurface != null,
    builtSurfaceAssumption: estimatedBuiltSurface?.assumption ?? null,
    builtSurfaceUncertaintyPct: estimatedBuiltSurface?.uncertaintyPct ?? null,
    surfaceKind: landOnly ? "land" : (sale.app_surface_kind ?? null),
    surfaceScope: landOnly ? "land" : (sale.surface_scope ?? null),
  };
}

function estimateBuiltSurface(
  sale: SurfaceSaleLike,
): { value: number; assumption: string; uncertaintyPct: number } | null {
  const type = typeText(sale);
  const apartment = isApartmentSale(sale) || /\b(studio|studette)\b/.test(type);
  const house = /\b(maison|house|villa|pavillon)\b/.test(type);
  const buildingOrActivity = /\b(building|immeuble|commercial|commerce|local|mixed|mixte)\b/.test(
    type,
  );
  // Room counts do not establish the area of commercial, mixed or whole-building lots.
  if (buildingOrActivity || (!apartment && !house)) return null;

  const rooms =
    positiveSurface(sale.rooms_count) ??
    (positiveSurface(sale.bedrooms_count) != null
      ? positiveSurface(sale.bedrooms_count)! + 1
      : null);
  if (rooms == null) {
    if (isStudioSale(sale)) {
      return {
        value: STUDIO_ESTIMATED_SURFACE_M2,
        assumption: "surface provisoire de 20 m² retenue pour un studio sans surface publiée",
        uncertaintyPct: 20,
      };
    }
    const value = apartment ? 50 : 100;
    return {
      value,
      assumption: `surface provisoire de ${value} m² retenue faute de surface et de nombre de pièces publiés`,
      uncertaintyPct: 45,
    };
  }

  const roundedRooms = Math.max(1, Math.round(rooms));
  const value = apartment
    ? [20, 42, 62, 82, 105][Math.min(4, roundedRooms - 1)] + Math.max(0, roundedRooms - 5) * 20
    : [45, 60, 80, 100, 120][Math.min(4, roundedRooms - 1)] + Math.max(0, roundedRooms - 5) * 22;
  return {
    value,
    assumption: `surface provisoire de ${value} m² estimée à partir de ${roundedRooms} pièce${roundedRooms > 1 ? "s" : ""}`,
    uncertaintyPct: apartment ? 25 : 30,
  };
}

export function getDisplaySurface(sale: SurfaceSaleLike): SaleSurface {
  const primary = getSaleSurface(sale);
  if (primary.value != null) return primary;

  const land = positiveSurface(sale.land_surface_m2);
  if (land != null) {
    return {
      value: land,
      estimated: false,
      label: formatSurface(land),
      metricLabel: "Terrain",
      kind: "land",
      helperText:
        "Surface terrain ou cadastrale connue. Elle n'est pas utilisée comme surface habitable pour le prix au m².",
    };
  }

  return primary;
}
