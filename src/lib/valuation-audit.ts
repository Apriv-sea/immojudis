import type { MarketEstimate } from "@/lib/market.functions";
import type { AuctionSale } from "@/lib/types";

export type ValuationAuditStatus = "robust" | "usable" | "fragile" | "missing";
export type ValuationCheckpointStatus = "ok" | "watch" | "risk" | "missing";

export type ValuationCheckpoint = {
  key: string;
  label: string;
  status: ValuationCheckpointStatus;
  detail: string;
  action: string;
};

export type ValuationAudit = {
  available: boolean;
  status: ValuationAuditStatus;
  score: number;
  confidenceLabel: string;
  checkpoints: ValuationCheckpoint[];
  riskFlags: string[];
  summary: string;
  decisionImpact: string;
  nextActions: string[];
  limitations: string[];
};

export function buildValuationAudit({
  sale,
  surfaceM2,
  marketEstimate,
}: {
  sale: AuctionSale;
  surfaceM2: number | null;
  marketEstimate: MarketEstimate | null;
}): ValuationAudit {
  if (!marketEstimate) return missingAudit();

  const checkpoints = [
    sampleCheckpoint(marketEstimate),
    qualityCheckpoint(marketEstimate),
    modeCheckpoint(marketEstimate),
    surfaceCheckpoint({ marketEstimate, surfaceM2 }),
    radiusCheckpoint(marketEstimate),
    outlierCheckpoint(marketEstimate),
    discountCheckpoint({ sale, surfaceM2, marketEstimate }),
    warningsCheckpoint(marketEstimate),
  ];
  const score = scoreFromCheckpoints(checkpoints);
  const scoredStatus = statusFromScore(score);
  const status =
    scoredStatus === "robust" && marketEstimate.sampleSize < 8 ? "usable" : scoredStatus;
  const riskFlags = checkpoints
    .filter((checkpoint) => checkpoint.status === "risk" || checkpoint.status === "missing")
    .map((checkpoint) => checkpoint.label);

  return {
    available: true,
    status,
    score,
    confidenceLabel: confidenceLabel(status),
    checkpoints,
    riskFlags,
    summary: summary({ status, score, checkpoints }),
    decisionImpact: decisionImpact(status),
    nextActions: nextActions(checkpoints),
    limitations: [
      "L'audit qualifie la robustesse opérationnelle de l'estimation ; il ne garantit pas un prix d'adjudication ou de revente.",
      "La valeur doit rester ajustée par l'état du bien, l'occupation, les travaux, les servitudes et la concurrence à l'audience.",
    ],
  };
}

function missingAudit(): ValuationAudit {
  return {
    available: false,
    status: "missing",
    score: 0,
    confidenceLabel: "Estimation à construire",
    checkpoints: [
      {
        key: "market_reference",
        label: "Référence marché",
        status: "missing",
        detail: "Aucune estimation DVF exploitable.",
        action: "Calculer ou renseigner une fourchette de marché avant de fixer la mise maximale.",
      },
    ],
    riskFlags: ["Référence marché"],
    summary: "Audit impossible : aucune référence marché exploitable.",
    decisionImpact:
      "Ne pas utiliser la médiane comme base de plafond tant que l'estimation manque.",
    nextActions: ["Calculer une estimation DVF ou renseigner une hypothèse de marché documentée."],
    limitations: ["Sans référence marché, toute décote apparente reste indicative."],
  };
}

function sampleCheckpoint(estimate: MarketEstimate): ValuationCheckpoint {
  if (estimate.sampleSize >= 8) {
    return {
      key: "sample_size",
      label: "Taille d'échantillon",
      status: "ok",
      detail: `${estimate.sampleSize} vente(s) retenue(s).`,
      action: "Utiliser la médiane comme repère, après relecture des comparables.",
    };
  }
  if (estimate.sampleSize >= 3) {
    return {
      key: "sample_size",
      label: "Taille d'échantillon",
      status: "watch",
      detail: `${estimate.sampleSize} vente(s) retenue(s), échantillon court.`,
      action: "Élargir le périmètre ou compléter par une hypothèse manuelle.",
    };
  }
  return {
    key: "sample_size",
    label: "Taille d'échantillon",
    status: "risk",
    detail: `${estimate.sampleSize} vente(s) retenue(s), référence fragile.`,
    action: "Ne pas figer le plafond sans comparables complémentaires.",
  };
}

function qualityCheckpoint(estimate: MarketEstimate): ValuationCheckpoint {
  if (estimate.qualityScore >= 75) {
    return {
      key: "quality_score",
      label: "Score qualité DVF",
      status: "ok",
      detail: `${estimate.qualityScore}/100 · ${estimate.qualityLabel}.`,
      action: "Conserver la fourchette DVF comme référence principale.",
    };
  }
  if (estimate.qualityScore >= 55) {
    return {
      key: "quality_score",
      label: "Score qualité DVF",
      status: "watch",
      detail: `${estimate.qualityScore}/100 · ${estimate.qualityLabel}.`,
      action: "Appliquer une marge de sécurité sur la médiane.",
    };
  }
  return {
    key: "quality_score",
    label: "Score qualité DVF",
    status: "risk",
    detail: `${estimate.qualityScore}/100 · ${estimate.qualityLabel}.`,
    action: "Traiter la fourchette comme indicative et demander un recoupement.",
  };
}

