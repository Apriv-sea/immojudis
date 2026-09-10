export type PlanCode = "decouverte" | "analyse";

export type PlanStatus = "trialing" | "active" | "past_due" | "paused" | "cancelled" | "expired";

export type FeatureKey =
  | "sales.filters"
  | "sales.statistics"
  | "sales.favorites"
  | "sales.csvExport"
  | "sales.apiAccess"
  | "sales.multiPropertyAnalysis"
  | "alerts.advanced"
  | "alerts.realtimeChanges"
  | "alerts.watchedZones"
  | "dpe.latest"
  | "dpe.filters"
  | "dpe.map"
  | "market.neighborhood"
  | "market.demographics"
  | "market.priceEvolution"
  | "market.priceDistribution"
  | "market.volumeEvolution"
  | "market.rotationRate"
  | "market.saleDelayEvolution"
  | "market.neighborhoodComparison"
  | "market.nearbyCommuneComparison"
  | "property.valueEstimate"
  | "property.bidCeiling"
  | "property.advancedBidScenarios"
  | "property.cadastralAnalysis"
  | "property.nearbyServices"
  | "property.savedReports"
  | "property.pdfExport"
  | "property.reportEditing"
  | "property.urbanPlanning"
  | "property.streetFacade"
  | "property.saleHistory"
  | "property.soldComparables"
  | "property.activeComparables"
  | "property.neighborhoodAnalysis"
  | "property.outcomeGraph"
  | "property.informationAgent"
  | "data.onDemandRefresh"
  | "lawyers.directory"
  | "lawyers.referrals"
  | "workspace.audienceTracking"
  | "workspace.collaboration";

export type FeatureAccess = "included" | "limited" | "locked";

export type PlanFeatureMatrix = Record<FeatureKey, FeatureAccess>;

export type PlanLimits = {
  propertyReportsPerMonth: number | null;
  pdfExportsPerMonth: number | null;
  savedReports: number | null;
  reportEditing: "limited" | "full";
  favoriteSales: number | null;
  watchedZones: number | null;
  saleAnalysisSets: number | null;
  saleAnalysisItems: number | null;
  apiKeys: number | null;
  workspaceCollaborators: number | null;
  informationAgentMissionsPer30Days: number | null;
};

export const PLAN_LABELS: Record<PlanCode, string> = {
  decouverte: "Découverte",
  analyse: "Analyse",
};

