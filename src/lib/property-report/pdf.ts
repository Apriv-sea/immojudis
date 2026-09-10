import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { buildActiveComparablesAnalysis } from "@/lib/active-comparables-analysis";
import { buildAudienceReadinessAnalysis } from "@/lib/audience-readiness-analysis";
import { reportSaleSchedule } from "@/lib/report-sale-schedule";
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
import { featureUnlocked, sanitizeReportSnapshotForPlan } from "./entitlements";
import { PlanEntitlements, SavedReportRow } from "../property-reports";
import {
  asRecord,
  formatPercent,
  formatRenovationBudgetRange,
  normalizeActiveComparableItems,
  normalizeAudienceChecklistItems,
  normalizeCadastralReferences,
  normalizeDemographicSignals,
  normalizeDpeEvidence,
  normalizeLegalAttentionItems,
  normalizeMarketComparableRows,
  normalizeNearbyCategoryLabels,
  normalizeNeighborhoodSignals,
  normalizeOccupancyEvidence,
  normalizeRenovationEvidence,
  normalizeSourceTrace,
  normalizeStringList,
  normalizeUrbanPlanningItems,
  normalizeValuationCheckpoints,
  numberValue,
  stringValue,
} from "./serialization";
export const REPORT_PDF_HEADINGS = [
  "Bien",
  "Estimation marché",
  "Transactions DVF retenues",
  "Biens comparables en vente",
  "Historique adresse",
  "Actions comparables",
  "Audit de valorisation",
  "Points estimation à risque",
  "Actions audit estimation",
  "Actions backtest estimation",
  "Lecture opportunité",
  "Plafond d'enchère",
  "Préparation audience",
  "Actions préparation audience",
  "Analyse de bien",
  "Indices occupation",
  "Actions occupation",
  "Signaux frais",
  "Actions frais",
  "Indices DPE / diagnostics",
  "Actions DPE",
  "Indices travaux / état",
  "Actions travaux",
  "Signaux urbanisme/permis",
  "Contrôles urbanisme manquants",
  "Actions urbanisme/permis",
  "Actions façade/rue",
  "Limites façade/rue",
  "Signaux quartier",
  "Actions quartier",
  "Actions comparables actifs",
  "Revue juridique",
  "Actions juridiques",
  "Actions cadastre",
  "Actions proximité",
  "Signaux démographiques",
  "Données démographiques manquantes",
  "Actions démographie",
  "Sources et traçabilité",
  "Limites",
  "Points d'attention",
  "Notes",
  "Avertissement",
] as const;

