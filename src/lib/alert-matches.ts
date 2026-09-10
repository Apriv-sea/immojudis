import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { isDiscoveryAlertCompatible } from "@/lib/discovery-alerts";
import { alertMatchesSale } from "@/lib/alerts";
import { createAlertNotificationsForMatches } from "@/lib/alert-notifications";
import { extractDpe } from "@/lib/dpe";
import { estimateGrossYieldPct, pricePerM2 } from "@/lib/geo";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { getSales } from "@/lib/queries";
import { getPrecomputedMarketEstimate } from "@/lib/sale-market-estimates";
import { cleanSaleTitle } from "@/lib/sale-title";
import { getMarketValuationSurfaces, getSaleSurface } from "@/lib/surface";
import type { AuctionSale, UserAlert, UserWatchedZone } from "@/lib/types";
import { normalizeWatchedZone } from "@/lib/watched-zones";

type AlertMatchRow = Database["public"]["Tables"]["user_alert_matches"]["Row"];

export type AlertMatchSummary = {
  id: string | null;
  alertId: string;
  alertName: string;
  saleId: string;
  saleTitle: string | null;
  city: string | null;
  department: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  reasons: string[];
  marketDiscountPct: number | null;
  matchedAt: string;
  readAt: string | null;
  dismissedAt: string | null;
};

export type AlertEvaluationResponse = {
  evaluatedAt: string;
  alertCount: number;
  saleCount: number;
  matchCount: number;
  notificationCount: number;
  persisted: boolean;
  matches: AlertMatchSummary[];
};

export type SmartAlertBatchUserResult = {
  userId: string;
  ok: boolean;
  alertCount: number;
  saleCount: number;
  matchCount: number;
  notificationCount: number;
  error: string | null;
};

export type SmartAlertBatchRunResult = {
  ok: true;
  startedAt: string;
  finishedAt: string;
  candidateUserCount: number;
  analysedUserCount: number;
  evaluatedUserCount: number;
  failedUserCount: number;
  totalMatchCount: number;
  totalNotificationCount: number;
  results: SmartAlertBatchUserResult[];
};

const DEFAULT_ALERT_EVALUATION_SALE_LIMIT = 160;
const MAX_ALERT_EVALUATION_SALE_LIMIT = 400;
const DEFAULT_ALERT_BATCH_USER_LIMIT = 25;
const MAX_ALERT_BATCH_USER_LIMIT = 100;
const DEFAULT_ALERT_MATCH_LIST_LIMIT = 50;
const MAX_ALERT_MATCH_LIST_LIMIT = 200;

export async function listUserAlertMatches({
  auth,
  limit = DEFAULT_ALERT_MATCH_LIST_LIMIT,
  includeDismissed = false,
}: {
  auth: SupabaseAuthContext;
  limit?: number;
  includeDismissed?: boolean;
}): Promise<{ matches: AlertMatchSummary[] }> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "alerts.advanced")) {
    throw new Error("Alertes avancées réservées au plan Analyse.");
  }

  let query = auth.supabase
    .from("user_alert_matches")
    .select("*")
    .eq("user_id", auth.userId)
    .order("matched_at", { ascending: false })
    .limit(clampLimit(limit, MAX_ALERT_MATCH_LIST_LIMIT));

  if (!includeDismissed) query = query.is("dismissed_at", null);

  const { data, error } = await query;
  if (error) throw error;

  return {
    matches: (data ?? []).map(alertMatchRowToSummary),
  };
}

