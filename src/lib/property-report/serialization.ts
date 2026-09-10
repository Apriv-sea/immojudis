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
import { buildCeilingSnapshot } from "./analysis";
import {
  AppSaleRow,
  PlanEntitlements,
  SavedPropertyReport,
  SavedReportRow,
} from "../property-reports";
export function pdfWatermarkForPlan(plan: PlanEntitlements): string | null {
  return plan.features.pdfExport === "limited" ? "VERSION DECOUVERTE - EXTRAIT LIMITE" : null;
}

export function attachPlan(report: SavedReportRow, plan: PlanEntitlements): SavedPropertyReport {
  return { ...report, plan };
}

export function appSaleRowToAuctionSale(row: AppSaleRow): AuctionSale {
  return {
    ...(row as unknown as AuctionSale),
    id: row.id ?? "",
    documents_rich: Array.isArray(row.documents_rich)
      ? (row.documents_rich as unknown as SaleDocumentRich[])
      : null,
    media: Array.isArray(row.media) ? (row.media as unknown as SaleMedia[]) : null,
    risks: Array.isArray(row.risks) ? (row.risks as SaleRisk[]) : null,
    score_factors: Array.isArray(row.score_factors)
      ? (row.score_factors as unknown as SaleScoreFactor[])
      : null,
    source_blocks:
      row.source_blocks && typeof row.source_blocks === "object"
        ? (row.source_blocks as Record<string, unknown>)
        : null,
    source_blocks_by_source:
      row.source_blocks_by_source && typeof row.source_blocks_by_source === "object"
        ? (row.source_blocks_by_source as Record<string, Record<string, unknown>>)
        : null,
  };
}

export function normalizeRisks(risks: AuctionSale["risks"]) {
  if (!Array.isArray(risks)) return [];
  return risks.map((risk) => ({
    type: risk.risk_type,
    label: risk.risk_label,
    severity: risk.severity,
    evidence: risk.evidence,
    confidence: risk.confidence ?? null,
  }));
}

export function normalizeScoreFactors(factors: AuctionSale["score_factors"]) {
  if (!Array.isArray(factors)) return [];
  return factors
    .map((factor) => ({
      key: factor.factor_key,
      label: factor.label,
      reason: factor.reason,
      delta: factor.delta,
      confidencePct:
        typeof factor.confidence === "number" ? roundPercent(factor.confidence * 100) : null,
      evidence: factor.evidence ?? null,
    }))
    .filter((factor) => factor.label || factor.reason || factor.delta != null);
}

export function deriveOpportunityScore({
  apparentDiscountPct,
  grossYieldPct,
  ceilingSnapshot,
}: {
  apparentDiscountPct: number | null;
  grossYieldPct: number | null;
  ceilingSnapshot: ReturnType<typeof buildCeilingSnapshot>;
}): number | null {
  if (apparentDiscountPct == null && grossYieldPct == null && !ceilingSnapshot.available) {
    return null;
  }

  let score = 50;
  if (apparentDiscountPct != null) {
    if (apparentDiscountPct >= 35) score += 24;
    else if (apparentDiscountPct >= 25) score += 18;
    else if (apparentDiscountPct >= 15) score += 11;
    else if (apparentDiscountPct < 0) score -= 12;
  }
  if (grossYieldPct != null) {
    if (grossYieldPct >= 9) score += 12;
    else if (grossYieldPct >= 6.5) score += 8;
    else if (grossYieldPct < 3) score -= 8;
  }
  if (ceilingSnapshot.available) {
    if ((ceilingSnapshot.marginTotal ?? 0) > 0) score += 7;
    if ((ceilingSnapshot.marginTotal ?? 0) < 0) score -= 10;
  } else {
    score -= 6;
  }

  return clampScore(Math.round(score));
}

export function opportunityScoreLabel(score: number | null): string {
  if (score == null) return "À compléter";
  if (score >= 80) return "Très favorable";
  if (score >= 65) return "À étudier en priorité";
  if (score >= 50) return "À analyser";
  return "Prudence renforcée";
}

export function opportunitySummary({
  apparentDiscountPct,
  grossYieldPct,
  score,
  ceilingAvailable,
}: {
  apparentDiscountPct: number | null;
  grossYieldPct: number | null;
  score: number | null;
  ceilingAvailable: boolean;
}): string {
  const parts: string[] = [];
  if (score != null) parts.push(`score ${score}/100`);
  if (apparentDiscountPct != null)
    parts.push(`décote apparente ${formatPercent(apparentDiscountPct)}`);
  if (grossYieldPct != null) parts.push(`rendement brut estimé ${formatPercent(grossYieldPct)}`);
  if (!ceilingAvailable) parts.push("plafond à compléter");
  return parts.length ? parts.join(" · ") : "Données à compléter avant décision.";
}

