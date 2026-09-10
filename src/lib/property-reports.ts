import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { buildActiveComparablesAnalysis } from "@/lib/active-comparables-analysis";
import { buildAudienceReadinessAnalysis } from "@/lib/audience-readiness-analysis";
import { buildAuctionCostAnalysis } from "@/lib/auction-cost-analysis";
import { buildCadastralAnalysis, type StructuredCadastralParcel } from "@/lib/cadastre-analysis";
import { buildDemographicAnalysis } from "@/lib/demographic-analysis";
import { buildDpeAnalysis } from "@/lib/dpe-analysis";
import { normalizeDpeClass, type StructuredDpeDiagnostic } from "@/lib/dpe";
import {
  formatDate,
  formatPrice,
  formatPricePerM2,
  occupancyLabel,
  propertyTypeLabel,
} from "@/lib/format";
import { getEnvironmentalContext, type EnvironmentalContext } from "@/lib/environment.functions";
import { estimateGrossYieldPct, pricePerM2 } from "@/lib/geo";
import { buildLegalAttentionAnalysis } from "@/lib/legal-attention-analysis";
import type { MarketEstimate } from "@/lib/market.functions";
import { buildMarketComparablesAnalysis } from "@/lib/market-comparables-analysis";
import { buildNearbyServicesAnalysis } from "@/lib/nearby-services";
import { buildNeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";
import { buildRenovationAnalysis } from "@/lib/renovation-analysis";
import { cleanSaleTitle } from "@/lib/sale-title";
import { getPrecomputedMarketEstimate } from "@/lib/sale-market-estimates";
import {
  featureAccess,
  featureIncluded,
  isPlanPeriodActive,
  normalizePlanCode,
  PLAN_LABELS,
  PLAN_LIMITS,
  type FeatureAccess,
  type FeatureKey,
  type PlanCode,
} from "@/lib/plans";
import {
  computeAcquisitionCosts,
  computeRecommendedCeilings,
  computeRentabilityScore,
  DEFAULT_MARKET_CEILING_SCENARIO,
  DEFAULTS,
} from "@/lib/profitability";
import { createTextPdf } from "@/lib/simple-pdf";
import {
  buildReportTraceability,
  REPORT_COMPLIANCE_NOTICE,
  type SourceTraceEntry,
} from "@/lib/source-traceability";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";
import { getMarketValuationSurfaces, getSaleSurface } from "@/lib/surface";
import {
  buildUrbanPlanningAnalysis,
  type StructuredUrbanPlanningSignal,
} from "@/lib/urban-planning-analysis";
import { assertUsageLimitAvailable, recordFeatureUsageEvent } from "@/lib/usage";
import { buildValuationAudit } from "@/lib/valuation-audit";
import {
  buildValuationBacktestForSale,
  type ValuationBacktestResult,
} from "@/lib/valuation-backtest";
import type {
  AuctionSale,
  SaleDocumentRich,
  SaleMedia,
  SaleRisk,
  SaleScoreFactor,
} from "@/lib/types";
import {
  buildCeilingSnapshot,
  buildMarketSnapshot,
  buildReportSnapshot,
} from "./property-report/analysis";
import {
  assertEntitlementIncluded,
  assertPdfExportAvailable,
  assertReportCreationAvailable,
  buildPlanEntitlements,
  emptyActiveComparableSales,
  featureUnlocked,
  sanitizeReportSnapshotForPlan,
} from "./property-report/entitlements";
import { reportToPdfLines, REPORT_PDF_HEADINGS } from "./property-report/pdf";
import {
  assertReportSourceCurrent,
  reportSourceFingerprint,
} from "./property-report/source-integrity";
import {
  getActiveComparableSales,
  getCadastralParcels,
  getDpeDiagnostics,
  getExistingReportId,
  getReport,
  getSale,
  getUrbanPlanningSignals,
  getValuationBacktestForReport,
  recordPdfExport,
} from "./property-report/repository";
import {
  asJson,
  asRecord,
  attachPlan,
  createShareToken,
  defaultReportTitle,
  emptyToNull,
  normalizeShareExpiresAt,
  normalizeShareToken,
  normalizeSourceTrace,
  normalizeStringList,
  pdfWatermarkForPlan,
  saleLocation,
  shareIsExpired,
  slugify,
  stringValue,
} from "./property-report/serialization";
export type SupabaseClient = SupabaseAuthContext["supabase"];
export type AppSaleRow = Database["public"]["Views"]["v_auction_sales_app"]["Row"];
export type SavedReportRow = Database["public"]["Tables"]["saved_property_reports"]["Row"];
export type CadastreParcelRow = Database["public"]["Tables"]["auction_cadastre_parcels"]["Row"];
export type DpeDiagnosticRow = Database["public"]["Tables"]["auction_dpe_diagnostics"]["Row"];
export type UrbanPlanningSignalRow =
  Database["public"]["Tables"]["auction_urban_planning_signals"]["Row"];
export type ActiveComparableSales = {
  scopeLabel: string;
  sales: AuctionSale[];
};

import { computeReportSimulation, reportSimulationSchema } from "./report-simulation";
import { listingValuationConflict } from "./listing-evidence";

export const propertyReportRequestSchema = z.object({
  saleId: z.string().uuid(),
  reportKind: z.enum(["opportunity", "market", "bid_ceiling"]).default("opportunity"),
  title: z.string().trim().min(3).max(140).optional(),
  userNotes: z.string().trim().max(2500).optional(),
  includeEnvironment: z.boolean().default(false),
  simulation: reportSimulationSchema.optional(),
});

export const propertyReportUpdateSchema = z.object({
  title: z.string().trim().min(3).max(140).optional(),
  userNotes: z.string().trim().max(2500).nullable().optional(),
});

export type PropertyReportRequestInput = z.input<typeof propertyReportRequestSchema>;
export type PropertyReportRequestPayload = z.output<typeof propertyReportRequestSchema>;
export type PropertyReportUpdateInput = z.input<typeof propertyReportUpdateSchema>;
export type PropertyReportUpdatePayload = z.output<typeof propertyReportUpdateSchema>;

export type PlanEntitlements = {
  plan: PlanCode;
  label: string;
  hasAnalysisAccess: boolean;
  currentPeriodEnd: string | null;
  limits: (typeof PLAN_LIMITS)[PlanCode];
  features: {
    salesStatistics: FeatureAccess;
    saleFavorites: FeatureAccess;
    salesCsvExport: FeatureAccess;
    salesApiAccess: FeatureAccess;
    multiPropertyAnalysis: FeatureAccess;
    smartAlerts: FeatureAccess;
    realtimeAlertChanges: FeatureAccess;
    watchedZones: FeatureAccess;
    dpeExplorer: FeatureAccess;
    marketDemographics: FeatureAccess;
    marketPriceDistribution: FeatureAccess;
    valueEstimate: FeatureAccess;
    cadastralAnalysis: FeatureAccess;
    nearbyServices: FeatureAccess;
    savedReports: FeatureAccess;
    pdfExport: FeatureAccess;
    reportEditing: FeatureAccess;
    urbanPlanning: FeatureAccess;
    streetFacade: FeatureAccess;
    saleHistory: FeatureAccess;
    soldComparables: FeatureAccess;
    activeComparables: FeatureAccess;
    neighborhoodAnalysis: FeatureAccess;
    outcomeGraph: FeatureAccess;
    informationAgent: FeatureAccess;
    bidCeiling: FeatureAccess;
    advancedBidScenarios: FeatureAccess;
    dpeMap: FeatureAccess;
    lawyerDirectory: FeatureAccess;
    lawyerReferrals: FeatureAccess;
    audienceTracking: FeatureAccess;
    workspaceCollaboration: FeatureAccess;
  };
};

const ADMIN_PLAN_LIMITS: PlanEntitlements["limits"] = {
  propertyReportsPerMonth: null,
  pdfExportsPerMonth: null,
  savedReports: null,
  reportEditing: "full",
  favoriteSales: null,
  watchedZones: null,
  saleAnalysisSets: null,
  saleAnalysisItems: null,
  apiKeys: null,
  workspaceCollaborators: null,
  informationAgentMissionsPer30Days: null,
};

export type SavedPropertyReport = SavedReportRow & {
  plan: PlanEntitlements;
};

export type PropertyReportListResponse = {
  reports: SavedPropertyReport[];
  plan: PlanEntitlements;
};

export type PropertyReportSaveResponse = {
  report: SavedPropertyReport;
  plan: PlanEntitlements;
};

export type PropertyReportExport = {
  bytes: Uint8Array;
  filename: string;
  contentType: "application/pdf";
};

export type PropertyReportShare = {
  enabled: boolean;
  token: string | null;
  url: string | null;
  sharedAt: string | null;
  expiresAt: string | null;
  viewCount: number;
};

export type PropertyReportShareResponse = {
  report: SavedPropertyReport;
  plan: PlanEntitlements;
  share: PropertyReportShare;
};

export type PublicSharedPropertyReport = {
  id: string;
  title: string;
  reportKind: SavedReportRow["report_kind"];
  updatedAt: string;
  sharedAt: string | null;
  expiresAt: string | null;
  viewCount: number;
  plan: string | null;
  sale: Record<string, unknown>;
  analysis: Record<string, unknown>;
  market: Json;
  environmental: Json | null;
  ceiling: Json;
  sourceTrace: SourceTraceEntry[];
  limitations: string[];
  disclaimer: string;
};

export { buildOpportunityAnalysis } from "./property-report/analysis";

export async function listPropertyReports({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId?: string | null;
}): Promise<PropertyReportListResponse> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, "property.savedReports", "Rapports réservés au plan Analyse.");
  let query = auth.supabase
    .from("saved_property_reports")
    .select("*")
    .eq("user_id", auth.userId)
    .order("updated_at", { ascending: false });

  if (saleId) query = query.eq("sale_id", saleId);

  const { data, error } = await query.limit(50);
  if (error) throw error;

  return {
    reports: (data ?? []).map((report) => attachPlan(report, plan)),
    plan,
  };
}

