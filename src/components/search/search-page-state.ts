import dynamic from "next/dynamic";
import type * as React from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down.js";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import BedDouble from "lucide-react/dist/esm/icons/bed-double.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import LayoutPanelLeft from "lucide-react/dist/esm/icons/layout-panel-left.js";
import ListFilter from "lucide-react/dist/esm/icons/list-filter.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Ruler from "lucide-react/dist/esm/icons/ruler.js";
import SearchIcon from "lucide-react/dist/esm/icons/search.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useViewedSales } from "@/hooks/use-viewed-sales";
import { supabase } from "@/integrations/supabase/client";
import { Link, useLocation, useNavigate } from "@/lib/router-compat";
import {
  createWatchedZone as createWatchedZoneRequest,
  addFavoriteSale as addFavoriteSaleRequest,
  fetchDpeExplorer,
  exportSalesCsv,
  fetchFeatureEntitlements,
  fetchSalesStatistics,
  removeFavoriteSale as removeFavoriteSaleRequest,
} from "@/lib/client-api";
import { createAlert } from "@/lib/queries";
import { DPE_CLASSES, dpeColor, extractDpe, type DpeClass } from "@/lib/dpe";
import type { DpeExplorerResponse } from "@/lib/dpe-explorer";
import {
  formatDate,
  formatPrice,
  formatPricePerM2,
  occupancyLabel,
  propertyTypeLabel,
} from "@/lib/format";
import { geocodeAddress, pricePerM2, type GeoPoint } from "@/lib/geo";
import { mapboxStaticImageUrl } from "@/lib/mapbox";
import { firstPropertyImage, shouldRejectRenderedPropertyImage } from "@/lib/sale-media";
import { cleanSaleTitle, saleDisplayTitle } from "@/lib/sale-title";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { isNew } from "@/lib/dates";
import type { AuctionSale } from "@/lib/types";
import type { WatchedZoneInput } from "@/lib/watched-zones";
import type { SalesStatisticsResponse } from "@/lib/sales-statistics";
import {
  DEFAULT_SEARCH_LIMIT,
  HOME_TYPE_OPTIONS,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  applyClientSearchFilters,
  compactPrice,
  countActiveSearchFilters,
  hasClientOnlyFilters,
  hasCoordinates,
  sortClientSearchResults,
} from "@/lib/search/search-filters";
import {
  areMapViewportsClose,
  shouldMapListFollowViewport,
  visibleSalesForMapViewport,
} from "@/lib/search/map-viewport-results";
import {
  mergeSalesSearch,
  salesSearchToUrlRecord,
  type SalesSearchParams,
  type SalesSearchUrlRecord,
  type SearchSortKey,
} from "@/lib/search/search-url-state";
import {
  fetchSearchCount,
  fetchSearchMapResults,
  fetchSearchResults,
} from "@/lib/search/search-service";
import type { MapViewportChange } from "./MapPanel";
import { SearchPagination } from "./SearchPagination";
import { parseSaleType, saleTypeFilterLabel, type SaleTypeFilter } from "@/lib/sale-types";

export type SearchDraft = {
  saleType: SaleTypeFilter | "";
  city: string;
  department: string;
  tribunal: string;
  query: string;
  minPrice: string;
  maxPrice: string;
  minBeds: string;
  minBaths: string;
  minSqft: string;
  maxSqft: string;
  homeTypes: string[];
  status: string[];
  keywords: string;
  occupancy: string;
  dpeClasses: string[];
  minScore: string;
  maxPricePerM2: string;
  minYield: string;
  minMarketDiscount: string;
  houseWithLand: boolean;
  aroundAddress: string;
  aroundRadius: string;
  yearBuilt: string;
  openHouse: boolean;
};

export type SearchStatistics = {
  medianPrice: number | null;
  medianPricePerM2: number | null;
  averageScore: number | null;
  upcomingSales: number;
  dpeCounts: Record<DpeClass, number>;
  dpeKnownCount: number;
};

