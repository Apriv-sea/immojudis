import type { MarketEstimate } from "@/lib/market.functions";

export type MarketComparableRow = {
  kind: "retained_comparable" | "address_history";
  date: string;
  type: string;
  surfaceM2: number | null;
  pricePerM2: number | null;
  totalPriceEur: number | null;
  distanceM: number | null;
};

export type MarketComparablesAnalysis = {
  available: boolean;
  status: "detailed" | "address_history" | "weak" | "missing";
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  source: string | null;
  comparableMode: MarketEstimate["comparableMode"] | null;
  comparableModeLabel: string;
  sampleSize: number;
  parcelSampleSize: number;
  totalNearbySampleSize: number;
  outliersRemoved: number;
  radiusM: number | null;
  yearsBack: number | null;
  surfaceWindowLabel: string | null;
  priceRangeLabel: string | null;
  qualityScore: number | null;
  qualityWarnings: string[];
  retainedComparables: MarketComparableRow[];
  addressHistory: MarketComparableRow[];
  summary: string;
  nextActions: string[];
  limitations: string[];
};

export function buildMarketComparablesAnalysis(
  estimate: MarketEstimate | null,
): MarketComparablesAnalysis {
  if (!estimate) {
    return {
      available: false,
      status: "missing",
      confidence: "low",
      confidenceLabel: "Référence DVF non disponible",
      source: null,
      comparableMode: null,
      comparableModeLabel: "À compléter",
      sampleSize: 0,
      parcelSampleSize: 0,
      totalNearbySampleSize: 0,
      outliersRemoved: 0,
      radiusM: null,
      yearsBack: null,
      surfaceWindowLabel: null,
      priceRangeLabel: null,
      qualityScore: null,
      qualityWarnings: [],
      retainedComparables: [],
      addressHistory: [],
      summary: "Aucune référence DVF exploitable n'est encore rattachée au rapport.",
      nextActions: [
        "Calculer ou renseigner une référence de marché avant de figer la mise maximale.",
      ],
      limitations: [
        "Sans comparables DVF, la fourchette de valeur doit être considérée comme provisoire.",
      ],
    };
  }

  const retainedComparables = estimate.recentTransactions.map((transaction) => ({
    kind: "retained_comparable" as const,
    date: transaction.date,
    type: transaction.type,
    surfaceM2: finiteNumber(transaction.surface),
    pricePerM2: finiteNumber(transaction.pricePerM2),
    totalPriceEur: finiteNumber(transaction.totalPrice),
    distanceM: finiteNumber(transaction.distanceM),
  }));
  const addressHistory = estimate.addressHistory.map((transaction) => ({
    kind: "address_history" as const,
    date: transaction.date,
    type: transaction.type,
    surfaceM2: finiteNumber(transaction.surface),
    pricePerM2: finiteNumber(transaction.pricePerM2),
    totalPriceEur: finiteNumber(transaction.totalPrice),
    distanceM: null,
  }));
  const status = resolveStatus(estimate);
  const confidence = resolveConfidence(estimate);

  return {
    available: true,
    status,
    confidence,
    confidenceLabel: confidenceLabel({ estimate, confidence, status }),
    source: estimate.source,
    comparableMode: estimate.comparableMode,
    comparableModeLabel: comparableModeLabel(estimate.comparableMode),
    sampleSize: estimate.sampleSize,
    parcelSampleSize: estimate.parcelSampleSize,
    totalNearbySampleSize: estimate.totalNearbySampleSize,
    outliersRemoved: estimate.outliersRemoved,
    radiusM: estimate.radiusM,
    yearsBack: estimate.yearsBack,
    surfaceWindowLabel: surfaceWindowLabel(estimate),
    priceRangeLabel: priceRangeLabel(estimate),
    qualityScore: estimate.qualityScore,
    qualityWarnings: estimate.qualityWarnings,
    retainedComparables,
    addressHistory,
    summary: summary(estimate),
    nextActions: nextActions({ estimate, status }),
    limitations: limitations({ estimate, status }),
  };
}

export function marketReferenceConfidence(estimate: MarketEstimate | null) {
  if (!estimate)
    return {
      confidence: "low" as const,
      confidenceLabel: "Référence DVF non disponible",
    };
  const confidence = resolveConfidence(estimate);
  return {
    confidence,
    confidenceLabel: confidenceLabel({ estimate, confidence, status: resolveStatus(estimate) }),
  };
}

function resolveStatus(estimate: MarketEstimate): MarketComparablesAnalysis["status"] {
  if (estimate.comparableMode === "address_history" && estimate.addressHistory.length >= 2) {
    return "address_history";
  }
  if (estimate.sampleSize >= 6 && estimate.recentTransactions.length >= 3) return "detailed";
  if (estimate.sampleSize > 0 || estimate.recentTransactions.length > 0) return "weak";
  return "missing";
}

