import type { AuctionSale, SaleFilters, SortKey } from "@/lib/types";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { saleVenueMatchesType } from "@/lib/sale-types";
import { isHouseWithLand } from "@/lib/alerts";
import { dpeMatches, extractDpe } from "@/lib/dpe";
import { getSaleSurface } from "@/lib/surface";
import { estimateGrossYieldPct, haversineKm, pricePerM2, type GeoPoint } from "@/lib/geo";
import {
  matchesFrenchGeoSearch,
  matchesFrenchSearchText,
  resolveFrenchGeoSearch,
} from "./french-geo-search";
import type { SalesSearchParams, SearchSortKey, ViewportBounds } from "./search-url-state";

export const DEFAULT_SEARCH_LIMIT = 24;
export const MAX_MAP_RESULTS = 300;

export const TRANSACTION_OPTIONS = [
  { label: "Ventes aux enchères", value: "for_sale" },
  { label: "Locations", value: "for_rent" },
  { label: "Ventes passées", value: "sold" },
] as const;

export const HOME_TYPE_OPTIONS = [
  { label: "Maison", value: "house" },
  { label: "Appartement", value: "apartment" },
  { label: "Immeuble", value: "building" },
  { label: "Terrain", value: "land" },
  { label: "Local commercial", value: "commercial" },
  { label: "Garage", value: "garage" },
] as const;

export const STATUS_OPTIONS = [
  { label: "Active", value: "active" },
  { label: "À venir", value: "upcoming" },
  { label: "Adjugée", value: "adjudicated" },
  { label: "Passée", value: "past" },
  { label: "Retirée", value: "withdrawn" },
] as const;

export const SORT_OPTIONS: Array<{ label: string; value: SearchSortKey }> = [
  { label: "Pertinence", value: "relevance" },
  { label: "Prix décroissant", value: "price_desc" },
  { label: "Prix croissant", value: "price_asc" },
  { label: "Date de publication", value: "newest" },
  { label: "Surface", value: "sqft_desc" },
  { label: "Nombre de chambres", value: "beds_desc" },
  { label: "Distance", value: "distance" },
];

export function dataSortFromSearch(sort: SearchSortKey | undefined): SortKey {
  switch (sort) {
    case "price_desc":
      return "price_desc";
    case "price_asc":
      return "price_asc";
    case "newest":
      return "date_desc";
    case "sqft_desc":
      return "surface_desc";
    case "beds_desc":
    case "distance":
    case "relevance":
    default:
      return "score_desc";
  }
}

export function dataFiltersFromSearch(search: SalesSearchParams): SaleFilters {
  const queryScope = resolveFrenchGeoSearch(search.query);
  const departmentScope = resolveFrenchGeoSearch(search.department);
  const explicitDepartments =
    departmentScope.kind === "department" || departmentScope.kind === "region"
      ? departmentScope.departments
      : undefined;
  const queryDepartments =
    queryScope.kind === "department" || queryScope.kind === "region"
      ? queryScope.departments
      : undefined;
  const departments = intersectDepartmentScopes(explicitDepartments, queryDepartments);
  const keywords =
    [queryScope.kind === "text" ? queryScope.text : undefined, search.keywords]
      .filter(Boolean)
      .join(" ") || undefined;

  return {
    department:
      departmentScope.kind === "text" && search.department ? search.department : undefined,
    departments,
    city: search.city,
    postal_code: queryScope.kind === "postal_code" ? queryScope.postalCode : undefined,
    tribunal: search.tribunal,
    sale_venue_type: search.saleType,
    viewport: search.viewport,
    property_type: search.homeTypes?.length === 1 ? search.homeTypes[0] : undefined,
    property_types: search.homeTypes && search.homeTypes.length > 1 ? search.homeTypes : undefined,
    min_price: search.minPrice,
    max_price: search.maxPrice,
    min_surface: search.minSqft,
    max_surface: search.maxSqft,
    min_bedrooms: search.minBeds,
    min_bathrooms: search.minBaths,
    occupancy_status: search.occupancy,
    min_score: search.minScore,
    status_in: statusValuesForSearch(search),
    keywords,
  };
}

function statusValuesForSearch(search: SalesSearchParams): string[] | undefined {
  if (search.status?.length) return search.status;
  if (search.transactionType === "sold") return ["sold", "adjudicated", "past"];
  if (search.transactionType === "for_sale") return ["active", "upcoming"];
  return undefined;
}

export function countActiveSearchFilters(search: SalesSearchParams): number {
  return [
    search.city,
    search.department,
    search.tribunal,
    search.saleType,
    search.query,
    search.minPrice,
    search.maxPrice,
    search.minBeds,
    search.minBaths,
    search.minSqft,
    search.maxSqft,
    search.homeTypes?.length,
    search.status?.length,
    search.keywords,
    search.transactionType && search.transactionType !== "for_sale",
    search.occupancy,
    search.dpeClasses?.length,
    search.minScore,
    search.maxPricePerM2,
    search.minYield,
    search.minMarketDiscount,
    search.houseWithLand,
    search.aroundAddress,
    search.yearBuilt,
    search.openHouse,
  ].filter(Boolean).length;
}

export function hasClientOnlyFilters(search: SalesSearchParams): boolean {
  return Boolean(
    search.maxPricePerM2 ||
    search.minYield ||
    search.houseWithLand ||
    search.aroundAddress ||
    search.aroundRadius ||
    search.dpeClasses?.length ||
    search.openHouse ||
    search.yearBuilt ||
    search.transactionType === "for_rent" ||
    search.sort === "beds_desc" ||
    search.sort === "distance",
  );
}

