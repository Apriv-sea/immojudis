import { collectSaleDocuments } from "@/lib/sale-documents";
import { randomBytes } from "node:crypto";
import { saleSession, saleWindow } from "@/lib/sale-window";
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
  featureUnlocked,
  gateMarketComparablesAnalysis,
  lockedActiveComparablesAnalysis,
  lockedNeighborhoodAnalysis,
  lockedStreetFacadeAnalysis,
  lockedUrbanPlanningAnalysis,
} from "./entitlements";
import { ActiveComparableSales, PlanEntitlements } from "../property-reports";
import { listingAddress } from "../sale-listing";
import {
  dpeFromSourceBlocks,
  normalizeRisks,
  normalizeScoreFactors,
  opportunityScoreLabel,
  opportunitySummary,
  positiveNumber,
  roundPercent,
  roundedNumber,
} from "./serialization";
export async function buildMarketSnapshot(sale: AuctionSale): Promise<MarketEstimate | null> {
  return getPrecomputedMarketEstimate(sale.id);
}

export function buildCeilingSnapshot(sale: AuctionSale, marketEstimate: MarketEstimate | null) {
  const surface = getMarketValuationSurfaces(sale).builtSurfaceM2;
  const scenario = DEFAULT_MARKET_CEILING_SCENARIO;
  const ceilings = computeRecommendedCeilings({
    surface,
    price: Math.max(0, sale.starting_price_eur ?? 0),
    fpt: DEFAULTS.fpt,
    scenario,
    medianPricePerM2: marketEstimate?.actionable ? marketEstimate.medianPricePerM2 : null,
    p25PricePerM2: marketEstimate?.actionable ? marketEstimate.p25PricePerM2 : null,
    p75PricePerM2: marketEstimate?.actionable ? marketEstimate.p75PricePerM2 : null,
  });
  const ceiling = ceilings.withRefreshWorks;
  const acquisition = computeAcquisitionCosts({
    price: Math.max(0, sale.starting_price_eur ?? 0),
    works: ceilings.refreshWorksBudget,
    fpt: DEFAULTS.fpt,
  });

  return {
    scenario,
    available: ceiling.available,
    reason: ceiling.reason ?? null,
    maxBid: ceiling.available ? ceiling.maxBid : null,
    maxBidWithoutWorks: ceilings.withoutWorks.available ? ceilings.withoutWorks.maxBid : null,
    maxBidWithRefreshWorks: ceilings.withRefreshWorks.available
      ? ceilings.withRefreshWorks.maxBid
      : null,
    refreshWorksBudget: ceilings.refreshWorksBudget,
    targetTotalCost: ceiling.available ? ceiling.targetTotalCost : null,
    marketReferencePricePerM2: ceiling.available ? ceiling.marketReferencePricePerM2 : null,
    safetyDiscountPct: ceiling.available ? ceiling.safetyDiscountPct : null,
    marginTotal: ceiling.available ? ceiling.marginTotal : null,
    marginPerM2: ceiling.available ? ceiling.marginPerM2 : null,
    acquisition,
  };
}