function resolveConfidence(estimate: MarketEstimate): MarketComparablesAnalysis["confidence"] {
  if (estimate.qualityScore >= 78 && estimate.sampleSize >= 8) return "high";
  if (estimate.qualityScore >= 58 && estimate.sampleSize >= 3) return "medium";
  return "low";
}

function confidenceLabel({
  estimate,
  confidence,
  status,
}: {
  estimate: MarketEstimate;
  confidence: MarketComparablesAnalysis["confidence"];
  status: MarketComparablesAnalysis["status"];
}): string {
  if (status === "address_history")
    return "Historique adresse utilisé faute de comparables proches";
  if (confidence === "high") return "Échantillon DVF solide";
  if (confidence === "medium") return "Échantillon DVF exploitable avec prudence";
  if (estimate.sampleSize > 0) return "Échantillon DVF fragile";
  return "Comparables DVF insuffisants";
}

function comparableModeLabel(mode: MarketEstimate["comparableMode"]): string {
  const labels: Record<MarketEstimate["comparableMode"], string> = {
    surface_matched: "Surfaces comparables",
    surface_land_matched: "Surfaces bâties et terrains comparables",
    land_matched: "Terrains comparables",
    same_type_expanded: "Même type, surfaces élargies",
    nearby_type_only: "Type proche, surfaces élargies",
    address_history: "Historique exact d'adresse",
    geographic_aggregate: "Médiane géographique agrégée",
    unit_sales: "Ventes unitaires de stationnement",
  };
  return labels[mode];
}

function surfaceWindowLabel(estimate: MarketEstimate): string | null {
  if (estimate.surfaceMinM2 == null || estimate.surfaceMaxM2 == null) return null;
  return `${estimate.surfaceMinM2} à ${estimate.surfaceMaxM2} m²`;
}

function priceRangeLabel(estimate: MarketEstimate): string | null {
  if (estimate.p25PricePerM2 == null || estimate.p75PricePerM2 == null) return null;
  return `${formatPerM2(estimate.p25PricePerM2)} à ${formatPerM2(estimate.p75PricePerM2)}`;
}

function summary(estimate: MarketEstimate): string {
  const parts = [
    `${estimate.sampleSize} vente(s) retenue(s)`,
    `${estimate.totalNearbySampleSize} transaction(s) proche(s)`,
    `rayon ${estimate.radiusM} m`,
    comparableModeLabel(estimate.comparableMode).toLowerCase(),
  ];
  if (estimate.outliersRemoved > 0) parts.push(`${estimate.outliersRemoved} valeur(s) écartée(s)`);
  if (estimate.medianPricePerM2 != null)
    parts.push(`médiane ${formatPerM2(estimate.medianPricePerM2)}`);
  return `${parts.join(" · ")}.`;
}

function nextActions({
  estimate,
  status,
}: {
  estimate: MarketEstimate;
  status: MarketComparablesAnalysis["status"];
}): string[] {
  const actions: string[] = [];
  if (status === "weak" || status === "missing") {
    actions.push(
      "Compléter la référence marché avec une hypothèse manuelle ou un périmètre élargi.",
    );
  }
  if (estimate.qualityWarnings.length) {
    actions.push(
      "Relire les avertissements de qualité avant de retenir la médiane comme valeur cible.",
    );
  }
  if (estimate.surfaceMinM2 != null && estimate.surfaceMaxM2 != null) {
    actions.push("Comparer la surface du bien avec la fenêtre de surfaces DVF retenue.");
  }
  actions.push(
    "Contrôler les transactions les plus proches et écarter celles qui ne ressemblent pas au bien.",
  );
  return actions.slice(0, 4);
}

function limitations({
  estimate,
  status,
}: {
  estimate: MarketEstimate;
  status: MarketComparablesAnalysis["status"];
}): string[] {
  const limitations = [
    "DVF ne décrit pas tous les critères qualitatifs du bien, ni son état exact au moment de la vente.",
    "La publication DVF peut être décalée dans le temps ; les ventes très récentes peuvent manquer.",
  ];
  if (status === "weak" || estimate.sampleSize < 6) {
    limitations.unshift(
      "L'échantillon retenu est court : la fourchette doit être considérée comme fragile.",
    );
  }
  if (
    estimate.comparableMode !== "surface_matched" &&
    estimate.comparableMode !== "surface_land_matched" &&
    estimate.comparableMode !== "land_matched"
  ) {
    limitations.unshift(
      "Les surfaces ou le mode de comparaison sont élargis faute de références strictement comparables.",
    );
  }
  return limitations;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPerM2(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value)} €/m²`;
}