export function searchToDraft(search: SalesSearchParams): SearchDraft {
  return {
    saleType: search.saleType ?? "",
    city: search.city ?? "",
    department: search.department ?? "",
    tribunal: search.tribunal ?? "",
    query: search.query ?? "",
    minPrice: stringifyNumber(search.minPrice),
    maxPrice: stringifyNumber(search.maxPrice),
    minBeds: stringifyNumber(search.minBeds),
    minBaths: stringifyNumber(search.minBaths),
    minSqft: stringifyNumber(search.minSqft),
    maxSqft: stringifyNumber(search.maxSqft),
    homeTypes: search.homeTypes ?? [],
    status: search.status ?? [],
    keywords: search.keywords ?? "",
    occupancy: search.occupancy ?? "",
    dpeClasses: search.dpeClasses ?? [],
    minScore: stringifyNumber(search.minScore),
    maxPricePerM2: stringifyNumber(search.maxPricePerM2),
    minYield: stringifyNumber(search.minYield),
    minMarketDiscount: stringifyNumber(search.minMarketDiscount),
    houseWithLand: Boolean(search.houseWithLand),
    aroundAddress: search.aroundAddress ?? "",
    aroundRadius: stringifyNumber(search.aroundRadius),
    yearBuilt: stringifyNumber(search.yearBuilt),
    openHouse: Boolean(search.openHouse),
  };
}

export function emptySearchDraft(): SearchDraft {
  return {
    saleType: "",
    city: "",
    department: "",
    tribunal: "",
    query: "",
    minPrice: "",
    maxPrice: "",
    minBeds: "",
    minBaths: "",
    minSqft: "",
    maxSqft: "",
    homeTypes: [],
    status: [],
    keywords: "",
    occupancy: "",
    dpeClasses: [],
    minScore: "",
    maxPricePerM2: "",
    minYield: "",
    minMarketDiscount: "",
    houseWithLand: false,
    aroundAddress: "",
    aroundRadius: "",
    yearBuilt: "",
    openHouse: false,
  };
}

export function draftToSearch(draft: SearchDraft, current: SalesSearchParams): SalesSearchParams {
  return {
    saleType: parseSaleType(draft.saleType),
    sort: current.sort,
    viewport: current.viewport,
    limit: current.limit,
    map: current.map,
    searchAsMove: current.searchAsMove,
    city: cleanString(draft.city),
    department: cleanString(draft.department),
    tribunal: cleanString(draft.tribunal),
    query: cleanString(draft.query),
    minPrice: draftNumber(draft.minPrice),
    maxPrice: draftNumber(draft.maxPrice),
    minBeds: draftNumber(draft.minBeds),
    minBaths: draftNumber(draft.minBaths),
    minSqft: draftNumber(draft.minSqft),
    maxSqft: draftNumber(draft.maxSqft),
    homeTypes: draft.homeTypes.length ? draft.homeTypes : undefined,
    status: draft.status.length ? draft.status : undefined,
    keywords: cleanString(draft.keywords),
    occupancy: cleanString(draft.occupancy),
    dpeClasses: draft.dpeClasses.length ? draft.dpeClasses : undefined,
    minScore: draftNumber(draft.minScore),
    maxPricePerM2: draftNumber(draft.maxPricePerM2),
    minYield: draftNumber(draft.minYield),
    minMarketDiscount: draftNumber(draft.minMarketDiscount),
    houseWithLand: draft.houseWithLand || undefined,
    aroundAddress: cleanString(draft.aroundAddress),
    aroundRadius: draftNumber(draft.aroundRadius),
    yearBuilt: draftNumber(draft.yearBuilt),
    openHouse: draft.openHouse || undefined,
  };
}

export function stringifyNumber(value: number | undefined) {
  return value == null ? "" : String(value);
}

export function draftNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function cleanString(value: string) {
  return value.trim() || undefined;
}

