import { saleDateBoundary } from "./search/sale-date-range";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { departmentSearchValues, frenchSearchTerms } from "@/lib/search/french-geo-search";
import type { AuctionSale, SaleFilters, SortKey, UserAlert } from "./types";

export const DETAIL_VIEW = "v_auction_sales_app";
const DISCOVERY_VIEW = "v_auction_sales_discovery" as typeof DETAIL_VIEW;
const PUBLIC_PREVIEW_VIEW = "v_auction_sales_app_preview";
const CONFIGURATION_ERROR =
  "La configuration Supabase est absente. Ajoutez les variables d'environnement Supabase pour afficher les données.";

type SupabaseQueryError = {
  code?: string;
  message?: string;
  details?: string;
};

type SupabaseReader = Pick<typeof supabase, "from">;

export const SALE_LIST_COLUMNS = [
  "source_checks",
  "source_conflicts",
  "analysis_status",
  "sale_procedure",
  "sale_venue_type",
  "sale_legal_framework",
  "sale_verification_status",
  "id",
  "title",
  "description",
  "source_description",
  "llm_display_description",
  "about_description",
  "city",
  "department",
  "postal_code",
  "address",
  "tribunal",
  "tribunal_code",
  "tribunal_name",
  "tribunal_city",
  "property_type",
  "starting_price_eur",
  "sale_date",
  "visit_dates",
  "lawyer_name",
  "lawyer_contact",
  "adjudication_price_eur",
  "latitude",
  "longitude",
  "occupancy_status",
  "surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "app_surface_m2",
  "app_surface_kind",
  "surface_scope",
  "surface_source",
  "rooms_count",
  "bedrooms_count",
  "bathrooms_count",
  "has_garden",
  "has_terrace",
  "has_garage",
  "has_pool",
  "has_air_conditioning",
  "has_double_glazing",
  "investment_score",
  "score_confidence",
  "surface_confidence",
  "surface_evidence",
  "risks",
  "documents",
  "documents_rich",
  "media",
  "source_name",
  "source_url",
  "primary_source",
  "source_urls",
  "source_blocks",
  "source_blocks_by_source",
  "dedupe_confidence",
  "quality_flags",
  "status",
  "created_at",
  "updated_at",
].join(",");

const SALE_PREVIEW_COLUMNS = [
  "id",
  "starting_price_eur",
  "sale_venue_type",
  "sale_verification_status",
].join(",");

const SALE_MAP_COLUMNS = [
  "sale_procedure",
  "sale_venue_type",
  "sale_legal_framework",
  "sale_verification_status",
  "id",
  "title",
  "city",
  "department",
  "postal_code",
  "address",
  "tribunal",
  "tribunal_name",
  "tribunal_city",
  "property_type",
  "starting_price_eur",
  "sale_date",
  "latitude",
  "longitude",
  "occupancy_status",
  "app_surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "app_surface_kind",
  "surface_scope",
  "surface_source",
  "surface_confidence",
  "surface_evidence",
  "rooms_count",
  "bedrooms_count",
  "bathrooms_count",
  "has_garden",
  "has_terrace",
  "has_garage",
  "status",
  "investment_score",
  "risks",
  "media",
  "source_name",
  "primary_source",
  "source_blocks",
  "documents_rich",
  "created_at",
].join(",");

function assertCloudConfigured() {
  if (isSupabaseConfigured) return true;
  // On the SSR worker the env may not be hydrated yet — return false so
  // callers can short-circuit with empty results and let the browser
  // refetch once the user session and env are available.
  if (typeof window === "undefined") return false;
  throw new Error(CONFIGURATION_ERROR);
}

function isMissingPreviewViewError(error: SupabaseQueryError | null): boolean {
  if (!error) return false;
  const text = `${error.code ?? ""} ${error.message ?? ""} ${error.details ?? ""}`;
  return text.includes("PGRST205") || text.includes(PUBLIC_PREVIEW_VIEW);
}