export async function savePropertyReport({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: PropertyReportRequestPayload;
}): Promise<PropertyReportSaveResponse> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, "property.savedReports", "Rapports réservés au plan Analyse.");
  const existingReportId = await getExistingReportId(
    auth.supabase,
    auth.userId,
    input.saleId,
    input.reportKind,
  );
  if (!existingReportId) await assertReportCreationAvailable(auth, plan);

  const sale = await getSale(auth.supabase, input.saleId);
  const valuationConflict = listingValuationConflict(sale);
  if (valuationConflict) throw new Error(valuationConflict);
  const marketEstimatePromise = buildMarketSnapshot(sale);
  const environmentalContextPromise =
    input.includeEnvironment && featureUnlocked(plan.features.neighborhoodAnalysis)
      ? getEnvironmentalContext({
          address: saleLocation(sale),
          lat: sale.latitude,
          lng: sale.longitude,
        })
      : Promise.resolve(null);
  const activeComparablesPromise = featureUnlocked(plan.features.activeComparables)
    ? getActiveComparableSales(auth.supabase, sale)
    : Promise.resolve(emptyActiveComparableSales());
  const cadastreParcelsPromise = getCadastralParcels(sale.source_url);
  const dpeDiagnosticsPromise = getDpeDiagnostics(sale.source_url);
  const urbanPlanningSignalsPromise = featureUnlocked(plan.features.urbanPlanning)
    ? getUrbanPlanningSignals(sale.source_url)
    : Promise.resolve([]);
  const valuationBacktestPromise = featureUnlocked(plan.features.soldComparables)
    ? getValuationBacktestForReport(sale)
    : Promise.resolve(null);
  const [
    marketEstimate,
    environmentalContext,
    activeComparables,
    cadastreParcels,
    dpeDiagnostics,
    urbanPlanningSignals,
    valuationBacktest,
  ] = await Promise.all([
    marketEstimatePromise,
    environmentalContextPromise,
    activeComparablesPromise,
    cadastreParcelsPromise,
    dpeDiagnosticsPromise,
    urbanPlanningSignalsPromise,
    valuationBacktestPromise,
  ]);
  const ceilingSnapshot = buildCeilingSnapshot(sale, marketEstimate);
  if (input.simulation) {
    const personal = computeReportSimulation(sale, marketEstimate, input.simulation);
    Object.assign(ceilingSnapshot, personal, {
      personalSimulation: input.simulation,
      acquisition: personal.simulated,
      refreshWorksBudget: input.simulation.works,
      maxBidWithoutWorks: null,
      maxBidWithRefreshWorks: null,
    });
  }
  const reportSnapshot = {
    ...buildReportSnapshot({
      sale,
      marketEstimate,
      environmentalContext: environmentalContext?.context ?? null,
      activeComparables,
      cadastreParcels,
      dpeDiagnostics,
      urbanPlanningSignals,
      valuationBacktest,
      ceilingSnapshot,
      plan,
    }),
    sourceFingerprint: reportSourceFingerprint(sale),
  };
  const title = input.title?.trim() || defaultReportTitle(sale);

  const { data, error } = await supabaseAdmin
    .from("saved_property_reports")
    .upsert(
      {
        user_id: auth.userId,
        sale_id: input.saleId,
        report_kind: input.reportKind,
        title,
        user_notes: emptyToNull(input.userNotes),
        report_snapshot: asJson(reportSnapshot),
        market_snapshot: asJson(marketEstimate),
        environmental_snapshot: environmentalContext ? asJson(environmentalContext.context) : null,
        ceiling_snapshot: asJson(ceilingSnapshot),
      },
      { onConflict: "user_id,sale_id,report_kind" },
    )
    .select("*")
    .single();

  if (error) throw error;

  if (!existingReportId) {
    await recordFeatureUsageEvent({
      auth,
      eventKey: "property_report.created",
      subjectType: "saved_property_report",
      subjectId: data.id,
      metadata: {
        sale_id: input.saleId,
        report_kind: input.reportKind,
        plan: plan.plan,
      },
    });
  }

  return {
    report: attachPlan(data, plan),
    plan,
  };
}

