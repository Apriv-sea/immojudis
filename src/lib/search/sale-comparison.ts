import { propertyTypeLabel } from "@/lib/format";
import type { AuctionSale, SaleVenueType } from "@/lib/types";

export const MAX_COMPARED_SALES = 3;
export const MAX_SAVED_COMPARED_SALES = 12;
const MAX_SNAPSHOT_CANDIDATES = 30;

// Only catalogue facts belong in this temporary comparison, even when the
// selected record comes from an account with access to the full analysis.
export type ComparedSale = {
  id: string;
  city: string | null;
  department: string | null;
  propertyType: string | null;
  venueType: SaleVenueType;
  saleDate: string | null;
  startingPriceEur: number | null;
  surfaceM2: number | null;
  surfaceKind: string | null;
  rooms: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
};

export type SaleComparisonSnapshot = {
  version: 1;
  capturedAt: string;
  items: ComparedSale[];
};

export function toComparedSale(sale: AuctionSale): ComparedSale {
  const surface = nonNegativeNumber(sale.app_surface_m2);
  return {
    id: sale.id,
    city: textOrNull(sale.city),
    department: textOrNull(sale.department),
    propertyType: textOrNull(sale.property_type),
    venueType: ["tribunal", "notary", "state", "online"].includes(sale.sale_venue_type ?? "")
      ? sale.sale_venue_type!
      : "unknown",
    saleDate: sale.sale_date && Number.isFinite(Date.parse(sale.sale_date)) ? sale.sale_date : null,
    startingPriceEur: nonNegativeNumber(sale.starting_price_eur),
    // Do not infer a studio's area or substitute private surface fields.
    surfaceM2: surface != null && surface > 0 ? surface : null,
    surfaceKind: textOrNull(sale.app_surface_kind),
    rooms: countOrNull(sale.rooms_count),
    bedrooms: countOrNull(sale.bedrooms_count),
    bathrooms: countOrNull(sale.bathrooms_count),
  };
}

export function comparedSaleTitle(sale: ComparedSale): string {
  return `${propertyTypeLabel(sale.propertyType)}${sale.city ? ` à ${sale.city}` : ""}`;
}

export function toggleComparedSale(items: ComparedSale[], sale: AuctionSale): ComparedSale[] {
  if (items.some((item) => item.id === sale.id)) {
    return items.filter((item) => item.id !== sale.id);
  }
  if (items.length >= MAX_COMPARED_SALES) return items;
  return [...items, toComparedSale(sale)];
}

export function buildSaleComparisonSnapshot(
  items: ComparedSale[],
  capturedAt = new Date().toISOString(),
): SaleComparisonSnapshot {
  return {
    version: 1,
    capturedAt,
    items: items.slice(0, MAX_SAVED_COMPARED_SALES).map((item) => normalizeComparedSale(item)),
  };
}

export function readSaleComparisonSnapshot(value: unknown): ComparedSale[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) return [];

  const items: ComparedSale[] = [];
  const seen = new Set<string>();
  for (const rawItem of value.items.slice(0, MAX_SNAPSHOT_CANDIDATES)) {
    if (items.length >= MAX_SAVED_COMPARED_SALES) break;
    if (!isRecord(rawItem) || !isUuid(rawItem.id) || seen.has(rawItem.id)) continue;
    seen.add(rawItem.id);
    items.push(normalizeComparedSale(rawItem));
  }
  return items;
}

export function comparisonSurfaceKind(sale: ComparedSale): string {
  if (sale.surfaceM2 == null) return "Non renseignée";
  const labels: Record<string, string> = {
    habitable: "Habitable",
    carrez: "Carrez",
    land: "Terrain",
    built: "Bâtie",
    useful: "Utile",
  };
  const kind = sale.surfaceKind ?? "";
  return Object.hasOwn(labels, kind) ? labels[kind] : "À préciser";
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function countOrNull(value: unknown): number | null {
  const number = nonNegativeNumber(value);
  return number != null && Number.isInteger(number) ? number : null;
}

function textOrNull(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function normalizeComparedSale(value: Record<string, unknown> | ComparedSale): ComparedSale {
  const raw = value as Record<string, unknown>;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    city: boundedText(raw.city, 120),
    department: boundedText(raw.department, 80),
    propertyType: boundedText(raw.propertyType, 80),
    venueType: isSaleVenueType(raw.venueType) ? raw.venueType : "unknown",
    saleDate:
      typeof raw.saleDate === "string" && Number.isFinite(Date.parse(raw.saleDate))
        ? raw.saleDate
        : null,
    startingPriceEur: boundedNumber(raw.startingPriceEur, 1_000_000_000),
    surfaceM2: boundedNumber(raw.surfaceM2, 10_000_000, false),
    surfaceKind: boundedText(raw.surfaceKind, 40),
    rooms: boundedCount(raw.rooms),
    bedrooms: boundedCount(raw.bedrooms),
    bathrooms: boundedCount(raw.bathrooms),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isSaleVenueType(value: unknown): value is SaleVenueType {
  return ["tribunal", "notary", "state", "online", "unknown"].includes(String(value));
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || null;
}

function boundedNumber(value: unknown, maximum: number, allowZero = true): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < (allowZero ? 0 : Number.EPSILON) || value > maximum) return null;
  return value;
}

function boundedCount(value: unknown): number | null {
  const normalized = boundedNumber(value, 1_000);
  return normalized != null && Number.isInteger(normalized) ? normalized : null;
}