export function dpeFromSourceBlocks(blocks: AuctionSale["source_blocks"]): string | null {
  if (!blocks || typeof blocks !== "object") return null;
  const value = blocks.dpe_classe ?? blocks.dpe ?? blocks.diagnostic_dpe;
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

export function defaultReportTitle(sale: AuctionSale): string {
  const place = [sale.city, sale.department].filter(Boolean).join(" ");
  return `Rapport ${propertyTypeLabel(sale.property_type)}${place ? ` - ${place}` : ""}`;
}

export function saleLocation(sale: AuctionSale): string | null {
  const value = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
  return value || null;
}

export function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeSourceTrace(value: unknown): SourceTraceEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = asRecord(entry);
      const id = stringValue(record.id, "");
      const kind = stringValue(record.kind, "judicial_listing");
      const label = stringValue(record.label, "");
      const sourceName = stringValue(record.sourceName, "Source");
      const url = stringValue(record.url, "");
      const capturedAt = stringValue(record.capturedAt, "");
      const confidenceLabel = stringValue(record.confidenceLabel, "A confirmer");
      const detail = stringValue(record.detail, "");
      const limitation = stringValue(record.limitation, "");

      if (!label && !sourceName && !url) return null;

      return {
        id: id || `${kind}-${label || sourceName}`,
        kind: kind as SourceTraceEntry["kind"],
        label: label || "Source",
        sourceName,
        url: url || null,
        capturedAt: capturedAt || null,
        confidenceLabel,
        detail,
        limitation,
      };
    })
    .filter((entry): entry is SourceTraceEntry => Boolean(entry));
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 12);
}

export function normalizeCadastralReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const section = stringValue(record.section, "");
      const number = stringValue(record.number, "");
      const raw = stringValue(record.raw, "");
      const prefix = stringValue(record.prefix, "");
      if (section && number) return `Section ${prefix ? `${prefix} ` : ""}${section} n° ${number}`;
      return raw;
    })
    .filter(Boolean)
    .slice(0, 8);
}

export function normalizeNearbyCategoryLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = stringValue(record.status, "");
      if (status !== "mentioned") return "";
      return stringValue(record.label, "");
    })
    .filter(Boolean)
    .slice(0, 8);
}

export function normalizeOccupancyEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const excerpt = stringValue(record.excerpt, "");
      return [label, source, excerpt].filter(Boolean).join(" | ");
    })
    .filter(Boolean)
    .slice(0, 8);
}

export function normalizeDpeEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const excerpt = stringValue(record.excerpt, "");
      return [label, source, excerpt].filter(Boolean).join(" | ");
    })
    .filter(Boolean)
    .slice(0, 8);
}

export function normalizeRenovationEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const excerpt = stringValue(record.excerpt, "");
      return [label, source, excerpt].filter(Boolean).join(" | ");
    })
    .filter(Boolean)
    .slice(0, 8);
}

export function normalizeNeighborhoodSignals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const status = stringValue(record.status, "");
      const source = stringValue(record.source, "");
      const detail = stringValue(record.detail, "");
      return [label, status ? reportStatusLabel(status) : null, source, detail]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

export function normalizeDemographicSignals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = stringValue(record.status, "");
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const detail = stringValue(record.detail, "");
      const impact = stringValue(record.impact, "");
      return [status ? reportStatusLabel(status) : null, label, source, detail, impact]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