export async function updatePropertyReport({
  auth,
  reportId,
  input,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
  input: PropertyReportUpdatePayload;
}): Promise<PropertyReportSaveResponse> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(
    plan,
    "property.reportEditing",
    "Édition des rapports réservée au plan Analyse.",
  );
  const patch: Database["public"]["Tables"]["saved_property_reports"]["Update"] = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.userNotes !== undefined) patch.user_notes = emptyToNull(input.userNotes ?? undefined);

  const { data, error } = await supabaseAdmin
    .from("saved_property_reports")
    .update(patch)
    .eq("id", reportId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;

  return {
    report: attachPlan(data, plan),
    plan,
  };
}

export async function deletePropertyReport({
  auth,
  reportId,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
}): Promise<{ ok: true }> {
  const { error } = await supabaseAdmin
    .from("saved_property_reports")
    .delete()
    .eq("id", reportId)
    .eq("user_id", auth.userId);
  if (error) throw error;
  return { ok: true };
}

export async function exportPropertyReportPdf({
  auth,
  reportId,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
}): Promise<PropertyReportExport> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, "property.pdfExport", "Export PDF réservé au plan Analyse.");
  await assertPdfExportAvailable(auth, plan);
  const report = await getReport(auth.supabase, auth.userId, reportId);
  assertReportSourceCurrent(report.report_snapshot, await getSale(auth.supabase, report.sale_id));
  const lines = reportToPdfLines(report, plan);
  const bytes = createTextPdf({
    title: report.title,
    lines,
    headings: REPORT_PDF_HEADINGS,
    footer:
      "ImmoJudis - rapport indicatif. Vérifiez les pièces officielles et votre conseil avant toute enchère.",
    watermark: pdfWatermarkForPlan(plan),
  });

  await recordPdfExport(auth, report);

  return {
    bytes,
    filename: `${slugify(report.title)}-${report.id.slice(0, 8)}.pdf`,
    contentType: "application/pdf",
  };
}