function previewSortDirection(sort: SortKey): boolean {
  return sort === "price_desc" ? false : true;
}

async function getSalesFromLegacyPreview(
  filters: SaleFilters,
  limit: number,
  sort: SortKey,
  offset: number,
): Promise<AuctionSale[]> {
  let q = supabase
    .from(DETAIL_VIEW)
    .select(SALE_PREVIEW_COLUMNS)
    .order("starting_price_eur", { ascending: previewSortDirection(sort), nullsFirst: false })
    .range(offset, offset + limit - 1);

  q = applySaleTypeFilter(q, filters);
  if (filters.min_price != null) q = q.gte("starting_price_eur", filters.min_price);
  if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

async function getSalePreviewFromLegacyView(id: string): Promise<AuctionSale | null> {
  const { data, error } = await supabase
    .from(DETAIL_VIEW)
    .select(SALE_PREVIEW_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as AuctionSale | null;
}

async function getSalesPreviewCountFromLegacyView(filters: SaleFilters): Promise<number> {
  let q = supabase.from(DETAIL_VIEW).select("id", { count: "exact" }).range(0, 999);

  q = applySaleTypeFilter(q, filters);
  if (filters.min_price != null) q = q.gte("starting_price_eur", filters.min_price);
  if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);

  const { count, data, error } = await q;
  if (error) throw error;
  return count && count > 0 ? count : (data?.length ?? 0);
}

const SORT_MAP: Record<SortKey, { column: string; ascending: boolean; nullsFirst?: boolean }> = {
  date_asc: { column: "sale_date", ascending: true },
  date_desc: { column: "sale_date", ascending: false },
  price_asc: { column: "starting_price_eur", ascending: true },
  price_desc: { column: "starting_price_eur", ascending: false },
  score_desc: { column: "investment_score", ascending: false },
  surface_desc: { column: "app_surface_m2", ascending: false },
};

type FilterableQuery = {
  eq: (column: string, value: string | number | boolean) => FilterableQuery;
  gte: (column: string, value: string | number) => FilterableQuery;
  lte: (column: string, value: string | number) => FilterableQuery;
  in: (column: string, values: string[]) => FilterableQuery;
  ilike: (column: string, pattern: string) => FilterableQuery;
  or: (filters: string) => FilterableQuery;
};

function textPattern(value: string) {
  return `%${value.replace(/[,%().]/g, " ").trim()}%`;
}

function applyTextSearch(query: FilterableQuery, columns: string[], value: string | undefined) {
  if (!value?.trim()) return query;
  const terms = frenchSearchTerms(value).slice(0, 12);

  return terms.reduce((current, term) => {
    const alternatives = accentTolerantPatterns(term);
    return current.or(
      columns
        .flatMap((column) =>
          alternatives.map((pattern) => `${column}.ilike.${textPattern(pattern)}`),
        )
        .join(","),
    );
  }, query);
}

function accentTolerantPatterns(term: string): string[] {
  const patterns = [term];
  for (let index = 0; index < term.length && patterns.length < 8; index += 1) {
    if (!/[aeiouycn]/.test(term[index] ?? "")) continue;
    patterns.push(`${term.slice(0, index)}_${term.slice(index + 1)}`);
  }
  return patterns;
}

function applySaleTypeFilter<TQuery>(query: TQuery, filters: SaleFilters): TQuery {
  let q = query as unknown as FilterableQuery;
  if (filters.sale_venue_type === "unknown") {
    q = q.in("sale_venue_type", ["unknown", "online"]);
  } else if (filters.sale_venue_type) {
    q = q.eq("sale_venue_type", filters.sale_venue_type);
  }
  return q as unknown as TQuery;
}

function applyAuthenticatedSaleFilters<TQuery>(query: TQuery, filters: SaleFilters) {
  let q = applySaleTypeFilter(query, filters) as unknown as FilterableQuery;

  if (filters.min_sale_date) q = q.gte("sale_date", saleDateBoundary(filters.min_sale_date));
  if (filters.max_sale_date) q = q.lte("sale_date", saleDateBoundary(filters.max_sale_date, true));
  if (filters.department) q = q.eq("department", filters.department);
  if (filters.departments?.length) {
    q = q.in("department", departmentSearchValues(filters.departments));
  }
  if (filters.city) q = q.ilike("city", textPattern(filters.city));
  if (filters.postal_code) q = q.eq("postal_code", filters.postal_code);
  if (filters.property_type) q = q.eq("property_type", filters.property_type);
  if (filters.property_types?.length) q = q.in("property_type", filters.property_types);
  if (filters.min_price != null) q = q.gte("starting_price_eur", filters.min_price);
  if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);
  if (filters.min_surface != null) q = q.gte("app_surface_m2", filters.min_surface);
  if (filters.max_surface != null) q = q.lte("app_surface_m2", filters.max_surface);
  if (filters.min_bedrooms != null) q = q.gte("bedrooms_count", filters.min_bedrooms);
  if (filters.min_bathrooms != null) q = q.gte("bathrooms_count", filters.min_bathrooms);
  if (filters.occupancy_status) {
    // Match the same historical aliases as occupancyLabel, before count/pagination.
    const occupancy = filters.occupancy_status.toLowerCase();
    if (["free", "vacant", "libre"].includes(occupancy)) {
      q = q.or(
        "occupancy_status.ilike.%libre%,occupancy_status.ilike.vacant,occupancy_status.ilike.free",
      );
    } else if (["occupied", "occupé", "occupe"].includes(occupancy)) {
      q = q.ilike("occupancy_status", "%occup%");
    } else if (["rented", "loué", "loue"].includes(occupancy)) {
      q = q.or(
        "occupancy_status.ilike.%loué%,occupancy_status.ilike.%loue%,occupancy_status.ilike.%rented%",
      );
    } else q = q.eq("occupancy_status", filters.occupancy_status);
  }
  if (filters.min_score != null) q = q.gte("investment_score", filters.min_score);
  if (filters.tribunal_code) q = q.eq("tribunal_code", filters.tribunal_code);
  if (filters.status_in?.length) q = q.in("status", filters.status_in);
  if (filters.viewport) {
    q = q
      .gte("latitude", filters.viewport.south)
      .lte("latitude", filters.viewport.north)
      .gte("longitude", filters.viewport.west)
      .lte("longitude", filters.viewport.east);
  }
  if (filters.only_new) {
    q = q.gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  }
  q = applyTextSearch(
    q,
    ["tribunal", "tribunal_name", "tribunal_city", "tribunal_code"],
    filters.tribunal,
  );
  q = applyTextSearch(
    q,
    [
      "title",
      "description",
      "source_description",
      "city",
      "department",
      "postal_code",
      "address",
      "tribunal",
      "tribunal_name",
      "tribunal_city",
      "tribunal_code",
    ],
    filters.keywords,
  );

  return q as unknown as TQuery;
}