export function reportToPdfLines(report: SavedReportRow, plan: PlanEntitlements): string[] {
  const snapshot = sanitizeReportSnapshotForPlan(asRecord(report.report_snapshot), plan);
  const traceability = asRecord(snapshot.sourceTraceability);
  const sourceTrace = normalizeSourceTrace(traceability.entries);
  const limitations = normalizeStringList(traceability.limitations);
  const complianceNotice = stringValue(traceability.complianceNotice, REPORT_COMPLIANCE_NOTICE);
  const market = asRecord(report.market_snapshot);
  const ceiling = asRecord(report.ceiling_snapshot);
  const sale = asRecord(snapshot.sale);
  const analysis = asRecord(snapshot.analysis);
  const valueEstimate = asRecord(analysis.valueEstimate);
  const marketComparables = asRecord(analysis.marketComparablesAnalysis);
  const retainedComparables = normalizeMarketComparableRows(marketComparables.retainedComparables);
  const addressHistory = normalizeMarketComparableRows(marketComparables.addressHistory);
  const marketComparablesActions = normalizeStringList(marketComparables.nextActions);
  const valuationAudit = asRecord(analysis.valuationAudit);
  const valuationBacktest = asRecord(analysis.valuationBacktest);
  const valuationBacktestSummary = asRecord(valuationBacktest.summary);
  const valuationBacktestActions = normalizeStringList(valuationBacktest.nextActions);
  const valuationCheckpoints = normalizeValuationCheckpoints(valuationAudit.checkpoints);
  const valuationActions = normalizeStringList(valuationAudit.nextActions);
  const valuationRiskFlags = normalizeStringList(valuationAudit.riskFlags);
  const opportunity = asRecord(analysis.opportunity);
  const rentabilityScore = asRecord(opportunity.rentabilityScore);
  const acquisitionCosts = asRecord(opportunity.acquisitionCosts);
  const legalAttentionPoints = Array.isArray(analysis.legalAttentionPoints)
    ? analysis.legalAttentionPoints
    : [];
  const cadastral = asRecord(analysis.cadastralAnalysis);
  const cadastralReferences = normalizeCadastralReferences(cadastral.références);
  const cadastralNextActions = normalizeStringList(cadastral.nextActions);
  const nearbyServices = asRecord(analysis.nearbyServices);
  const nearbyCategories = normalizeNearbyCategoryLabels(nearbyServices.categories);
  const nearbyNextActions = normalizeStringList(nearbyServices.nextActions);
  const demographicAnalysis = asRecord(analysis.demographicAnalysis);
  const demographicSignals = normalizeDemographicSignals(demographicAnalysis.signals);
  const demographicActions = normalizeStringList(demographicAnalysis.nextActions);
  const demographicMissingData = normalizeStringList(demographicAnalysis.missingData);
  const occupancyAnalysis = asRecord(analysis.occupancyAnalysis);
  const occupancyEvidence = normalizeOccupancyEvidence(occupancyAnalysis.evidence);
  const occupancyNextActions = normalizeStringList(occupancyAnalysis.nextActions);
  const auctionCostAnalysis = asRecord(analysis.auctionCostAnalysis);
  const auctionCostSignals = normalizeStringList(auctionCostAnalysis.sourceFeeSignals);
  const auctionCostActions = normalizeStringList(auctionCostAnalysis.nextActions);
  const consignation = asRecord(auctionCostAnalysis.consignation);
  const legalAttentionAnalysis = asRecord(analysis.legalAttentionAnalysis);
  const legalAttentionItems = normalizeLegalAttentionItems(legalAttentionAnalysis.items);
  const legalAttentionActions = normalizeStringList(legalAttentionAnalysis.nextActions);
  const urbanPlanningAnalysis = asRecord(analysis.urbanPlanningAnalysis);
  const urbanPlanningItems = normalizeUrbanPlanningItems(urbanPlanningAnalysis.items);
  const urbanPlanningActions = normalizeStringList(urbanPlanningAnalysis.nextActions);
  const urbanPlanningMissingChecks = normalizeStringList(urbanPlanningAnalysis.missingChecks);
  const dpe = asRecord(analysis.dpe);
  const dpeDiagnostic = asRecord(dpe.diagnostic);
  const dpeEvidence = normalizeDpeEvidence(dpe.evidence);
  const dpeNextActions = normalizeStringList(dpe.nextActions);
  const renovationAnalysis = asRecord(analysis.renovationAnalysis);
  const renovationEvidence = normalizeRenovationEvidence(renovationAnalysis.evidence);
  const renovationActions = normalizeStringList(renovationAnalysis.nextActions);
  const renovationBudgetRange = formatRenovationBudgetRange(
    asRecord(renovationAnalysis.budgetRange),
  );
  const streetFacadeAnalysis = asRecord(analysis.streetFacadeAnalysis);
  const streetFacadeActions = normalizeStringList(streetFacadeAnalysis.nextActions);
  const streetFacadeLimitations = normalizeStringList(streetFacadeAnalysis.limitations);
  const neighborhoodAnalysis = asRecord(analysis.neighborhoodAnalysis);
  const neighborhoodSignals = normalizeNeighborhoodSignals(neighborhoodAnalysis.signals);
  const neighborhoodActions = normalizeStringList(neighborhoodAnalysis.nextActions);
  const activeComparablesAnalysis = asRecord(analysis.activeComparablesAnalysis);
  const activeComparableItems = normalizeActiveComparableItems(activeComparablesAnalysis.items);
  const activeComparableActions = normalizeStringList(activeComparablesAnalysis.nextActions);
  const audienceReadinessAnalysis = asRecord(analysis.audienceReadinessAnalysis);
  const audienceChecklistItems = normalizeAudienceChecklistItems(
    audienceReadinessAnalysis.checklist,
  );
  const audienceReadinessActions = normalizeStringList(audienceReadinessAnalysis.nextActions);
  const canShowSoldComparables = featureUnlocked(plan.features.soldComparables);
  const canShowSaleHistory = featureUnlocked(plan.features.saleHistory);
  const canShowUrbanPlanning = featureUnlocked(plan.features.urbanPlanning);
  const canShowStreetFacade = featureUnlocked(plan.features.streetFacade);
  const canShowNeighborhood = featureUnlocked(plan.features.neighborhoodAnalysis);
  const canShowActiveComparables = featureUnlocked(plan.features.activeComparables);

  return [
    `Plan: ${plan.label}`,
    `Généré le: ${formatDate(String(snapshot.generatedAt ?? report.updated_at))}`,
    "",
    "Bien",
    `Titre: ${stringValue(cleanSaleTitle(stringValue(sale.title, null)), report.title)}`,
    `Localisation: ${stringValue(sale.displayAddress, null) || [sale.address, sale.city, sale.department].filter(Boolean).join(", ") || "à confirmer"}`,
    `Type: ${stringValue(sale.propertyType, "Bien")}`,
    `Surface retenue: ${stringValue(sale.surfaceLabel, "à confirmer")}`,
    `Occupation: ${stringValue(
      occupancyAnalysis.summary,
      stringValue(sale.occupancy, "à vérifier"),
    )}`,
    `Confiance occupation: ${stringValue(occupancyAnalysis.confidenceLabel, "à confirmer")}`,
    `Impact occupation: ${stringValue(occupancyAnalysis.decisionImpact, "à vérifier avant enchère")}`,
    `Tribunal: ${stringValue(sale.tribunal, "à confirmer")}`,
    ...reportSaleSchedule(sale).map(({ label, value }) => `${label}: ${value}`),
    `Préparation audience: ${stringValue(audienceReadinessAnalysis.summary, "à compléter")}`,
    `Urgence audience: ${stringValue(audienceReadinessAnalysis.urgencyLabel, "date à confirmer")}`,
    `Mise à prix: ${formatPrice(numberValue(sale.startingPrice))}`,
    "",
    "Estimation marché",
    valueEstimate.medianPricePerM2
      ? `Référence médiane: ${formatPricePerM2(numberValue(valueEstimate.medianPricePerM2))}`
      : "Référence médiane: à compléter",
    valueEstimate.p25PricePerM2 && valueEstimate.p75PricePerM2
      ? `Prix des comparables, intervalle P25-P75: ${formatPricePerM2(numberValue(valueEstimate.p25PricePerM2))} - ${formatPricePerM2(
          numberValue(valueEstimate.p75PricePerM2),
        )}`
      : "Prix des comparables, intervalle P25-P75: à compléter",
    `Échantillon: ${stringValue(valueEstimate.sampleSize, "0")} vente(s) comparable(s)`,
    `Qualité: ${stringValue(valueEstimate.qualityLabel, "fragile")}`,
    market.radiusM ? `Rayon DVF: ${market.radiusM} m` : "Rayon DVF: à compléter",
    `Confiance DVF: ${stringValue(marketComparables.confidenceLabel, "à vérifier")}`,
    `Audit estimation: ${stringValue(valuationAudit.summary, "audit estimation à construire")}`,
    `Score audit: ${stringValue(valuationAudit.score, "0")}/100`,
    `Impact audit: ${stringValue(valuationAudit.decisionImpact, "estimation à recouper")}`,
    ...(canShowSoldComparables
      ? [
          `Backtest estimation: ${stringValue(
            valuationBacktestSummary.interpretation,
            "backtest DVF à construire",
          )}`,
          `Erreur médiane observée: ${formatPercent(
            valuationBacktestSummary.medianAbsoluteErrorPct,
          )}`,
          `Tests utilisables: ${stringValue(valuationBacktestSummary.usableTests, "0")}`,
          `Prédictions à moins de 20%: ${formatPercent(valuationBacktestSummary.within20Pct)}`,
        ]
      : []),
    `Mode comparables: ${stringValue(marketComparables.comparableModeLabel, "à compléter")}`,
    `Lecture comparables: ${stringValue(marketComparables.summary, "comparables à compléter")}`,
    ...(canShowNeighborhood
      ? [
          `Analyse quartier: ${stringValue(neighborhoodAnalysis.summary, "quartier à qualifier")}`,
          `Confiance quartier: ${stringValue(neighborhoodAnalysis.confidenceLabel, "à vérifier")}`,
          `Position marché quartier: ${stringValue(
            neighborhoodAnalysis.marketPositionLabel,
            "marché local à calculer",
          )}`,
        ]
      : []),
    `Analyse démographique: ${stringValue(
      demographicAnalysis.summary,
      "données démographiques à enrichir",
    )}`,
    `Profil démographique: ${stringValue(demographicAnalysis.profileLabel, "profil local à enrichir")}`,
    ...(canShowActiveComparables
      ? [
          `Biens comparables actifs: ${stringValue(
            activeComparablesAnalysis.summary,
            "aucun comparable actif",
          )}`,
          `Confiance comparables actifs: ${stringValue(
            activeComparablesAnalysis.confidenceLabel,
            "à vérifier",
          )}`,
        ]
      : []),
    ...(canShowSoldComparables && retainedComparables.length
      ? ["Transactions DVF retenues", ...retainedComparables.slice(0, 5).map((row) => `- ${row}`)]
      : []),
    ...(canShowActiveComparables && activeComparableItems.length
      ? [
          "Biens comparables en vente",
          ...activeComparableItems.slice(0, 5).map((row) => `- ${row}`),
        ]
      : []),
    ...(canShowSaleHistory && addressHistory.length
      ? ["Historique adresse", ...addressHistory.slice(0, 3).map((row) => `- ${row}`)]
      : []),
    ...(marketComparablesActions.length
      ? [
          "Actions comparables",
          ...marketComparablesActions.slice(0, 3).map((action) => `- ${action}`),
        ]
      : []),
    ...(valuationCheckpoints.length
      ? [
          "Audit de valorisation",
          ...valuationCheckpoints.slice(0, 8).map((checkpoint) => `- ${checkpoint}`),
        ]
      : []),
    ...(valuationRiskFlags.length
      ? ["Points estimation à risque", ...valuationRiskFlags.slice(0, 5).map((flag) => `- ${flag}`)]
      : []),
    ...(valuationActions.length
      ? ["Actions audit estimation", ...valuationActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(canShowSoldComparables && valuationBacktestActions.length
      ? [
          "Actions backtest estimation",
          ...valuationBacktestActions.slice(0, 3).map((action) => `- ${action}`),
        ]
      : []),
    "",
    "Lecture opportunité",
    `Score du dossier, distinct du scénario personnel: ${opportunity.score != null ? `${opportunity.score}/100 - ${stringValue(opportunity.label, "à qualifier")}` : "à compléter"}`,
    `Décote apparente: ${formatPercent(opportunity.apparentDiscountPct)}`,
    opportunity.estimatedMarketValue
      ? `Valeur médiane estimée: ${formatPrice(numberValue(opportunity.estimatedMarketValue))}`
      : "Valeur médiane estimée: à compléter",
    opportunity.estimatedMarketLow && opportunity.estimatedMarketHigh
      ? `${stringValue(opportunity.estimatedMarketRangeLabel, "Fourchette de valeur")}: ${formatPrice(numberValue(opportunity.estimatedMarketLow))} - ${formatPrice(
          numberValue(opportunity.estimatedMarketHigh),
        )}`
      : "Fourchette de valeur: à compléter",
    `Rendement brut potentiel: ${formatPercent(opportunity.grossYieldPct)}`,
    rentabilityScore.score != null
      ? `Score de rentabilite: ${rentabilityScore.score}/100 - ${stringValue(rentabilityScore.label, "à qualifier")}`
      : `Score de rentabilite: indisponible (${stringValue(rentabilityScore.reason, "données incomplètes")})`,
    rentabilityScore.netYieldPct != null
      ? `Rendement net estime: ${formatPercent(rentabilityScore.netYieldPct)}`
      : "Rendement net estime: à compléter",
    rentabilityScore.cashflowMonthly != null
      ? `Cashflow mensuel estime: ${formatPrice(numberValue(rentabilityScore.cashflowMonthly))}`
      : "Cashflow mensuel estime: à compléter",
    `Frais adjudication: ${stringValue(
      auctionCostAnalysis.summary,
      "frais et consignation à confirmer",
    )}`,
    `Confiance frais: ${stringValue(auctionCostAnalysis.confidenceLabel, "à confirmer")}`,
    consignation.amountEur
      ? `Consignation source: ${formatPrice(numberValue(consignation.amountEur))}`
      : "Consignation source: à confirmer",
    acquisitionCosts.acquisitionFeesTotal
      ? `Frais estimés hors travaux: ${formatPrice(numberValue(acquisitionCosts.acquisitionFeesTotal))}`
      : "Frais estimés hors travaux: à compléter",
    acquisitionCosts.totalCost
      ? `Coût complet ${ceiling.personalSimulation ? "au prix simulé" : "à la mise à prix"}: ${formatPrice(numberValue(acquisitionCosts.totalCost))}`
      : "Coût complet à la mise à prix: à compléter",
    `Travaux / état: ${stringValue(renovationAnalysis.summary, "état à qualifier")}`,
    `Priorité travaux: ${stringValue(renovationAnalysis.priorityLabel, "à qualifier")}`,
    renovationBudgetRange
      ? `Budget travaux indicatif: ${renovationBudgetRange}`
      : "Budget travaux indicatif: à chiffrer",
    `Impact travaux: ${stringValue(
      renovationAnalysis.decisionImpact,
      "état à confirmer avant enchère",
    )}`,
    "",
    "Plafond d'enchère",
    ...(ceiling.personalSimulation
      ? [
          "Scénario personnel sauvegardé",
          `Scénario: ${stringValue(ceiling.scenario, "à confirmer")}`,
          `Travaux saisis: ${formatPrice(numberValue(asRecord(ceiling.personalSimulation).works))}`,
          `Frais préalables saisis: ${formatPrice(numberValue(asRecord(ceiling.personalSimulation).fpt))}`,
          `Prix simulé: ${formatPrice(numberValue(asRecord(ceiling.personalSimulation).price))}`,
          `Marge de sécurité: ${numberValue(ceiling.safetyDiscountPct)} %`,
          `Base retenue: ${stringValue(ceiling.basisLabel, "à confirmer")}`,
        ]
      : []),
    ceiling.available
      ? `Mise maximum conseillée: ${formatPrice(numberValue(ceiling.maxBid))}`
      : `Mise maximum conseillée: indisponible (${stringValue(ceiling.reason, "données incomplètes")})`,
    ...(ceiling.available &&
    numberValue(ceiling.maxBid) != null &&
    numberValue(sale.startingPrice) != null &&
    (numberValue(ceiling.maxBid) ?? Infinity) < (numberValue(sale.startingPrice) ?? 0)
      ? [
          "Plafond inférieur à la mise à prix : ce scénario ne permet pas d’enchérir au prix de départ.",
        ]
      : []),
    ceiling.targetTotalCost
      ? `Coût complet cible: ${formatPrice(numberValue(ceiling.targetTotalCost))}`
      : "Coût complet cible: à compléter",
    ceiling.marketReferencePricePerM2
      ? `Référence marché retenue: ${formatPricePerM2(numberValue(ceiling.marketReferencePricePerM2))}`
      : "Référence marché retenue: à compléter",
    "",
    "Préparation audience",
    `Synthèse: ${stringValue(audienceReadinessAnalysis.summary, "préparation à compléter")}`,
    `Statut: ${stringValue(audienceReadinessAnalysis.label, "à vérifier")}`,
    `Progression: ${stringValue(audienceReadinessAnalysis.progressPct, "0")} %`,
    `Points prioritaires ouverts: ${stringValue(
      audienceReadinessAnalysis.highPriorityOpenCount,
      "0",
    )}`,
    ...(audienceChecklistItems.length
      ? audienceChecklistItems.slice(0, 8).map((item) => `- ${item}`)
      : ["- Checklist à compléter dans le dossier."]),
    ...(audienceReadinessActions.length
      ? [
          "Actions préparation audience",
          ...audienceReadinessActions.slice(0, 4).map((action) => `- ${action}`),
        ]
      : []),
    "",
    "Analyse de bien",
    `Cadastre: ${stringValue(
      cadastral.summary,
      cadastral.available ? "repère disponible" : "à connecter ou confirmer",
    )}`,
    `Confiance cadastre: ${stringValue(cadastral.confidenceLabel, "à confirmer")}`,
    ...(cadastralReferences.length
      ? [`Référence(s) cadastrale(s): ${cadastralReferences.join(", ")}`]
      : []),
    cadastral.landSurfaceM2
      ? `Surface terrain: ${stringValue(cadastral.landSurfaceM2, "")} m²`
      : "Surface terrain: à confirmer",
    `DPE / diagnostics: ${stringValue(
      dpe.summary,
      dpe.available ? stringValue(dpe.class, "diagnostic repéré") : "à rechercher",
    )}`,
    `Confiance DPE: ${stringValue(dpe.confidenceLabel, "à confirmer")}`,
    dpeDiagnostic.diagnosticNumber
      ? `Numéro DPE: ${stringValue(dpeDiagnostic.diagnosticNumber, "")}`
      : "Numéro DPE: à confirmer",
    dpe.gesClass ? `Classe GES: ${stringValue(dpe.gesClass, "")}` : "Classe GES: à confirmer",
    dpeDiagnostic.energyConsumptionKwhM2Year
      ? `Conso énergie: ${stringValue(dpeDiagnostic.energyConsumptionKwhM2Year, "")} kWhEP/m²/an`
      : "Conso énergie: à confirmer",
    dpeDiagnostic.emissionsKgCo2M2Year
      ? `Émissions GES: ${stringValue(dpeDiagnostic.emissionsKgCo2M2Year, "")} kgCO2/m²/an`
      : "Émissions GES: à confirmer",
    `Impact DPE: ${stringValue(dpe.impactLabel, "impact à qualifier")}`,
    `Travaux / état: ${stringValue(renovationAnalysis.summary, "à qualifier")}`,
    `Confiance travaux: ${stringValue(renovationAnalysis.confidenceLabel, "à confirmer")}`,
    ...(canShowUrbanPlanning
      ? [
          `Urbanisme / permis: ${stringValue(
            urbanPlanningAnalysis.summary,
            "urbanisme, permis et servitudes à vérifier",
          )}`,
          `Confiance urbanisme: ${stringValue(
            urbanPlanningAnalysis.confidenceLabel,
            "à vérifier",
          )}`,
        ]
      : []),
    ...(canShowStreetFacade
      ? [
          `Façade et rue: ${stringValue(streetFacadeAnalysis.summary, "localisation à vérifier")}`,
          `Confiance façade/rue: ${stringValue(
            streetFacadeAnalysis.confidenceLabel,
            "à confirmer",
          )}`,
          "Cartographie : consulter la localisation sur la fiche annonce. Les vues ne sont pas jointes au rapport.",
        ]
      : []),
    `Services de proximité: ${stringValue(
      nearbyServices.summary,
      nearbyServices.available ? "signaux de proximité reperes" : "à qualifier",
    )}`,
    `Confiance proximité: ${stringValue(nearbyServices.confidenceLabel, "à confirmer")}`,
    nearbyCategories.length
      ? `Familles de services: ${nearbyCategories.join(", ")}`
      : "Familles de services: à mesurer",
    `Démographie: ${stringValue(demographicAnalysis.summary, "données locales à enrichir")}`,
    `Confiance démographie: ${stringValue(demographicAnalysis.confidenceLabel, "à vérifier")}`,
    `Demande locale: ${stringValue(demographicAnalysis.demandLabel, "demande à qualifier")}`,
    ...(canShowNeighborhood
      ? [
          `Quartier: ${stringValue(neighborhoodAnalysis.summary, "à qualifier")}`,
          `Dimensions quartier: ${
            normalizeStringList(neighborhoodAnalysis.dimensions).join(", ") || "à enrichir"
          }`,
        ]
      : []),
    ...(canShowActiveComparables
      ? [`Comparables actifs: ${stringValue(activeComparablesAnalysis.summary, "à rechercher")}`]
      : []),
    `Documents: ${stringValue(analysis.documentsCount, "0")} pièce(s)`,
    ...(occupancyEvidence.length
      ? ["Indices occupation", ...occupancyEvidence.slice(0, 4).map((item) => `- ${item}`)]
      : []),
    ...(occupancyNextActions.length
      ? ["Actions occupation", ...occupancyNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(auctionCostSignals.length
      ? ["Signaux frais", ...auctionCostSignals.slice(0, 4).map((signal) => `- ${signal}`)]
      : []),
    ...(auctionCostActions.length
      ? ["Actions frais", ...auctionCostActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(dpeEvidence.length
      ? ["Indices DPE / diagnostics", ...dpeEvidence.slice(0, 4).map((item) => `- ${item}`)]
      : []),
    ...(dpeNextActions.length
      ? ["Actions DPE", ...dpeNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(renovationEvidence.length
      ? ["Indices travaux / état", ...renovationEvidence.slice(0, 4).map((item) => `- ${item}`)]
      : []),
    ...(renovationActions.length
      ? ["Actions travaux", ...renovationActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningItems.length
      ? ["Signaux urbanisme/permis", ...urbanPlanningItems.slice(0, 6).map((item) => `- ${item}`)]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningMissingChecks.length
      ? [
          "Contrôles urbanisme manquants",
          ...urbanPlanningMissingChecks.slice(0, 4).map((check) => `- ${check}`),
        ]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningActions.length
      ? [
          "Actions urbanisme/permis",
          ...urbanPlanningActions.slice(0, 4).map((action) => `- ${action}`),
        ]
      : []),
    ...(canShowStreetFacade && streetFacadeActions.length
      ? ["Actions façade/rue", ...streetFacadeActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowStreetFacade && streetFacadeLimitations.length
      ? [
          "Limites façade/rue",
          ...streetFacadeLimitations.slice(0, 2).map((limitation) => `- ${limitation}`),
        ]
      : []),
    ...(canShowNeighborhood && neighborhoodSignals.length
      ? ["Signaux quartier", ...neighborhoodSignals.slice(0, 5).map((signal) => `- ${signal}`)]
      : []),
    ...(canShowNeighborhood && neighborhoodActions.length
      ? ["Actions quartier", ...neighborhoodActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowActiveComparables && activeComparableActions.length
      ? [
          "Actions comparables actifs",
          ...activeComparableActions.slice(0, 3).map((action) => `- ${action}`),
        ]
      : []),
    "",
    "Revue juridique",
    `Synthèse: ${stringValue(legalAttentionAnalysis.summary, "points juridiques à relire")}`,
    `Niveau: ${stringValue(legalAttentionAnalysis.confidenceLabel, "à vérifier")}`,
    ...(legalAttentionItems.length
      ? legalAttentionItems.slice(0, 6).map((item) => `- ${item}`)
      : ["- Relire les pièces officielles avant toute enchère."]),
    ...(legalAttentionActions.length
      ? ["Actions juridiques", ...legalAttentionActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(cadastralNextActions.length
      ? ["Actions cadastre", ...cadastralNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(nearbyNextActions.length
      ? ["Actions proximité", ...nearbyNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(demographicSignals.length
      ? ["Signaux démographiques", ...demographicSignals.slice(0, 6).map((signal) => `- ${signal}`)]
      : []),
    ...(demographicMissingData.length
      ? [
          "Données démographiques manquantes",
          ...demographicMissingData.slice(0, 4).map((item) => `- ${item}`),
        ]
      : []),
    ...(demographicActions.length
      ? ["Actions démographie", ...demographicActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(sourceTrace.length
      ? [
          "",
          "Sources et traçabilité",
          ...sourceTrace.map((entry) =>
            [
              `- ${entry.label}`,
              entry.sourceName,
              entry.url ? `URL: ${entry.url}` : null,
              entry.confidenceLabel ? `Confiance: ${entry.confidenceLabel}` : null,
            ]
              .filter(Boolean)
              .join(" | "),
          ),
        ]
      : []),
    ...(limitations.length
      ? ["", "Limites", ...limitations.slice(0, 6).map((limitation) => `- ${limitation}`)]
      : []),
    ...(legalAttentionPoints.length
      ? [
          "",
          "Points d'attention",
          ...legalAttentionPoints.map((point) => `- ${stringValue(point, "")}`),
        ]
      : []),
    "",
    "Notes",
    report.user_notes || "Aucune note utilisateur.",
    "",
    "Avertissement",
    complianceNotice,
  ];
}