export function normalizeLegalAttentionItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const priority = stringValue(record.priority, "");
      const label = stringValue(record.label, "");
      const reason = stringValue(record.reason, "");
      const action = stringValue(record.action, "");
      return [
        priority ? reportPriorityLabel(priority) : null,
        label,
        reason,
        action ? `Action: ${action}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

export function normalizeUrbanPlanningItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const priority = stringValue(record.priority, "");
      const status = stringValue(record.status, "");
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const detail = stringValue(record.detail, "");
      const action = stringValue(record.action, "");
      return [
        priority ? reportPriorityLabel(priority) : null,
        status ? reportStatusLabel(status) : null,
        label,
        source,
        detail,
        action ? `Action: ${action}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

export function normalizeMarketComparableRows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const date = stringValue(record.date, "");
      const type = stringValue(record.type, "Bien");
      const totalPrice = numberValue(record.totalPriceEur);
      const pricePerM2 = numberValue(record.pricePerM2);
      const surface = numberValue(record.surfaceM2);
      const distance = numberValue(record.distanceM);
      return [
        date ? formatDate(date) : null,
        type,
        totalPrice != null ? formatPrice(totalPrice) : null,
        pricePerM2 != null ? formatPricePerM2(pricePerM2) : null,
        surface != null ? `${Math.round(surface)} m²` : null,
        distance != null ? `${Math.round(distance)} m` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

export function normalizeValuationCheckpoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = stringValue(record.status, "");
      const label = stringValue(record.label, "");
      const detail = stringValue(record.detail, "");
      const action = stringValue(record.action, "");
      return [
        status ? reportStatusLabel(status) : null,
        label,
        detail,
        action ? `Action: ${action}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

export function normalizeActiveComparableItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const title = stringValue(record.title, "Bien actif");
      const city = stringValue(record.city, "");
      const saleDate = stringValue(record.saleDate, "");
      const startingPrice = numberValue(record.startingPriceEur);
      const pricePerM2 = numberValue(record.pricePerM2);
      const surface = numberValue(record.surfaceM2);
      const matchLabel = stringValue(record.matchLabel, "");
      const matchScore = numberValue(record.matchScore);
      return [
        matchLabel && matchScore != null ? `${matchLabel} (${matchScore}/100)` : matchLabel,
        title,
        city,
        saleDate ? formatDate(saleDate) : null,
        startingPrice != null ? formatPrice(startingPrice) : null,
        pricePerM2 != null ? formatPricePerM2(pricePerM2) : null,
        surface != null ? `${Math.round(surface)} m²` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

export function normalizeAudienceChecklistItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const statuses: Record<string, string> = {
    done: "Repéré",
    watch: "À vérifier",
    to_do: "À compléter",
  };
  const priorities: Record<string, string> = { high: "haute", medium: "moyenne", low: "basse" };
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const status = stringValue(record.status, "");
      const priority = stringValue(record.priority, "");
      const detail = stringValue(record.detail, "");
      const action = stringValue(record.action, "");
      return [
        status ? (statuses[status] ?? "À vérifier") : null,
        priority ? `Priorité ${priorities[priority] ?? "à confirmer"}` : null,
        label,
        detail,
        action ? `Action: ${action}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 12);
}

export function stringValue(value: unknown, fallback: string | null): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback ?? "";
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function roundedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

export function roundPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPercent(value: unknown): string {
  const number = numberValue(value);
  if (number == null) return "—";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(number)} %`;
}

export function formatRenovationBudgetRange(range: Record<string, unknown>): string {
  const lowEur = numberValue(range.lowEur);
  const highEur = numberValue(range.highEur);
  if (lowEur != null && highEur != null) {
    return `${formatPrice(lowEur)} - ${formatPrice(highEur)}`;
  }
  const lowPerM2 = numberValue(range.lowPerM2);
  const highPerM2 = numberValue(range.highPerM2);
  if (lowPerM2 != null && highPerM2 != null) {
    return `${formatPricePerM2(lowPerM2)} - ${formatPricePerM2(highPerM2)}`;
  }
  return "";
}

export function slugify(value: string): string {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "rapport-immojudis"
  );
}

export function createShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export function normalizeShareToken(value: string): string | null {
  const token = value.trim();
  return /^[A-Za-z0-9_-]{24,120}$/.test(token) ? token : null;
}

export function normalizeShareExpiresAt(value: string | null | undefined): string | null {
  const now = new Date();
  const date = value ? new Date(value) : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
  if (!Number.isFinite(date.getTime())) throw new Error("Date d'expiration invalide.");
  if (date <= now) throw new Error("La date d'expiration doit être future.");
  if (date.getTime() > now.getTime() + 90 * 24 * 60 * 60 * 1_000) {
    throw new Error("La durée maximale d'un partage est de 90 jours.");
  }
  return date.toISOString();
}

export function shareIsExpired(value: string | null): boolean {
  return Boolean(value && new Date(value).getTime() <= Date.now());
}

function reportStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    done: "Repéré",
    watch: "À vérifier",
    to_do: "À compléter",
    positive: "Favorable",
    to_enrich: "À compléter",
    source_signal: "Mention dans la source",
    proxy: "Indice indirect",
    documented: "Documenté",
    to_verify: "À vérifier",
    missing: "Non renseigné",
    pass: "Vérifié",
    fail: "Point à résoudre",
  };
  return labels[status] ?? "À vérifier";
}

function reportPriorityLabel(priority: string): string {
  const labels: Record<string, string> = { high: "haute", medium: "moyenne", low: "basse" };
  return `Priorité ${labels[priority] ?? "à confirmer"}`;
}