function modeCheckpoint(estimate: MarketEstimate): ValuationCheckpoint {
  if (
    estimate.comparableMode === "surface_matched" ||
    estimate.comparableMode === "surface_land_matched" ||
    estimate.comparableMode === "land_matched"
  ) {
    return {
      key: "comparable_mode",
      label: "Mode de comparaison",
      status: "ok",
      detail: "Comparables filtrés sur une surface proche.",
      action: "Relire les transactions retenues avant validation finale.",
    };
  }
  if (
    estimate.comparableMode === "nearby_type_only" ||
    estimate.comparableMode === "same_type_expanded"
  ) {
    return {
      key: "comparable_mode",
      label: "Mode de comparaison",
      status: "watch",
      detail: "Type proche, fenêtre surface élargie.",
      action: "Vérifier l'écart de surface et ajuster le prix/m² si nécessaire.",
    };
  }
  return {
    key: "comparable_mode",
    label: "Mode de comparaison",
    status: "risk",
    detail: "Historique exact d'adresse utilisé faute de comparables proches.",
    action: "Chercher des références additionnelles sur un périmètre comparable.",
  };
}

function surfaceCheckpoint({
  marketEstimate,
  surfaceM2,
}: {
  marketEstimate: MarketEstimate;
  surfaceM2: number | null;
}): ValuationCheckpoint {
  if (!surfaceM2 || !marketEstimate.surfaceMinM2 || !marketEstimate.surfaceMaxM2) {
    return {
      key: "surface_window",
      label: "Fenêtre de surface",
      status: "missing",
      detail: "Surface du bien ou fenêtre DVF incomplète.",
      action: "Confirmer la surface Carrez/habitable avant d'utiliser le prix/m².",
    };
  }
  if (surfaceM2 >= marketEstimate.surfaceMinM2 && surfaceM2 <= marketEstimate.surfaceMaxM2) {
    return {
      key: "surface_window",
      label: "Fenêtre de surface",
      status: "ok",
      detail: `${Math.round(surfaceM2)} m² dans la fenêtre ${marketEstimate.surfaceMinM2}-${marketEstimate.surfaceMaxM2} m².`,
      action: "Conserver la fenêtre de comparables retenue.",
    };
  }
  return {
    key: "surface_window",
    label: "Fenêtre de surface",
    status: "watch",
    detail: `${Math.round(surfaceM2)} m² hors fenêtre ${marketEstimate.surfaceMinM2}-${marketEstimate.surfaceMaxM2} m².`,
    action: "Recalculer une référence adaptée à la surface réelle.",
  };
}

function radiusCheckpoint(estimate: MarketEstimate): ValuationCheckpoint {
  if (estimate.radiusM <= 500) {
    return {
      key: "radius",
      label: "Rayon de marché",
      status: "ok",
      detail: `Rayon ${estimate.radiusM} m.`,
      action: "Le périmètre reste local ; relire les adresses retenues.",
    };
  }
  if (estimate.radiusM <= 1500) {
    return {
      key: "radius",
      label: "Rayon de marché",
      status: "watch",
      detail: `Rayon ${estimate.radiusM} m, périmètre élargi.`,
      action: "Vérifier l'homogénéité des quartiers comparés.",
    };
  }
  return {
    key: "radius",
    label: "Rayon de marché",
    status: "risk",
    detail: `Rayon ${estimate.radiusM} m, référence très élargie.`,
    action: "Éviter de retenir la médiane sans recoupement local.",
  };
}

function outlierCheckpoint(estimate: MarketEstimate): ValuationCheckpoint {
  const total = estimate.outliersRemoved + estimate.sampleSize;
  const ratio = total > 0 ? (estimate.outliersRemoved / total) * 100 : 0;
  if (ratio <= 20) {
    return {
      key: "outliers",
      label: "Valeurs écartées",
      status: "ok",
      detail: `${estimate.outliersRemoved} valeur(s) écartée(s).`,
      action: "Contrôler les extrêmes seulement si la stratégie dépend du haut de fourchette.",
    };
  }
  if (ratio <= 40) {
    return {
      key: "outliers",
      label: "Valeurs écartées",
      status: "watch",
      detail: `${Math.round(ratio)} % de valeurs écartées.`,
      action: "Relire les extrêmes pour comprendre la dispersion du marché.",
    };
  }
  return {
    key: "outliers",
    label: "Valeurs écartées",
    status: "risk",
    detail: `${Math.round(ratio)} % de valeurs écartées, marché dispersé.`,
    action: "Augmenter la décote de sécurité ou segmenter le périmètre.",
  };
}