export function buildOpportunityAnalysis({
  sale,
  surfaceM2,
  marketEstimate,
  ceilingSnapshot,
}: {
  sale: AuctionSale;
  surfaceM2: number | null;
  marketEstimate: MarketEstimate | null;
  ceilingSnapshot: ReturnType<typeof buildCeilingSnapshot>;
}) {
  const startingPrice = positiveNumber(sale.starting_price_eur);
  const surface = positiveNumber(surfaceM2);
  const startingPricePerM2 = roundedNumber(pricePerM2(startingPrice, surface));
  const medianPricePerM2 = positiveNumber(marketEstimate?.medianPricePerM2);
  const p25PricePerM2 = positiveNumber(marketEstimate?.p25PricePerM2);
  const p75PricePerM2 = positiveNumber(marketEstimate?.p75PricePerM2);
  const estimatedMarketValue =
    surface && medianPricePerM2 ? Math.round(surface * medianPricePerM2) : null;
  const valuationLow = positiveNumber(marketEstimate?.estimatedValueLowEur);
  const valuationHigh = positiveNumber(marketEstimate?.estimatedValueHighEur);
  const hasValuationRange =
    valuationLow != null && valuationHigh != null && valuationLow <= valuationHigh;
  const estimatedMarketLow = hasValuationRange
    ? valuationLow
    : surface && p25PricePerM2
      ? Math.round(surface * p25PricePerM2)
      : null;
  const estimatedMarketHigh = hasValuationRange
    ? valuationHigh
    : surface && p75PricePerM2
      ? Math.round(surface * p75PricePerM2)
      : null;
  const apparentDiscountPct =
    startingPrice && estimatedMarketValue
      ? roundPercent(((estimatedMarketValue - startingPrice) / estimatedMarketValue) * 100)
      : null;
  const grossYieldPct = roundPercent(
    estimateGrossYieldPct(startingPrice, surface, sale.department),
  );
  // A missing or withdrawn documentary score must remain unavailable.
  const score = roundedNumber(sale.investment_score);
  const scoreConfidence = roundPercent(
    score != null && typeof sale.score_confidence === "number" ? sale.score_confidence * 100 : null,
  );
  const acquisition = ceilingSnapshot.acquisition;
  const totalCostPerM2 = surface ? roundedNumber(acquisition.totalCost / surface) : null;
  const rentabilityScore = computeRentabilityScore({
    surface,
    price: acquisition.price,
    works: acquisition.works,
    fpt: acquisition.fpt,
    department: sale.department,
    marketMarginPerM2: ceilingSnapshot.available ? ceilingSnapshot.marginPerM2 : null,
  });

  return {
    score,
    scoreConfidencePct: scoreConfidence,
    label: opportunityScoreLabel(score),
    summary: opportunitySummary({
      apparentDiscountPct,
      grossYieldPct,
      score,
      ceilingAvailable: ceilingSnapshot.available,
    }),
    startingPricePerM2,
    estimatedMarketValue,
    estimatedMarketLow,
    estimatedMarketHigh,
    estimatedMarketRangeLabel: hasValuationRange
      ? "Fourchette de valeur estimée"
      : "Repère P25-P75 des comparables appliqué à la surface",
    apparentDiscountPct,
    grossYieldPct,
    rentabilityScore,
    acquisitionCosts: {
      price: acquisition.price,
      acquisitionFeesTotal: Math.round(acquisition.acquisitionFeesTotal),
      acquisitionFeesPct: roundPercent(acquisition.acquisitionFeesPct),
      totalCost: Math.round(acquisition.totalCost),
      totalCostPerM2,
      fpt: Math.round(acquisition.fpt),
      works: Math.round(acquisition.works),
    },
    bidCeiling: {
      available: ceilingSnapshot.available,
      maxBid: ceilingSnapshot.available ? ceilingSnapshot.maxBid : null,
      targetTotalCost: ceilingSnapshot.available ? ceilingSnapshot.targetTotalCost : null,
      marginTotal: ceilingSnapshot.available ? ceilingSnapshot.marginTotal : null,
      marginPerM2: ceilingSnapshot.available ? ceilingSnapshot.marginPerM2 : null,
    },
    scoreFactors: normalizeScoreFactors(sale.score_factors).slice(0, 5),
  };
}