export async function enablePropertyReportShare({
  auth,
  reportId,
  origin,
  expiresAt,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
  origin?: string | null;
  expiresAt?: string | null;
}): Promise<PropertyReportShareResponse> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, "property.savedReports", "Partage réservé au plan Analyse.");
  const report = await getReport(auth.supabase, auth.userId, reportId);
  assertReportSourceCurrent(report.report_snapshot, await getSale(auth.supabase, report.sale_id));
  const shareToken = createShareToken();
  const shareExpiresAt = normalizeShareExpiresAt(expiresAt);
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("saved_property_reports")
    .update({
      share_enabled: true,
      share_token: shareToken,
      shared_at: now,
      share_expires_at: shareExpiresAt,
    })
    .eq("id", reportId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;

  return {
    report: attachPlan(data, plan),
    plan,
    share: buildPropertyReportShare(data, origin),
  };
}

export async function disablePropertyReportShare({
  auth,
  reportId,
  origin,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
  origin?: string | null;
}): Promise<PropertyReportShareResponse> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, "property.savedReports", "Partage réservé au plan Analyse.");

  const { data, error } = await supabaseAdmin
    .from("saved_property_reports")
    .update({
      share_enabled: false,
      share_token: null,
      share_expires_at: null,
    })
    .eq("id", reportId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;

  return {
    report: attachPlan(data, plan),
    plan,
    share: buildPropertyReportShare(data, origin),
  };
}