export async function evaluateUserAlertMatches({
  auth,
  saleLimit = DEFAULT_ALERT_EVALUATION_SALE_LIMIT,
  persist = true,
}: {
  auth: SupabaseAuthContext;
  saleLimit?: number;
  persist?: boolean;
}): Promise<AlertEvaluationResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "alerts.advanced")) {
    throw new Error("Alertes avancées réservées au plan Analyse.");
  }

  const discovery = !plan.hasAnalysisAccess;
  const evaluatedAt = new Date().toISOString();
  const activeAlerts = await getActiveUserAlerts(auth);
  const alerts = discovery
    ? activeAlerts.filter(isDiscoveryAlertCompatible).slice(0, 1)
    : activeAlerts;
  const sales = await getSales(
    {
      status_in: ["active", "upcoming"],
      ...(discovery && alerts.length === 1
        ? {
            city: alerts[0].city ?? undefined,
            department: alerts[0].department ?? undefined,
          }
        : {}),
    },
    clampLimit(saleLimit, MAX_ALERT_EVALUATION_SALE_LIMIT),
    "date_asc",
    0,
    { client: auth.supabase, discovery },
  );
  const marketDiscountCache = new Map<string, Promise<number | null>>();
  const watchedZones = await getUserWatchedZonesForAlerts({ auth, alerts });
  const matches: AlertMatchSummary[] = [];
  const rows: Database["public"]["Tables"]["user_alert_matches"]["Insert"][] = [];
  const matchCounts = new Map<string, number>();

  for (const alert of alerts) {
    if (discovery && !isDiscoveryAlertCompatible(alert)) continue;
    const watchedZone = alert.watched_zone_id
      ? (watchedZones.get(alert.watched_zone_id) ?? null)
      : null;
    if (alert.watched_zone_id && !watchedZone) continue;

    for (const sale of sales) {
      let marketDiscountPct: number | null = null;
      if (alert.min_market_discount_pct != null) {
        const preliminary = alertMatchesSale({ ...alert, min_market_discount_pct: null }, sale, {
          watchedZone,
        });
        if (!preliminary.matches) continue;
        marketDiscountPct = await getCachedMarketDiscount(marketDiscountCache, sale);
      }

      const baseContext = {
        ...(alert.min_market_discount_pct == null ? {} : { marketDiscountPct }),
        watchedZone,
      };
      const result = alertMatchesSale(alert, sale, baseContext);
      if (!result.matches) continue;

      const summary = buildAlertMatchSummary({
        alert,
        sale,
        reasons: result.reasons,
        marketDiscountPct,
        matchedAt: evaluatedAt,
      });
      if (discovery) {
        summary.saleTitle = "Vente immobilière";
        summary.marketDiscountPct = null;
        summary.reasons = ["Critères publics correspondants"];
      }
      matches.push(summary);
      matchCounts.set(alert.id, (matchCounts.get(alert.id) ?? 0) + 1);

      rows.push({
        user_id: auth.userId,
        alert_id: alert.id,
        sale_id: sale.id,
        match_reasons: summary.reasons,
        matched_at: evaluatedAt,
        match_snapshot: asJson(
          buildAlertMatchSnapshot({ alert, sale, summary, watchedZone, discovery }),
        ),
      });
    }
  }

  if (persist) {
    if (rows.length) {
      const { data, error } = await supabaseAdmin
        .from("user_alert_matches")
        .upsert(rows, { onConflict: "alert_id,sale_id" })
        .select("*");
      if (error) throw error;

      const persistedByKey = new Map(
        (data ?? []).map((row) => [`${row.alert_id}:${row.sale_id}`, row]),
      );
      matches.forEach((match) => {
        const persistedRow = persistedByKey.get(`${match.alertId}:${match.saleId}`);
        if (persistedRow) {
          match.id = persistedRow.id;
          match.readAt = persistedRow.read_at;
          match.dismissedAt = persistedRow.dismissed_at;
        }
      });
    }

    await updateAlertEvaluationState({
      auth,
      alerts,
      matchCounts,
      evaluatedAt,
    });
  }
  const notificationResult =
    persist && matches.some((match) => match.id)
      ? await createAlertNotificationsForMatches({
          auth,
          matches,
          alerts,
          now: new Date(evaluatedAt),
          discovery,
        })
      : { notificationCount: 0 };

  return {
    evaluatedAt,
    alertCount: alerts.length,
    saleCount: sales.length,
    matchCount: matches.length,
    notificationCount: notificationResult.notificationCount,
    persisted: persist,
    matches,
  };
}

