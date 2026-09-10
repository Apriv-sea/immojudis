import { isActiveComparableSale } from "@/lib/sale-window";
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
  ActiveComparableSales,
  AppSaleRow,
  CadastreParcelRow,
  DpeDiagnosticRow,
  SavedReportRow,
  SupabaseClient,
  UrbanPlanningSignalRow,
} from "../property-reports";
import { appSaleRowToAuctionSale } from "./serialization";
export async function getSale(supabase: SupabaseClient, saleId: string): Promise<AuctionSale> {
  const { data, error } = await supabase
    .from("v_auction_sales_app")
    .select("*")
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) throw new Error("Vente introuvable ou inaccessible.");

  return appSaleRowToAuctionSale(data);
}

export type ActiveComparableScope = {
  label: string;
  city?: string | null;
  department?: string | null;
  tribunalCode?: string | null;
  propertyType?: string | null;
};

export async function getActiveComparableSales(
  supabase: SupabaseClient,
  sale: AuctionSale,
): Promise<ActiveComparableSales> {
  const scopes = buildActiveComparableScopes(sale);
  const byId = new Map<string, AuctionSale>();
  const usedLabels: string[] = [];
  const nowIso = new Date().toISOString();

  for (const scope of scopes) {
    const rows = await queryActiveComparableSales({
      supabase,
      sale,
      scope,
      nowIso,
      limit: 8,
    });
    if (rows.length) usedLabels.push(scope.label);
    for (const row of rows) {
      const comparable = appSaleRowToAuctionSale(row);
      if (comparable.id && comparable.id !== sale.id && !byId.has(comparable.id)) {
        byId.set(comparable.id, comparable);
      }
    }
    if (byId.size >= 8) break;
  }

  return {
    scopeLabel: usedLabels.length
      ? usedLabels.length === 1
        ? usedLabels[0]
        : `Périmètre élargi : ${usedLabels.slice(0, 3).join(" · ")}`
      : "Aucun périmètre actif trouvé",
    sales: [...byId.values()].slice(0, 12),
  };
}