export const PLAN_FEATURES: Record<PlanCode, PlanFeatureMatrix> = {
  decouverte: {
    "sales.filters": "included",
    "sales.statistics": "locked",
    "sales.favorites": "limited",
    "sales.csvExport": "locked",
    "sales.apiAccess": "locked",
    "sales.multiPropertyAnalysis": "limited",
    "alerts.advanced": "limited",
    "alerts.realtimeChanges": "locked",
    "alerts.watchedZones": "limited",
    "dpe.latest": "locked",
    "dpe.filters": "locked",
    "dpe.map": "locked",
    "market.neighborhood": "locked",
    "market.demographics": "locked",
    "market.priceEvolution": "locked",
    "market.priceDistribution": "locked",
    "market.volumeEvolution": "locked",
    "market.rotationRate": "locked",
    "market.saleDelayEvolution": "locked",
    "market.neighborhoodComparison": "locked",
    "market.nearbyCommuneComparison": "locked",
    "property.valueEstimate": "locked",
    "property.bidCeiling": "locked",
    "property.advancedBidScenarios": "locked",
    "property.cadastralAnalysis": "locked",
    "property.nearbyServices": "locked",
    "property.savedReports": "locked",
    "property.pdfExport": "locked",
    "property.reportEditing": "locked",
    "property.urbanPlanning": "locked",
    "property.streetFacade": "locked",
    "property.saleHistory": "locked",
    "property.soldComparables": "locked",
    "property.activeComparables": "locked",
    "property.neighborhoodAnalysis": "locked",
    "property.outcomeGraph": "locked",
    "property.informationAgent": "locked",
    "data.onDemandRefresh": "locked",
    "lawyers.directory": "included",
    "lawyers.referrals": "locked",
    "workspace.audienceTracking": "locked",
    "workspace.collaboration": "locked",
  },
  analyse: {
    "sales.filters": "included",
    "sales.statistics": "included",
    "sales.favorites": "included",
    "sales.csvExport": "included",
    "sales.apiAccess": "included",
    "sales.multiPropertyAnalysis": "included",
    "alerts.advanced": "included",
    "alerts.realtimeChanges": "included",
    "alerts.watchedZones": "included",
    "dpe.latest": "included",
    "dpe.filters": "included",
    "dpe.map": "included",
    "market.neighborhood": "included",
    "market.demographics": "included",
    "market.priceEvolution": "included",
    "market.priceDistribution": "included",
    "market.volumeEvolution": "included",
    "market.rotationRate": "included",
    "market.saleDelayEvolution": "included",
    "market.neighborhoodComparison": "included",
    "market.nearbyCommuneComparison": "included",
    "property.valueEstimate": "included",
    "property.bidCeiling": "included",
    "property.advancedBidScenarios": "included",
    "property.cadastralAnalysis": "included",
    "property.nearbyServices": "included",
    "property.savedReports": "included",
    "property.pdfExport": "included",
    "property.reportEditing": "included",
    "property.urbanPlanning": "included",
    "property.streetFacade": "included",
    "property.saleHistory": "included",
    "property.soldComparables": "included",
    "property.activeComparables": "included",
    "property.neighborhoodAnalysis": "included",
    "property.outcomeGraph": "included",
    "property.informationAgent": "included",
    "data.onDemandRefresh": "included",
    "lawyers.directory": "included",
    "lawyers.referrals": "included",
    "workspace.audienceTracking": "included",
    "workspace.collaboration": "included",
  },
};

export const PLAN_LIMITS: Record<PlanCode, PlanLimits> = {
  decouverte: {
    propertyReportsPerMonth: 0,
    pdfExportsPerMonth: 0,
    savedReports: 0,
    reportEditing: "limited",
    favoriteSales: 10,
    watchedZones: 1,
    saleAnalysisSets: 1,
    saleAnalysisItems: 3,
    apiKeys: 0,
    workspaceCollaborators: 0,
    informationAgentMissionsPer30Days: 0,
  },
  analyse: {
    propertyReportsPerMonth: null,
    pdfExportsPerMonth: null,
    savedReports: null,
    reportEditing: "full",
    favoriteSales: null,
    watchedZones: 25,
    saleAnalysisSets: 20,
    saleAnalysisItems: 12,
    apiKeys: 2,
    workspaceCollaborators: 25,
    informationAgentMissionsPer30Days: 3,
  },
};

export function normalizePlanCode(value: unknown): PlanCode {
  if (value === "analyse" || value === "investisseur") return "analyse";
  return "decouverte";
}

export function isActivePlanStatus(status: unknown): boolean {
  return status === "trialing" || status === "active";
}

export function isPlanPeriodActive(
  status: unknown,
  currentPeriodEnd: unknown,
  now = new Date(),
): boolean {
  if (!isActivePlanStatus(status)) return false;
  if (currentPeriodEnd == null || currentPeriodEnd === "") return true;
  if (typeof currentPeriodEnd !== "string") return false;

  const periodEnd = new Date(currentPeriodEnd).getTime();
  return Number.isFinite(periodEnd) && periodEnd > now.getTime();
}

export function featureAccess(plan: PlanCode, feature: FeatureKey): FeatureAccess {
  return PLAN_FEATURES[plan][feature];
}

export function featureIncluded(plan: PlanCode, feature: FeatureKey): boolean {
  return featureAccess(plan, feature) !== "locked";
}