export async function runSmartAlertEvaluationBatch({
  userLimit = DEFAULT_ALERT_BATCH_USER_LIMIT,
  saleLimit = DEFAULT_ALERT_EVALUATION_SALE_LIMIT,
}: {
  userLimit?: number;
  saleLimit?: number;
} = {}): Promise<SmartAlertBatchRunResult> {
  const startedAt = new Date().toISOString();
  const candidateUserIds = await getSmartAlertCandidateUserIds(
    clampLimit(userLimit * 4, MAX_ALERT_BATCH_USER_LIMIT * 4),
  );
  const analyseUserIds = candidateUserIds;
  const selectedUserIds = analyseUserIds.slice(
    0,
    clampLimit(userLimit, MAX_ALERT_BATCH_USER_LIMIT),
  );
  const results: SmartAlertBatchUserResult[] = [];

  for (const userId of selectedUserIds) {
    try {
      const response = await evaluateUserAlertMatches({
        auth: systemAuthForUser(userId),
        saleLimit,
        persist: true,
      });
      results.push({
        userId,
        ok: true,
        alertCount: response.alertCount,
        saleCount: response.saleCount,
        matchCount: response.matchCount,
        notificationCount: response.notificationCount,
        error: null,
      });
    } catch (error) {
      results.push({
        userId,
        ok: false,
        alertCount: 0,
        saleCount: 0,
        matchCount: 0,
        notificationCount: 0,
        error: error instanceof Error ? error.message : "Évaluation impossible",
      });
    }
  }

  return {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidateUserCount: candidateUserIds.length,
    analysedUserCount: analyseUserIds.length,
    evaluatedUserCount: results.filter((result) => result.ok).length,
    failedUserCount: results.filter((result) => !result.ok).length,
    totalMatchCount: results.reduce((total, result) => total + result.matchCount, 0),
    totalNotificationCount: results.reduce((total, result) => total + result.notificationCount, 0),
    results,
  };
}

export function buildAlertMatchSummary({
  alert,
  sale,
  reasons,
  marketDiscountPct,
  matchedAt,
}: {
  alert: Pick<UserAlert, "id" | "name">;
  sale: Pick<
    AuctionSale,
    "id" | "title" | "city" | "department" | "starting_price_eur" | "sale_date"
  >;
  reasons: string[];
  marketDiscountPct?: number | null;
  matchedAt: string;
}): AlertMatchSummary {
  return {
    id: null,
    alertId: alert.id,
    alertName: alert.name,
    saleId: sale.id,
    saleTitle: cleanSaleTitle(sale.title),
    city: sale.city,
    department: sale.department,
    startingPriceEur: sale.starting_price_eur,
    saleDate: sale.sale_date,
    reasons,
    marketDiscountPct: roundPercent(marketDiscountPct),
    matchedAt,
    readAt: null,
    dismissedAt: null,
  };
}