export async function getSales(
  filters: SaleFilters = {},
  limit = 100,
  sort: SortKey = "date_asc",
  offset = 0,
  options: { preview?: boolean; discovery?: boolean; client?: SupabaseReader } = {},
): Promise<AuctionSale[]> {
  if (!options.client && !assertCloudConfigured()) return [];
  const db = options.client ?? supabase;

  if (options.preview) {
    let q = db
      .from(PUBLIC_PREVIEW_VIEW)
      .select(SALE_PREVIEW_COLUMNS)
      .order("starting_price_eur", { ascending: previewSortDirection(sort), nullsFirst: false })
      .range(offset, offset + limit - 1);

    q = applySaleTypeFilter(q, filters);
    if (filters.min_price != null) q = q.gte("starting_price_eur", filters.min_price);
    if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);

    const { data, error } = await q;
    if (isMissingPreviewViewError(error)) {
      return getSalesFromLegacyPreview(filters, limit, sort, offset);
    }
    if (error) throw error;
    return (data ?? []) as unknown as AuctionSale[];
  }

  const s = SORT_MAP[sort];
  const catalogView = options.discovery ? DISCOVERY_VIEW : DETAIL_VIEW;
  let q = db
    .from(catalogView)
    .select(SALE_LIST_COLUMNS)
    .order(s.column, { ascending: s.ascending, nullsFirst: false })
    .range(offset, offset + limit - 1);

  q = applyAuthenticatedSaleFilters(q, filters);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