function discountCheckpoint({
  sale,
  surfaceM2,
  marketEstimate,
}: {
  sale: AuctionSale;
  surfaceM2: number | null;
  marketEstimate: MarketEstimate;
}): ValuationCheckpoint {
  const deviationPct = computedDeviationPct({ sale, surfaceM2, marketEstimate });
  if (deviationPct == null) {
    return {
      key: "deviation",
      label: "Décote vs marché",
      status: "missing",
      detail: "Mise à prix, surface ou médiane incomplète.",
      action: "Compléter ces données avant de qualifier la décote apparente.",
    };
  }
  if (deviationPct <= -25) {
    return {
      key: "deviation",
      label: "Décote vs marché",
      status: "ok",
      detail: `${Math.round(Math.abs(deviationPct))} % sous la médiane DVF.`,
      action: "Tester le plafond avec frais, travaux et concurrence d'audience.",
    };
  }
  if (deviationPct <= 10) {
    return {
      key: "deviation",
      label: "Décote vs marché",
      status: "watch",
      detail:
        deviationPct < 0
          ? `${Math.round(Math.abs(deviationPct))} % sous la médiane DVF.`
          : `${Math.round(deviationPct)} % au-dessus de la médiane DVF.`,
      action: "Ne valider l'opportunité qu'après chiffrage complet des coûts.",
    };
  }
  return {
    key: "deviation",
    label: "Décote vs marché",
    status: "risk",
    detail: `${Math.round(deviationPct)} % au-dessus de la médiane DVF.`,
    action: "Revoir la stratégie : la mise à prix ne présente pas de décote apparente.",
  };
}

function warningsCheckpoint(estimate: MarketEstimate): ValuationCheckpoint {
  if (!estimate.qualityWarnings.length) {
    return {
      key: "warnings",
      label: "Avertissements qualité",
      status: "ok",
      detail: "Aucun avertissement qualité signalé par le moteur.",
      action: "Conserver les limites générales DVF dans le rapport.",
    };
  }
  return {
    key: "warnings",
    label: "Avertissements qualité",
    status: estimate.qualityWarnings.length > 2 ? "risk" : "watch",
    detail: estimate.qualityWarnings.slice(0, 3).join(" · "),
    action: "Relire les avertissements avant d'utiliser la médiane comme valeur cible.",
  };
}

function computedDeviationPct({
  sale,
  surfaceM2,
  marketEstimate,
}: {
  sale: AuctionSale;
  surfaceM2: number | null;
  marketEstimate: MarketEstimate;
}): number | null {
  if (
    typeof marketEstimate.deviationPct === "number" &&
    Number.isFinite(marketEstimate.deviationPct)
  ) {
    return marketEstimate.deviationPct;
  }
  if (!sale.starting_price_eur || !surfaceM2 || !marketEstimate.medianPricePerM2) return null;
  const startPerM2 = sale.starting_price_eur / surfaceM2;
  return ((startPerM2 - marketEstimate.medianPricePerM2) / marketEstimate.medianPricePerM2) * 100;
}

function scoreFromCheckpoints(checkpoints: ValuationCheckpoint[]): number {
  const penalties: Record<ValuationCheckpointStatus, number> = {
    ok: 0,
    watch: 8,
    risk: 18,
    missing: 15,
  };
  const score =
    100 - checkpoints.reduce((sum, checkpoint) => sum + penalties[checkpoint.status], 0);
  return Math.max(0, Math.min(100, score));
}

function statusFromScore(score: number): ValuationAuditStatus {
  if (score >= 82) return "robust";
  if (score >= 62) return "usable";
  return "fragile";
}

function confidenceLabel(status: ValuationAuditStatus): string {
  if (status === "robust") return "Estimation robuste pour cadrer le plafond";
  if (status === "usable") return "Estimation exploitable avec marge de prudence";
  if (status === "fragile") return "Estimation fragile à recouper";
  return "Estimation à construire";
}

function summary({
  status,
  score,
  checkpoints,
}: {
  status: ValuationAuditStatus;
  score: number;
  checkpoints: ValuationCheckpoint[];
}): string {
  const flagged = checkpoints.filter(
    (checkpoint) =>
      checkpoint.status === "watch" ||
      checkpoint.status === "risk" ||
      checkpoint.status === "missing",
  ).length;
  return `${confidenceLabel(status)} · score ${score}/100 · ${flagged} point(s) à surveiller.`;
}

function decisionImpact(status: ValuationAuditStatus): string {
  if (status === "robust") {
    return "La médiane DVF peut cadrer le scénario, en gardant une marge pour frais, travaux et audience.";
  }
  if (status === "usable") {
    return "Utiliser la médiane comme repère, mais appliquer une décote de prudence avant le plafond.";
  }
  if (status === "fragile") {
    return "Ne pas fonder le plafond uniquement sur cette fourchette : recouper avec d'autres références.";
  }
  return "Le plafond doit rester manuel tant que l'estimation manque.";
}

function nextActions(checkpoints: ValuationCheckpoint[]): string[] {
  const priority = checkpoints
    .filter((checkpoint) => checkpoint.status !== "ok")
    .map((checkpoint) => checkpoint.action);
  const fallback = checkpoints.map((checkpoint) => checkpoint.action);
  return dedupeStrings([
    ...(priority.length ? priority : fallback),
    "Documenter les limites DVF dans le rapport partagé.",
  ]).slice(0, 5);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