export function buildAlertMatchSnapshot({
  alert,
  sale,
  summary,
  watchedZone,
  discovery = false,
}: {
  alert: Pick<
    UserAlert,
    | "id"
    | "name"
    | "department"
    | "city"
    | "property_type"
    | "max_price_eur"
    | "min_surface_m2"
    | "min_investment_score"
    | "max_price_per_m2"
    | "min_yield_pct"
    | "min_market_discount_pct"
    | "dpe_classes"
    | "require_house_with_land"
    | "watched_zone_id"
  >;
  sale: AuctionSale;
  summary: AlertMatchSummary;
  watchedZone?: UserWatchedZone | null;
  discovery?: boolean;
}) {
  if (discovery) {
    return {
      audience: "discovery",
      alert: { id: alert.id, name: alert.name },
      sale: {
        id: sale.id,
        title: "Vente immobilière",
        city: sale.city,
        department: sale.department,
        startingPriceEur: sale.starting_price_eur,
        saleDate: sale.sale_date,
      },
      match: {
        reasons: ["Critères publics correspondants"],
        marketDiscountPct: null,
        matchedAt: summary.matchedAt,
      },
    };
  }
  const surface = getSaleSurface(sale).value;
  const dpe = extractDpe(sale).class;
  const yieldPct = estimateGrossYieldPct(sale.starting_price_eur, surface, sale.department);
  const documents = documentSignatureParts(sale);

  return {
    alert: {
      id: alert.id,
      name: alert.name,
      criteria: {
        department: alert.department,
        city: alert.city,
        propertyType: alert.property_type,
        maxPriceEur: alert.max_price_eur,
        minSurfaceM2: alert.min_surface_m2,
        minInvestmentScore: alert.min_investment_score,
        maxPricePerM2: alert.max_price_per_m2,
        minYieldPct: alert.min_yield_pct,
        minMarketDiscountPct: alert.min_market_discount_pct,
        dpeClasses: alert.dpe_classes,
        requireHouseWithLand: alert.require_house_with_land,
        watchedZoneId: alert.watched_zone_id,
        watchedZone: watchedZone
          ? {
              id: watchedZone.id,
              name: watchedZone.name,
              zoneKind: watchedZone.zone_kind,
              department: watchedZone.department,
              city: watchedZone.city,
              postalCodePrefix: watchedZone.postal_code_prefix,
              centerLat: watchedZone.center_lat,
              centerLng: watchedZone.center_lng,
              radiusKm: watchedZone.radius_km,
            }
          : null,
      },
    },
    sale: {
      id: sale.id,
      title: cleanSaleTitle(sale.title),
      city: sale.city,
      department: sale.department,
      propertyType: sale.property_type,
      startingPriceEur: sale.starting_price_eur,
      saleDate: sale.sale_date,
      status: sale.status,
      surfaceM2: surface,
      pricePerM2: roundNumber(pricePerM2(sale.starting_price_eur, surface)),
      investmentScore: sale.investment_score,
      documentCount: documents.count,
      documentSignature: documents.signature,
      updatedAt: sale.updated_at,
      dpe,
      grossYieldPct: roundPercent(yieldPct),
      sourceName: sale.source_name,
      sourceUrl: sale.source_url,
    },
    match: {
      reasons: summary.reasons,
      marketDiscountPct: summary.marketDiscountPct,
      matchedAt: summary.matchedAt,
    },
  };
}

function alertMatchRowToSummary(row: AlertMatchRow): AlertMatchSummary {
  const snapshot = asRecord(row.match_snapshot);
  const alert = asRecord(snapshot.alert);
  const sale = asRecord(snapshot.sale);
  const match = asRecord(snapshot.match);

  return {
    id: row.id,
    alertId: row.alert_id,
    alertName: stringValue(asRecord(alert).name) || "Alerte",
    saleId: row.sale_id,
    saleTitle: cleanSaleTitle(stringValue(sale.title)),
    city: stringValue(sale.city),
    department: stringValue(sale.department),
    startingPriceEur: numberValue(sale.startingPriceEur),
    saleDate: stringValue(sale.saleDate),
    reasons: row.match_reasons,
    marketDiscountPct: numberValue(match.marketDiscountPct),
    matchedAt: row.matched_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
  };
}

async function getActiveUserAlerts(auth: SupabaseAuthContext): Promise<UserAlert[]> {
  const { data, error } = await auth.supabase
    .from("user_alerts")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as UserAlert[];
}