export function applyClientSearchFilters(
  sales: AuctionSale[],
  search: SalesSearchParams,
  center: GeoPoint | null,
): AuctionSale[] {
  return sales.filter((sale) => {
    if (
      search.saleType &&
      !saleVenueMatchesType(getSaleProcedure(sale).venueType, search.saleType)
    ) {
      return false;
    }
    if (search.transactionType === "for_rent") return false;
    if (search.transactionType === "sold" && !isSoldLike(sale)) return false;

    const surface = getSaleSurface(sale).value;

    if (search.minPrice != null && (sale.starting_price_eur ?? 0) < search.minPrice) return false;
    if (search.maxPrice != null && (sale.starting_price_eur ?? Infinity) > search.maxPrice) {
      return false;
    }
    if (search.minSqft != null && (surface == null || surface < search.minSqft)) return false;
    if (search.maxSqft != null && (surface == null || surface > search.maxSqft)) return false;
    if (search.minBeds != null && (sale.bedrooms_count ?? sale.rooms_count ?? 0) < search.minBeds) {
      return false;
    }
    if (search.minBaths != null && (sale.bathrooms_count ?? 0) < search.minBaths) return false;

    if (search.homeTypes?.length && !matchesAnyHomeType(sale.property_type, search.homeTypes)) {
      return false;
    }
    if (search.status?.length && !matchesStatus(sale.status, search.status)) return false;
    if (!dpeMatches(extractDpe(sale).class, search.dpeClasses)) return false;
    if (search.query && !matchesFrenchGeoSearch(sale, search.query)) return false;
    if (search.keywords && !matchesFrenchSearchText(sale, search.keywords)) return false;
    if (search.maxPricePerM2 != null) {
      const ppm = pricePerM2(sale.starting_price_eur, surface);
      if (ppm == null || ppm > search.maxPricePerM2) return false;
    }
    if (search.minYield != null) {
      const yieldPct = estimateGrossYieldPct(sale.starting_price_eur, surface, sale.department);
      if (yieldPct == null || yieldPct < search.minYield) return false;
    }
    if (search.houseWithLand && !isHouseWithLand(sale)) return false;
    if (search.aroundRadius != null && center) {
      if (sale.latitude == null || sale.longitude == null) return false;
      const distance = haversineKm(center, { lat: sale.latitude, lng: sale.longitude });
      if (distance > search.aroundRadius) return false;
    }
    if (search.viewport && !saleIsInViewport(sale, search.viewport)) return false;
    if (search.openHouse && !sale.sale_date) return false;

    return true;
  });
}

export function sortClientSearchResults(
  sales: AuctionSale[],
  search: SalesSearchParams,
  center: GeoPoint | null,
): AuctionSale[] {
  const next = [...sales];

  if (search.sort === "beds_desc") {
    next.sort(
      (a, b) => (b.bedrooms_count ?? b.rooms_count ?? 0) - (a.bedrooms_count ?? a.rooms_count ?? 0),
    );
  }

  if (search.sort === "distance" && center) {
    next.sort((a, b) => distanceForSort(a, center) - distanceForSort(b, center));
  }

  return next;
}

export function compactPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Prix";
  if (Math.abs(value) >= 1_000_000) {
    return `${new Intl.NumberFormat("fr-FR", {
      maximumFractionDigits: Math.abs(value) >= 10_000_000 ? 0 : 1,
    }).format(value / 1_000_000)} M€`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${Math.round(value / 1_000).toLocaleString("fr-FR")} k€`;
  }
  return `${value.toLocaleString("fr-FR")} €`;
}

export function hasCoordinates(
  sale: AuctionSale,
): sale is AuctionSale & { latitude: number; longitude: number } {
  return sale.latitude != null && sale.longitude != null;
}

export function saleIsInViewport(sale: AuctionSale, viewport: ViewportBounds): boolean {
  if (!hasCoordinates(sale)) return false;
  return (
    sale.latitude <= viewport.north &&
    sale.latitude >= viewport.south &&
    sale.longitude <= viewport.east &&
    sale.longitude >= viewport.west
  );
}

function distanceForSort(sale: AuctionSale, center: GeoPoint) {
  if (sale.latitude == null || sale.longitude == null) return Number.POSITIVE_INFINITY;
  return haversineKm(center, { lat: sale.latitude, lng: sale.longitude });
}

function matchesAnyHomeType(value: string | null | undefined, accepted: string[]) {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return accepted.some((candidate) => normalized.includes(candidate.toLowerCase()));
}

function matchesStatus(value: string | null | undefined, accepted: string[]) {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return accepted.some((candidate) => normalized === candidate.toLowerCase());
}

function isSoldLike(sale: AuctionSale) {
  const status = sale.status?.toLowerCase();
  if (status && ["sold", "adjudicated", "past"].includes(status)) return true;
  if (!sale.sale_date) return false;
  return new Date(sale.sale_date).getTime() < Date.now();
}

function intersectDepartmentScopes(
  explicitDepartments: string[] | undefined,
  queryDepartments: string[] | undefined,
): string[] | undefined {
  if (!explicitDepartments?.length) return queryDepartments;
  if (!queryDepartments?.length) return explicitDepartments;
  const queryCodes = new Set(queryDepartments);
  const intersection = explicitDepartments.filter((code) => queryCodes.has(code));
  return intersection.length ? intersection : ["__no_department__"];
}