export function buildReportSnapshot({
  sale,
  marketEstimate,
  environmentalContext,
  activeComparables,
  cadastreParcels,
  dpeDiagnostics,
  urbanPlanningSignals,
  valuationBacktest,
  ceilingSnapshot,
  plan,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  environmentalContext?: EnvironmentalContext | null;
  activeComparables: ActiveComparableSales;
  cadastreParcels: StructuredCadastralParcel[];
  dpeDiagnostics: StructuredDpeDiagnostic[];
  urbanPlanningSignals: StructuredUrbanPlanningSignal[];
  valuationBacktest: ValuationBacktestResult | null;
  ceilingSnapshot: ReturnType<typeof buildCeilingSnapshot>;
  plan: PlanEntitlements;
}) {
  const generatedAt = new Date().toISOString();
  const surface = getSaleSurface(sale);
  const risks = normalizeRisks(sale.risks).slice(0, 8);
  const documents = collectSaleDocuments(sale);
  sale = { ...sale, documents_rich: documents };
  const marketComparablesAnalysis = gateMarketComparablesAnalysis(
    buildMarketComparablesAnalysis(marketEstimate),
    plan,
  );
  const valuationAudit = buildValuationAudit({
    sale,
    surfaceM2: surface.value,
    marketEstimate,
  });
  const sourceTraceability = buildReportTraceability({
    sale,
    marketEstimate,
    cadastreParcels,
    dpeDiagnostics,
    urbanPlanningSignals,
    environmentalContext,
    generatedAt,
  });
  const dpeClass = dpeFromSourceBlocks(sale.source_blocks);
  const dpeAnalysis = buildDpeAnalysis(sale, dpeDiagnostics);
  const cadastralAnalysis = buildCadastralAnalysis(sale, cadastreParcels);
  const nearbyServices = buildNearbyServicesAnalysis(sale);
  const demographicAnalysis = buildDemographicAnalysis({
    sale,
    marketEstimate,
    nearbyServices,
  });
  const occupancyAnalysis = buildOccupancyAnalysis(sale);
  const renovationAnalysis = buildRenovationAnalysis({ sale, surfaceM2: surface.value });
  const streetFacadeAnalysis = featureUnlocked(plan.features.streetFacade)
    ? buildStreetFacadeAnalysis(sale)
    : lockedStreetFacadeAnalysis();
  const neighborhoodAnalysis = featureUnlocked(plan.features.neighborhoodAnalysis)
    ? buildNeighborhoodAnalysis({
        sale,
        marketEstimate,
        nearbyServices,
        streetFacade: streetFacadeAnalysis,
        environmentalContext,
      })
    : lockedNeighborhoodAnalysis();
  const activeComparablesAnalysis = featureUnlocked(plan.features.activeComparables)
    ? buildActiveComparablesAnalysis({
        sale,
        candidates: activeComparables.sales,
        scopeLabel: activeComparables.scopeLabel,
      })
    : lockedActiveComparablesAnalysis();
  const auctionCostAnalysis = buildAuctionCostAnalysis({
    sale,
    acquisition: ceilingSnapshot.acquisition,
  });
  const urbanPlanningAnalysis = featureUnlocked(plan.features.urbanPlanning)
    ? buildUrbanPlanningAnalysis({
        sale,
        documents,
        risks: sale.risks ?? [],
        structuredSignals: urbanPlanningSignals,
      })
    : lockedUrbanPlanningAnalysis();
  const hasDiagnostics =
    Boolean(dpeClass) ||
    documents.some((doc) =>
      /diagnostic|dpe|amiante|plomb|termite/i.test(`${doc.type} ${doc.label}`),
    );
  const legalAttentionAnalysis = buildLegalAttentionAnalysis({
    sale,
    documents,
    risks: sale.risks ?? [],
    cadastralAnalysis,
    occupancyAnalysis,
    auctionCostAnalysis,
    hasDiagnostics,
  });
  const audienceReadinessAnalysis = buildAudienceReadinessAnalysis({
    sale,
    documents,
    auctionCostAnalysis,
    occupancyAnalysis,
    renovationAnalysis,
    legalAttentionAnalysis,
    bidCeilingAvailable: ceilingSnapshot.available,
    now: new Date(generatedAt),
  });

  return {
    generatedAt,
    plan: plan.plan,
    sourceTraceability,
    sale: {
      id: sale.id,
      title: cleanSaleTitle(sale.title),
      city: sale.city,
      department: sale.department,
      address: sale.address,
      displayAddress: listingAddress(sale),
      propertyType: propertyTypeLabel(sale.property_type),
      startingPrice: sale.starting_price_eur,
      saleDate: sale.sale_date,
      saleWindow: saleWindow(sale),
      saleSession: saleSession(sale),
      tribunal: sale.tribunal ?? sale.tribunal_name,
      surface: surface.value,
      surfaceLabel: surface.label,
      occupancy: occupancyAnalysis.label,
    },
    analysis: {
      valueEstimate: marketEstimate?.medianPricePerM2
        ? {
            medianPricePerM2: marketEstimate.medianPricePerM2,
            p25PricePerM2: marketEstimate.p25PricePerM2,
            p75PricePerM2: marketEstimate.p75PricePerM2,
            sampleSize: marketEstimate.sampleSize,
            qualityLabel: marketEstimate.qualityLabel,
            radiusM: marketEstimate.radiusM,
          }
        : null,
      marketComparablesAnalysis,
      valuationAudit,
      valuationBacktest: featureUnlocked(plan.features.soldComparables) ? valuationBacktest : null,
      cadastralAnalysis,
      dpe: {
        ...dpeAnalysis,
        available: dpeAnalysis.available || hasDiagnostics,
        class: dpeAnalysis.class ?? dpeClass,
      },
      auctionCostAnalysis,
      demographicAnalysis,
      occupancyAnalysis,
      renovationAnalysis,
      urbanPlanningAnalysis,
      streetFacadeAnalysis,
      neighborhoodAnalysis,
      activeComparablesAnalysis,
      audienceReadinessAnalysis,
      nearbyServices,
      legalAttentionAnalysis,
      opportunity: buildOpportunityAnalysis({
        sale,
        surfaceM2: surface.value,
        marketEstimate,
        ceilingSnapshot,
      }),
      legalAttentionPoints: legalAttentionAnalysis.items
        .map((item) => `${item.label} : ${item.action}`)
        .slice(0, 8),
      risks,
      documentsCount: documents.length,
      sourceName: sale.source_name,
    },
    gatedFeatures: plan.features,
  };
}