async function getUserWatchedZonesForAlerts({
  auth,
  alerts,
}: {
  auth: SupabaseAuthContext;
  alerts: UserAlert[];
}): Promise<Map<string, UserWatchedZone>> {
  const zoneIds = Array.from(
    new Set(alerts.map((alert) => alert.watched_zone_id).filter((id): id is string => Boolean(id))),
  );
  if (!zoneIds.length) return new Map();

  const { data, error } = await auth.supabase
    .from("user_watched_zones")
    .select("*")
    .eq("user_id", auth.userId)
    .in("id", zoneIds)
    .eq("is_active", true);

  if (error) throw error;

  return new Map((data ?? []).map((row) => [row.id, normalizeWatchedZone(row)]));
}

async function getSmartAlertCandidateUserIds(limit: number): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("user_alerts")
    .select("user_id")
    .eq("is_active", true)
    .order("last_evaluated_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) throw error;
  return Array.from(new Set((data ?? []).map((row) => row.user_id)));
}

function systemAuthForUser(userId: string): SupabaseAuthContext {
  return {
    supabase: supabaseAdmin,
    userId,
    claims: {},
    accountTier: "free",
    userRole: "user",
    isAdmin: false,
  };
}

async function updateAlertEvaluationState({
  auth,
  alerts,
  matchCounts,
  evaluatedAt,
}: {
  auth: SupabaseAuthContext;
  alerts: UserAlert[];
  matchCounts: Map<string, number>;
  evaluatedAt: string;
}) {
  await Promise.all(
    alerts.map(async (alert) => {
      const { error } = await auth.supabase
        .from("user_alerts")
        .update({
          last_evaluated_at: evaluatedAt,
          last_match_count: matchCounts.get(alert.id) ?? 0,
        })
        .eq("id", alert.id)
        .eq("user_id", auth.userId);
      if (error) throw error;
    }),
  );
}

async function getCachedMarketDiscount(
  cache: Map<string, Promise<number | null>>,
  sale: AuctionSale,
): Promise<number | null> {
  const existing = cache.get(sale.id);
  if (existing) return existing;

  const promise = estimateMarketDiscountPct(sale);
  cache.set(sale.id, promise);
  return promise;
}

async function estimateMarketDiscountPct(sale: AuctionSale): Promise<number | null> {
  const marketSurfaces = getMarketValuationSurfaces(sale);
  const surface = marketSurfaces.builtSurfaceM2 ?? marketSurfaces.landSurfaceM2;
  const startingPrice = sale.starting_price_eur;
  if (
    (!sale.address &&
      !sale.city &&
      !sale.postal_code &&
      (sale.latitude == null || sale.longitude == null)) ||
    surface == null ||
    surface <= 0 ||
    startingPrice == null ||
    startingPrice <= 0
  ) {
    return null;
  }

  try {
    const estimate = await getPrecomputedMarketEstimate(sale.id);
    if (!estimate?.actionable) return null;
    const estimatedValue =
      estimate.estimatedValueEur ??
      (estimate.medianPricePerM2 ? estimate.medianPricePerM2 * surface : null);
    if (!estimatedValue || estimatedValue <= 0) return null;
    return roundPercent(((estimatedValue - startingPrice) / estimatedValue) * 100);
  } catch {
    return null;
  }
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value || 1)));
}

function roundNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function roundPercent(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function documentSignatureParts(sale: AuctionSale): { count: number; signature: string | null } {
  const values = Array.isArray(sale.documents_rich)
    ? sale.documents_rich.map((document) =>
        [
          document.url,
          document.label,
          document.type ?? document.document_type,
          document.extraction_status,
        ]
          .filter(Boolean)
          .join("|"),
      )
    : primitiveDocumentValues(sale.documents);
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();

  return {
    count: unique.length,
    signature: unique.length ? unique.join("||") : null,
  };
}

function primitiveDocumentValues(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(primitiveDocumentValues);
  if (typeof value === "object") return Object.values(value).flatMap(primitiveDocumentValues);
  return [];
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