export async function getSalesCount(
  filters: SaleFilters = {},
  options: { discovery?: boolean } = {},
): Promise<number> {
  if (!assertCloudConfigured()) return 0;
  const catalogView = options.discovery ? DISCOVERY_VIEW : DETAIL_VIEW;
  let q = supabase.from(catalogView).select("id", { count: "exact", head: true });

  q = applyAuthenticatedSaleFilters(q, filters);

  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export async function getSalesPreviewCount(filters: SaleFilters = {}): Promise<number> {
  if (!assertCloudConfigured()) return 0;
  let q = supabase.from(PUBLIC_PREVIEW_VIEW).select("id", { count: "exact", head: true });

  q = applySaleTypeFilter(q, filters);
  if (filters.min_price != null) q = q.gte("starting_price_eur", filters.min_price);
  if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);

  const { count, error } = await q;
  if (isMissingPreviewViewError(error)) {
    return getSalesPreviewCountFromLegacyView(filters);
  }
  if (error) throw error;
  return count ?? 0;
}

export async function getSaleById(
  id: string,
  options: { discovery?: boolean } = {},
): Promise<AuctionSale | null> {
  if (!assertCloudConfigured()) return null;
  if (typeof window === "undefined") return null;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  const catalogView = options.discovery ? DISCOVERY_VIEW : DETAIL_VIEW;
  const { data, error } = await supabase.from(catalogView).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as AuctionSale | null;
}