export async function getCadastralParcels(
  sourceUrl: string | null | undefined,
): Promise<StructuredCadastralParcel[]> {
  if (!sourceUrl) return [];

  const { data, error } = await supabaseAdmin
    .from("auction_cadastre_parcels")
    .select("*")
    .eq("source_url", sourceUrl)
    .order("confidence", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(8);

  if (error) {
    console.warn("Unable to load cadastral parcels for report", {
      sourceUrl,
      message: error.message,
    });
    return [];
  }

  return (data ?? []).map(cadastreParcelRowToAnalysis);
}

export function cadastreParcelRowToAnalysis(row: CadastreParcelRow): StructuredCadastralParcel {
  return {
    parcelKey: row.parcel_key ?? null,
    parcelId: row.parcel_id ?? null,
    codeInsee: row.code_insee ?? null,
    department: row.department ?? null,
    city: row.city ?? null,
    section: row.section ?? null,
    parcelNumber: row.parcel_number ?? null,
    surfaceM2: row.surface_m2 ?? null,
    centroidLat: row.centroid_lat ?? null,
    centroidLng: row.centroid_lng ?? null,
    matchKind: row.match_kind ?? null,
    confidence: row.confidence ?? null,
    sourceApi: row.source_api ?? null,
  };
}

export async function getDpeDiagnostics(
  sourceUrl: string | null | undefined,
): Promise<StructuredDpeDiagnostic[]> {
  if (!sourceUrl) return [];

  const { data, error } = await supabaseAdmin
    .from("auction_dpe_diagnostics")
    .select("*")
    .eq("source_url", sourceUrl)
    .order("confidence", { ascending: false })
    .order("established_at", { ascending: false, nullsFirst: false })
    .limit(8);

  if (error) {
    console.warn("Unable to load DPE diagnostics for report", {
      sourceUrl,
      message: error.message,
    });
    return [];
  }

  return (data ?? []).map(dpeDiagnosticRowToAnalysis);
}

export function dpeDiagnosticRowToAnalysis(row: DpeDiagnosticRow): StructuredDpeDiagnostic {
  return {
    diagnosticNumber: row.diagnostic_number ?? null,
    dpeClass: normalizeDpeClass(row.dpe_class),
    gesClass: normalizeDpeClass(row.ges_class),
    establishedAt: row.established_at ?? null,
    validUntil: row.valid_until ?? null,
    propertyType: row.property_type ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    postalCode: row.postal_code ?? null,
    inseeCode: row.insee_code ?? null,
    department: row.department ?? null,
    surfaceM2: row.surface_m2 ?? null,
    energyConsumptionKwhM2Year: row.energy_consumption_kwh_m2_year ?? null,
    emissionsKgCo2M2Year: row.emissions_kg_co2_m2_year ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    matchKind: row.match_kind ?? null,
    confidence: row.confidence ?? null,
    sourceApi: row.source_api ?? null,
  };
}

export async function getUrbanPlanningSignals(
  sourceUrl: string | null | undefined,
): Promise<StructuredUrbanPlanningSignal[]> {
  if (!sourceUrl) return [];

  const { data, error } = await supabaseAdmin
    .from("auction_urban_planning_signals")
    .select("*")
    .eq("source_url", sourceUrl)
    .order("confidence", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(16);

  if (error) {
    console.warn("Unable to load urban planning signals for report", {
      sourceUrl,
      message: error.message,
    });
    return [];
  }

  return (data ?? []).map(urbanPlanningSignalRowToAnalysis);
}

export function urbanPlanningSignalRowToAnalysis(
  row: UrbanPlanningSignalRow,
): StructuredUrbanPlanningSignal {
  return {
    signalKey: row.signal_key,
    signalKind: normalizeUrbanPlanningSignalKind(row.signal_kind),
    label: row.label ?? null,
    status: row.status === "documented" ? "documented" : "to_verify",
    priority: normalizeUrbanPlanningPriority(row.priority),
    sourceName: row.source_name ?? null,
    sourceKind: row.source_kind ?? null,
    documentUrl: row.document_url ?? null,
    documentLabel: row.document_label ?? null,
    documentType: row.document_type ?? null,
    pageNumber: row.page_number ?? null,
    excerpt: row.excerpt ?? null,
    action: row.action ?? null,
    confidence: row.confidence ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export function normalizeUrbanPlanningSignalKind(
  value: string,
): StructuredUrbanPlanningSignal["signalKind"] {
  if (
    value === "zoning" ||
    value === "permit" ||
    value === "servitude" ||
    value === "coownership" ||
    value === "usage" ||
    value === "public_record"
  ) {
    return value;
  }
  return "public_record";
}

export function normalizeUrbanPlanningPriority(
  value: string,
): StructuredUrbanPlanningSignal["priority"] {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "medium";
}

export async function getValuationBacktestForReport(
  sale: AuctionSale,
): Promise<ValuationBacktestResult | null> {
  try {
    return await buildValuationBacktestForSale({
      sale: {
        department: sale.department ?? null,
        propertyType: sale.property_type ?? null,
        surfaceM2: getSaleSurface(sale).value,
        latitude: sale.latitude ?? null,
        longitude: sale.longitude ?? null,
      },
    });
  } catch (error) {
    console.warn("Unable to build valuation backtest for report", {
      sourceUrl: sale.source_url,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function buildActiveComparableScopes(sale: AuctionSale): ActiveComparableScope[] {
  const scopes: ActiveComparableScope[] = [];
  if (sale.city && sale.department) {
    scopes.push({
      label: "Même ville et même type de bien",
      city: sale.city,
      department: sale.department,
      propertyType: sale.property_type,
    });
  }
  if (sale.tribunal_code) {
    scopes.push({
      label: "Même tribunal et même type de bien",
      tribunalCode: sale.tribunal_code,
      propertyType: sale.property_type,
    });
  }
  if (sale.department) {
    scopes.push({
      label: "Même département et même type de bien",
      department: sale.department,
      propertyType: sale.property_type,
    });
    scopes.push({
      label: "Même département",
      department: sale.department,
    });
  }
  if (sale.city) {
    scopes.push({
      label: "Même ville",
      city: sale.city,
    });
  }
  if (sale.property_type) {
    scopes.push({
      label: "Même type de bien",
      propertyType: sale.property_type,
    });
  }
  return uniqueActiveComparableScopes(scopes);
}

export async function queryActiveComparableSales({
  supabase,
  sale,
  scope,
  nowIso,
  limit,
}: {
  supabase: SupabaseClient;
  sale: AuctionSale;
  scope: ActiveComparableScope;
  nowIso: string;
  limit: number;
}): Promise<AppSaleRow[]> {
  let query = supabase
    .from("v_auction_sales_app")
    .select("*")
    .not("id", "is", null)
    .or(
      `sale_date.gte.${nowIso.slice(0, 10)},sale_procedure->sale_window.not.is.null,sale_procedure->sale_session.not.is.null`,
    )
    .order("sale_date", { ascending: true })
    .order("id", { ascending: true });

  if (sale.id) query = query.neq("id", sale.id);
  if (scope.city) query = query.eq("city", scope.city);
  if (scope.department) query = query.eq("department", scope.department);
  if (scope.tribunalCode) query = query.eq("tribunal_code", scope.tribunalCode);
  if (scope.propertyType) query = query.eq("property_type", scope.propertyType);

  const matches: AppSaleRow[] = [];
  const batchSize = 64;
  const now = new Date(nowIso);
  for (let offset = 0; matches.length < limit; offset += batchSize) {
    const { data, error } = await query.range(offset, offset + batchSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as AppSaleRow[];
    matches.push(
      ...rows.filter((row) => isActiveComparableSale(appSaleRowToAuctionSale(row), now)),
    );
    if (rows.length < batchSize) break;
  }
  return matches.slice(0, limit);
}

export function uniqueActiveComparableScopes(
  scopes: ActiveComparableScope[],
): ActiveComparableScope[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = [scope.city, scope.department, scope.tribunalCode, scope.propertyType]
      .map((value) => value ?? "")
      .join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getReport(
  supabase: SupabaseClient,
  userId: string,
  reportId: string,
): Promise<SavedReportRow> {
  const { data, error } = await supabase
    .from("saved_property_reports")
    .select("*")
    .eq("id", reportId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Rapport introuvable.");
  return data;
}

export async function getExistingReportId(
  supabase: SupabaseClient,
  userId: string,
  saleId: string,
  reportKind: SavedReportRow["report_kind"],
): Promise<string | null> {
  const { data, error } = await supabase
    .from("saved_property_reports")
    .select("id")
    .eq("user_id", userId)
    .eq("sale_id", saleId)
    .eq("report_kind", reportKind)
    .maybeSingle();

  if (error) throw error;
  return data?.id ?? null;
}

export async function recordPdfExport(auth: SupabaseAuthContext, report: SavedReportRow) {
  const now = new Date().toISOString();
  const { error: insertError } = await supabaseAdmin.from("property_report_exports").insert({
    report_id: report.id,
    user_id: auth.userId,
    export_format: "pdf",
  });
  if (insertError) throw insertError;

  const { error: updateError } = await supabaseAdmin
    .from("saved_property_reports")
    .update({
      export_count: report.export_count + 1,
      last_exported_at: now,
    })
    .eq("id", report.id)
    .eq("user_id", auth.userId);
  if (updateError) throw updateError;

  await recordFeatureUsageEvent({
    auth,
    eventKey: "property_report.pdf_exported",
    subjectType: "saved_property_report",
    subjectId: report.id,
    metadata: {
      export_format: "pdf",
      sale_id: report.sale_id,
    },
  });
}