export function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function stableUrlRecord(record: SalesSearchUrlRecord) {
  return JSON.stringify(
    Object.entries(record)
      .filter(([, value]) => value != null && value !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function buildSearchStatistics(sales: AuctionSale[]): SearchStatistics {
  const prices = sales
    .map((sale) => sale.starting_price_eur)
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  const pricePerM2Values = sales
    .map((sale) => pricePerM2(sale.starting_price_eur, getSaleSurface(sale).value))
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  const scores = sales
    .map((sale) => sale.investment_score)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const dpeCounts = DPE_CLASSES.reduce(
    (acc, dpeClass) => {
      acc[dpeClass] = 0;
      return acc;
    },
    {} as Record<DpeClass, number>,
  );
  let dpeKnownCount = 0;
  sales.forEach((sale) => {
    const dpe = extractDpe(sale).class;
    if (!dpe) return;
    dpeCounts[dpe] += 1;
    dpeKnownCount += 1;
  });
  const now = Date.now();

  return {
    medianPrice: median(prices),
    medianPricePerM2: median(pricePerM2Values),
    averageScore: scores.length
      ? scores.reduce((total, value) => total + value, 0) / scores.length
      : null,
    upcomingSales: sales.filter(
      (sale) => sale.sale_date && new Date(sale.sale_date).getTime() >= now,
    ).length,
    dpeCounts,
    dpeKnownCount,
  };
}

export function searchStatisticsFromServer(
  summary: SalesStatisticsResponse["summary"],
): SearchStatistics {
  return {
    medianPrice: summary.medianPriceEur,
    medianPricePerM2: summary.medianPricePerM2,
    averageScore: summary.averageInvestmentScore,
    upcomingSales: summary.upcomingSales,
    dpeCounts: summary.dpeCounts,
    dpeKnownCount: summary.dpeKnownCount,
  };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Math.round(sorted[middle]);
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);

    const onChange = () => setMatches(media.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    if (typeof media.addListener === "function") {
      media.addListener(onChange);
      return () => media.removeListener(onChange);
    }
    return undefined;
  }, [query]);

  return matches;
}

export function buildAlertName(search: SalesSearchParams) {
  const segments = [
    search.saleType ? saleTypeFilterLabel(search.saleType) : null,
    search.city,
    search.tribunal,
    search.department ? `Dép. ${search.department}` : null,
    search.homeTypes?.length === 1 ? propertyTypeLabel(search.homeTypes[0]) : null,
    search.maxPrice ? `≤ ${compactPrice(search.maxPrice)}` : null,
    search.minYield ? `rendement ≥ ${search.minYield}%` : null,
    search.dpeClasses?.length ? `DPE ${search.dpeClasses.join("/")}` : null,
  ].filter(Boolean);

  return segments.length > 0 ? `Recherche ${segments.join(" · ")}` : "Recherche Immojudis";
}

export async function watchedZoneInputFromSearch(
  search: SalesSearchParams,
  center: GeoPoint | null,
): Promise<WatchedZoneInput | null> {
  const alertDefaults = alertDefaultsFromSearch(search);

  if (search.aroundAddress) {
    const point = center ?? (await geocodeAddress(search.aroundAddress));
    if (point) {
      return {
        name: clampZoneName(`Rayon ${point.label ?? search.aroundAddress}`),
        zoneKind: "radius",
        department: search.department ?? null,
        city: search.city ?? null,
        centerLat: point.lat,
        centerLng: point.lng,
        radiusKm: search.aroundRadius ?? 10,
        alertDefaults,
        isActive: true,
      };
    }
  }

  if (search.city) {
    return {
      name: clampZoneName(
        search.department ? `${search.city} (${search.department})` : search.city,
      ),
      zoneKind: "city",
      department: search.department ?? null,
      city: search.city,
      alertDefaults,
      isActive: true,
    };
  }

  if (search.department) {
    return {
      name: `Département ${search.department}`,
      zoneKind: "department",
      department: search.department,
      alertDefaults,
      isActive: true,
    };
  }

  return null;
}

export function alertDefaultsFromSearch(
  search: SalesSearchParams,
): WatchedZoneInput["alertDefaults"] {
  return {
    maxPriceEur: search.maxPrice ?? null,
    minSurfaceM2: search.minSqft ?? null,
    minInvestmentScore: search.minScore ?? null,
    maxPricePerM2: search.maxPricePerM2 ?? null,
    minYieldPct: search.minYield ?? null,
    minMarketDiscountPct: search.minMarketDiscount ?? null,
    dpeClasses: (search.dpeClasses ?? []).filter((value): value is DpeClass =>
      DPE_CLASSES.includes(value as DpeClass),
    ),
    requireHouseWithLand: Boolean(search.houseWithLand),
  };
}

export function clampZoneName(value: string): string {
  return value.trim().slice(0, 120) || "Zone surveillée";
}