export async function getSalePreviewById(id: string): Promise<AuctionSale | null> {
  if (!assertCloudConfigured()) return null;
  const { data, error } = await supabase
    .from(PUBLIC_PREVIEW_VIEW)
    .select(SALE_PREVIEW_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (isMissingPreviewViewError(error)) return getSalePreviewFromLegacyView(id);
  if (error) throw error;
  return data as unknown as AuctionSale | null;
}

export async function getSalesWithCoords(
  filters: SaleFilters = {},
  limit = 500,
  sort: SortKey = "date_asc",
  options: { discovery?: boolean } = {},
): Promise<AuctionSale[]> {
  if (!assertCloudConfigured()) return [];
  const s = SORT_MAP[sort];
  const catalogView = options.discovery ? DISCOVERY_VIEW : DETAIL_VIEW;
  let q = supabase
    .from(catalogView)
    .select(SALE_MAP_COLUMNS)
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .order(s.column, { ascending: s.ascending, nullsFirst: false })
    .limit(limit);

  q = applyAuthenticatedSaleFilters(q, filters);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

/**
 * Fetch sales within a bounding box around (lat,lng).
 * radiusKm is the half-side of the bbox; the caller is expected to filter
 * by exact haversine distance afterwards if needed.
 */
export async function getNearbySales(
  lat: number,
  lng: number,
  radiusKm: number,
  excludeId?: string,
  limit = 50,
): Promise<AuctionSale[]> {
  if (!assertCloudConfigured()) return [];
  // 1° latitude ≈ 111 km. 1° longitude ≈ 111 km × cos(lat).
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  let q = supabase
    .from(DETAIL_VIEW)
    .select(SALE_LIST_COLUMNS)
    .gte("latitude", lat - dLat)
    .lte("latitude", lat + dLat)
    .gte("longitude", lng - dLng)
    .lte("longitude", lng + dLng)
    .order("sale_date", { ascending: true })
    .limit(limit);
  if (excludeId) q = q.neq("id", excludeId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

export async function getStats(): Promise<{
  totalSales: number;
  departments: number;
  nextSale: string | null;
}> {
  if (!assertCloudConfigured()) return { totalSales: 0, departments: 0, nextSale: null };
  const { count, error } = await supabase
    .from(PUBLIC_PREVIEW_VIEW)
    .select("*", { count: "exact", head: true });
  let totalSales = count ?? 0;

  if (isMissingPreviewViewError(error)) {
    const { count: legacyCount, error: legacyError } = await supabase
      .from(DETAIL_VIEW)
      .select("id", { count: "exact", head: true });
    if (legacyError) throw legacyError;
    totalSales = legacyCount ?? 0;
  } else if (error) {
    throw error;
  }

  if (typeof window === "undefined") {
    return { totalSales, departments: 0, nextSale: null };
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { totalSales, departments: 0, nextSale: null };
  const { data: deps } = await supabase
    .from(DISCOVERY_VIEW)
    .select("department")
    .not("department", "is", null)
    .limit(1000);
  const uniqueDeps = new Set(
    (deps ?? []).map((r: { department: string | null }) => r.department).filter(Boolean),
  );
  const { data: next } = await supabase
    .from(DISCOVERY_VIEW)
    .select("sale_date")
    .gte("sale_date", new Date().toISOString())
    .order("sale_date", { ascending: true })
    .limit(1);
  return {
    totalSales,
    departments: uniqueDeps.size,
    nextSale: next?.[0]?.sale_date ?? null,
  };
}

// Favorites
export async function getFavorites(userId: string): Promise<AuctionSale[]> {
  if (!assertCloudConfigured()) return [];
  const { data: favs, error } = await supabase
    .from("user_favorites")
    .select("sale_id")
    .eq("user_id", userId);
  if (error) throw error;
  const ids = (favs ?? []).map((f: { sale_id: string }) => f.sale_id);
  if (ids.length === 0) return [];
  const { data, error: e2 } = await supabase
    .from(DETAIL_VIEW)
    .select(SALE_LIST_COLUMNS)
    .in("id", ids);
  if (e2) throw e2;
  return (data ?? []) as unknown as AuctionSale[];
}

export async function getFavoriteIds(userId: string): Promise<Set<string>> {
  if (!assertCloudConfigured()) return new Set();
  const { data, error } = await supabase
    .from("user_favorites")
    .select("sale_id")
    .eq("user_id", userId);
  if (error) throw error;
  return new Set((data ?? []).map((r: { sale_id: string }) => r.sale_id));
}

export async function addFavorite(userId: string, saleId: string) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_favorites")
    .insert({ user_id: userId, sale_id: saleId });
  if (error && !error.message.includes("duplicate")) throw error;
}

export async function removeFavorite(userId: string, saleId: string) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("sale_id", saleId);
  if (error) throw error;
}

// Alerts
type UserAlertInsert = Database["public"]["Tables"]["user_alerts"]["Insert"];
export type CreateAlertPayload = Omit<
  UserAlertInsert,
  "id" | "user_id" | "created_at" | "updated_at" | "last_evaluated_at" | "last_match_count"
> & {
  is_active?: boolean;
};

export async function getAlerts(userId: string): Promise<UserAlert[]> {
  if (!assertCloudConfigured()) return [];
  const { data, error } = await supabase
    .from("user_alerts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as UserAlert[];
}

export async function createAlert(userId: string, payload: CreateAlertPayload) {
  assertCloudConfigured();
  const insertPayload: UserAlertInsert = {
    user_id: userId,
    ...payload,
    is_active: payload.is_active ?? true,
    dpe_classes: payload.dpe_classes ?? [],
    require_house_with_land: payload.require_house_with_land ?? false,
    alert_frequency: payload.alert_frequency ?? "daily",
    advanced_criteria: payload.advanced_criteria ?? {},
  };
  const { error } = await supabase.from("user_alerts").insert(insertPayload);
  if (error) throw error;
}

export async function updateAlert(userId: string, alertId: string, patch: Partial<UserAlert>) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_alerts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteAlert(userId: string, alertId: string) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_alerts")
    .delete()
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) throw error;
}