export async function getSharedPropertyReport({
  token,
  countView = true,
}: {
  token: string;
  countView?: boolean;
}): Promise<PublicSharedPropertyReport> {
  const normalized = normalizeShareToken(token);
  if (!normalized) throw new Error("Lien de partage invalide.");

  const { data, error } = await supabaseAdmin
    .from("saved_property_reports")
    .select(
      "id,sale_id,title,report_kind,report_snapshot,market_snapshot,environmental_snapshot,ceiling_snapshot,share_enabled,share_token,shared_at,share_expires_at,share_view_count,updated_at",
    )
    .eq("share_token", normalized)
    .eq("share_enabled", true)
    .maybeSingle();

  if (error) throw error;
  if (!data || shareIsExpired(data.share_expires_at)) {
    throw new Error("Rapport partagé introuvable ou expiré.");
  }

  assertReportSourceCurrent(data.report_snapshot, await getSale(supabaseAdmin, data.sale_id));

  if (countView) {
    const nextViewCount = data.share_view_count + 1;
    const { error: updateError } = await supabaseAdmin
      .from("saved_property_reports")
      .update({ share_view_count: nextViewCount })
      .eq("id", data.id);
    if (!updateError) data.share_view_count = nextViewCount;
  }

  return buildPublicSharedPropertyReport(data);
}

export function buildPropertyReportShare(
  report: Pick<
    SavedReportRow,
    "share_enabled" | "share_token" | "shared_at" | "share_expires_at" | "share_view_count"
  >,
  origin?: string | null,
): PropertyReportShare {
  const token = report.share_token;
  const enabled = Boolean(
    report.share_enabled && token && !shareIsExpired(report.share_expires_at),
  );

  return {
    enabled,
    token: enabled ? token : null,
    url: enabled && token && origin ? new URL(`/reports/shared/${token}`, origin).toString() : null,
    sharedAt: report.shared_at,
    expiresAt: report.share_expires_at,
    viewCount: report.share_view_count,
  };
}

export function buildPublicSharedPropertyReport(
  report: Pick<
    SavedReportRow,
    | "id"
    | "title"
    | "report_kind"
    | "report_snapshot"
    | "market_snapshot"
    | "environmental_snapshot"
    | "ceiling_snapshot"
    | "shared_at"
    | "share_expires_at"
    | "share_view_count"
    | "updated_at"
  >,
): PublicSharedPropertyReport {
  const rawSnapshot = asRecord(report.report_snapshot);
  const snapshot = sanitizeReportSnapshotForPlan(
    rawSnapshot,
    buildPlanEntitlements(normalizePlanCode(rawSnapshot.plan)),
  );
  const traceability = asRecord(snapshot.sourceTraceability);

  return {
    id: report.id,
    title: report.title,
    reportKind: report.report_kind,
    updatedAt: report.updated_at,
    sharedAt: report.shared_at,
    expiresAt: report.share_expires_at,
    viewCount: report.share_view_count,
    plan: typeof snapshot.plan === "string" ? snapshot.plan : null,
    sale: asRecord(snapshot.sale),
    analysis: asRecord(snapshot.analysis),
    market: report.market_snapshot,
    environmental: report.environmental_snapshot,
    ceiling: report.ceiling_snapshot,
    sourceTrace: normalizeSourceTrace(traceability.entries),
    limitations: normalizeStringList(traceability.limitations),
    disclaimer: stringValue(traceability.complianceNotice, REPORT_COMPLIANCE_NOTICE),
  };
}

export async function resolvePlanEntitlements(
  auth: SupabaseAuthContext,
): Promise<PlanEntitlements> {
  if (auth.isAdmin) {
    return buildPlanEntitlements("analyse", null, ADMIN_PLAN_LIMITS);
  }
  if (auth.accountTier === "premium") {
    return buildPlanEntitlements("analyse", null);
  }

  const { data, error } = await auth.supabase
    .from("user_subscriptions")
    .select("plan_code,status,current_period_end")
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) throw error;
  const plan =
    data && isPlanPeriodActive(data.status, data.current_period_end)
      ? normalizePlanCode(data.plan_code)
      : "decouverte";
  return buildPlanEntitlements(plan, data?.current_period_end ?? null);
}

export async function assertFeatureEntitlement(
  auth: SupabaseAuthContext,
  feature: FeatureKey,
  message = "Fonctionnalité réservée au plan Analyse.",
): Promise<PlanEntitlements> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, feature, message);
  return plan;
}
