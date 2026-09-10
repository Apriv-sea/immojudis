import type { MarketEstimate } from "@/lib/market.functions";
import type { NearbyServicesAnalysis } from "@/lib/nearby-services";
import type { AuctionSale } from "@/lib/types";

export type DemographicSignalKind =
  | "population"
  | "income"
  | "age"
  | "household"
  | "tenure"
  | "student"
  | "rental_demand"
  | "local_services"
  | "market_depth";

export type DemographicSignalStatus = "source_signal" | "proxy";

export type DemographicSignal = {
  key: string;
  kind: DemographicSignalKind;
  label: string;
  status: DemographicSignalStatus;
  source: string;
  detail: string;
  impact: string;
};

export type DemographicAnalysis = {
  available: boolean;
  status: "source_signals" | "market_proxy" | "location_only" | "missing";
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  profileLabel: string;
  demandLabel: string;
  signals: DemographicSignal[];
  missingData: string[];
  summary: string;
  decisionImpact: string;
  nextActions: string[];
  limitations: string[];
};

type TextCandidate = {
  text: string;
  source: string;
};

type SignalDefinition = {
  kind: DemographicSignalKind;
  label: string;
  patterns: RegExp[];
  impact: string;
};

const SIGNAL_DEFINITIONS: SignalDefinition[] = [
  {
    kind: "population",
    label: "Population et dynamique locale",
    patterns: [
      /\bpopulation\b/i,
      /\bhabitant(?:s)?\b/i,
      /\bdemograph/i,
      /\bdémograph/i,
      /\bdensite\b/i,
      /\bdensité\b/i,
    ],
    impact: "Comparer croissance, vacance et liquidité avant de retenir un scénario de sortie.",
  },
  {
    kind: "income",
    label: "Revenus et pouvoir d'achat",
    patterns: [
      /\brevenu(?:s)?\b/i,
      /\bsalaire(?:s)?\b/i,
      /\bpouvoir d achat\b/i,
      /\bcsp\b/i,
      /\bprecarite\b/i,
      /\bprécarité\b/i,
    ],
    impact: "Vérifier la cohérence entre prix cible, loyers possibles et solvabilité locale.",
  },
  {
    kind: "age",
    label: "Âges et profils de ménages",
    patterns: [
      /\bage(?:s)?\b/i,
      /\bâge(?:s)?\b/i,
      /\bjeune(?:s)?\b/i,
      /\bsenior(?:s)?\b/i,
      /\bfamille(?:s)?\b/i,
      /\benfant(?:s)?\b/i,
    ],
    impact: "Adapter le scénario travaux, location ou revente au profil dominant du secteur.",
  },
  {
    kind: "household",
    label: "Ménages",
    patterns: [
      /\bmenage(?:s)?\b/i,
      /\bménage(?:s)?\b/i,
      /\bcouple(?:s)?\b/i,
      /\bpersonne(?:s)? seule(?:s)?\b/i,
      /\bfoyer(?:s)?\b/i,
      /\bcomposition familiale\b/i,
    ],
    impact: "Croiser surface, nombre de pièces et demande locale avant travaux ou relocation.",
  },
  {
    kind: "tenure",
    label: "Locataires / propriétaires",
    patterns: [
      /\b(?:part|proportion|taux|majorite|pourcentage)\s+(?:de\s+|des\s+)?(?:locataires|proprietaires)\b/i,
      /\b\d+(?:[.,]\d+)?\s*%\s+(?:de\s+|des\s+)?(?:locataires|proprietaires)\b/i,
      /\bparc locatif\b/i,
      /\b(?:part|taux|nombre)\s+(?:de\s+|des\s+)?(?:residences principales|logements vacants|vacance)\b/i,
    ],
    impact: "Qualifier tension locative, risque de vacance et profondeur de revente.",
  },
  {
    kind: "student",
    label: "Étudiants / jeunes actifs",
    patterns: [
      /\betudiant(?:s)?\b/i,
      /\bétudiant(?:s)?\b/i,
      /\bcampus\b/i,
      /\buniversite\b/i,
      /\buniversité\b/i,
      /\becole superieure\b/i,
      /\bécole supérieure\b/i,
      /\bjeunes actifs\b/i,
    ],
    impact: "Tester l'adéquation petite surface, colocation, meublé ou revente investisseur.",
  },
  {
    kind: "rental_demand",
    label: "Demande locative",
    patterns: [/\bdemande locative\b/i, /\btension locative\b/i],
    impact: "Recouper loyer, vacance et cible de locataire avant de fixer le plafond.",
  },
];

export function buildDemographicAnalysis({
  sale,
  marketEstimate,
  nearbyServices,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  nearbyServices: NearbyServicesAnalysis;
}): DemographicAnalysis {
  const candidates = collectTextCandidates(sale);
  const sourceSignals = SIGNAL_DEFINITIONS.flatMap((definition) =>
    signalsForDefinition(definition, candidates),
  );
  const proxySignals = buildProxySignals({ marketEstimate, nearbyServices });
  const signals = dedupeSignals([...sourceSignals, ...proxySignals]).slice(0, 12);
  const status = resolveStatus({ sale, sourceSignals, proxySignals });
  const confidence = resolveConfidence({ status, sourceSignals, proxySignals });
  const missingData = missingDataFor(signals);

  return {
    available: status !== "missing",
    status,
    confidence,
    confidenceLabel: confidenceLabel({ status, confidence }),
    profileLabel: profileLabel(signals),
    demandLabel: demandLabel({ status, signals }),
    signals,
    missingData,
    summary: summary({ status, signals }),
    decisionImpact: decisionImpact(status),
    nextActions: nextActions({ status, signals, missingData }),
    limitations: [
      "Cette analyse exploite les signaux disponibles et des proxys de marché ; elle doit être enrichie par des données INSEE/IRIS pour une lecture démographique complète.",
      "Les profils de demande ne constituent pas une garantie de location, de revente ou de plus-value.",
    ],
  };
}

function signalsForDefinition(
  definition: SignalDefinition,
  candidates: TextCandidate[],
): DemographicSignal[] {
  return candidates
    .filter((candidate) => matches(definition, candidate.text))
    .slice(0, 2)
    .map((candidate, index) => ({
      key: `${definition.kind}_${index}_${candidate.source}`,
      kind: definition.kind,
      label: definition.label,
      status: "source_signal",
      source: candidate.source,
      detail: excerpt(candidate.text),
      impact: definition.impact,
    }));
}

function buildProxySignals({
  marketEstimate,
  nearbyServices,
}: {
  marketEstimate: MarketEstimate | null;
  nearbyServices: NearbyServicesAnalysis;
}): DemographicSignal[] {
  const signals: DemographicSignal[] = [];
  const categories = new Set(nearbyServices.mentionedCategories);

  if (categories.has("Écoles")) {
    signals.push({
      key: "proxy_household_education",
      kind: "household",
      label: "Demande familiale potentielle",
      status: "proxy",
      source: "Services de proximité",
      detail: "Écoles ou équipements éducatifs mentionnés autour du bien.",
      impact: "Vérifier si surface, pièces et environnement correspondent à une cible familiale.",
    });
  }
  if (categories.has("Transports") || categories.has("Commerces")) {
    signals.push({
      key: "proxy_rental_mobility",
      kind: "rental_demand",
      label: "Mobilité et demande locative",
      status: "proxy",
      source: "Services de proximité",
      detail: [
        categories.has("Transports") ? "transports" : null,
        categories.has("Commerces") ? "commerces" : null,
      ]
        .filter(Boolean)
        .join(" + "),
      impact:
        "Tester les loyers, la vacance et l'attractivité auprès d'actifs ou locataires mobiles.",
    });
  }
  if (categories.has("Santé")) {
    signals.push({
      key: "proxy_age_health",
      kind: "age",
      label: "Accessibilité santé",
      status: "proxy",
      source: "Services de proximité",
      detail: "Services de santé mentionnés dans l'environnement du bien.",
      impact: "Vérifier l'intérêt pour seniors, familles ou occupants avec besoin d'accessibilité.",
    });
  }

  if (marketEstimate?.sampleSize && marketEstimate.sampleSize >= 5) {
    signals.push({
      key: "proxy_market_depth",
      kind: "market_depth",
      label: "Profondeur de marché",
      status: "proxy",
      source: "DVF / estimation marché",
      detail: `${marketEstimate.sampleSize} comparable(s) retenu(s), qualité ${marketEstimate.qualityLabel}.`,
      impact:
        "Utiliser la densité de transactions comme proxy de liquidité locale, sans remplacer les données de population.",
    });
  }

  return signals;
}

function resolveStatus({
  sale,
  sourceSignals,
  proxySignals,
}: {
  sale: AuctionSale;
  sourceSignals: DemographicSignal[];
  proxySignals: DemographicSignal[];
}): DemographicAnalysis["status"] {
  if (sourceSignals.length) return "source_signals";
  if (proxySignals.length) return "market_proxy";
  if (sale.city || sale.department || sale.postal_code || sale.address) return "location_only";
  return "missing";
}

function resolveConfidence({
  status,
  sourceSignals,
  proxySignals,
}: {
  status: DemographicAnalysis["status"];
  sourceSignals: DemographicSignal[];
  proxySignals: DemographicSignal[];
}): DemographicAnalysis["confidence"] {
  // Several mentions in one listing are not independent demographic corroboration.
  if (sourceSignals.length >= 2 || proxySignals.length >= 2) return "medium";
  if (status === "source_signals" || status === "market_proxy") return "medium";
  return "low";
}

function confidenceLabel({
  status,
  confidence,
}: {
  status: DemographicAnalysis["status"];
  confidence: DemographicAnalysis["confidence"];
}): string {
  if (status === "source_signals" && confidence === "high") {
    return "Signaux démographiques et proxys marché recoupés";
  }
  if (status === "source_signals") return "Signaux démographiques repérés dans les sources";
  if (status === "market_proxy") return "Lecture par proxys marché et services";
  if (status === "location_only") return "Localisation disponible, données INSEE à connecter";
  return "Analyse démographique non qualifiée";
}

function profileLabel(signals: DemographicSignal[]): string {
  const kinds = new Set(signals.map((signal) => signal.kind));
  if (kinds.has("student")) return "Étudiants / jeunes actifs à tester";
  if (kinds.has("household")) return "Profil familial ou ménages à qualifier";
  if (kinds.has("age")) return "Âges et accessibilité à qualifier";
  if (kinds.has("tenure") || kinds.has("rental_demand")) return "Demande locative à qualifier";
  return "Profil local à enrichir";
}

function demandLabel({
  status,
  signals,
}: {
  status: DemographicAnalysis["status"];
  signals: DemographicSignal[];
}): string {
  const rentalSignals = signals.filter((signal) => signal.kind === "rental_demand");
  if (rentalSignals.length) {
    return rentalSignals.some((signal) => signal.status === "source_signal")
      ? "Demande locative signalée"
      : "Demande locative à tester par proxys";
  }
  if (signals.some((signal) => signal.kind === "market_depth")) return "Liquidité locale à mesurer";
  if (status === "location_only") return "Demande locale à enrichir";
  return "Demande non qualifiée";
}

function missingDataFor(signals: DemographicSignal[]): string[] {
  const kinds = new Set(
    signals.filter((signal) => signal.status === "source_signal").map((signal) => signal.kind),
  );
  const missing: string[] = [];
  if (!kinds.has("population")) missing.push("Population, évolution et densité INSEE/commune");
  if (!kinds.has("income")) missing.push("Revenus médians et pouvoir d'achat local");
  if (!kinds.has("age") && !kinds.has("student"))
    missing.push("Âges, étudiants et profils d'occupants");
  if (!kinds.has("household")) missing.push("Composition des ménages et taille des foyers");
  if (!kinds.has("tenure") && !kinds.has("rental_demand")) {
    missing.push("Part locataires/propriétaires, vacance et tension locative");
  }
  return missing.slice(0, 6);
}

function summary({
  status,
  signals,
}: {
  status: DemographicAnalysis["status"];
  signals: DemographicSignal[];
}): string {
  if (status === "source_signals") {
    const labels = [
      ...new Set(
        signals.filter((signal) => signal.status === "source_signal").map((signal) => signal.label),
      ),
    ].slice(0, 4);
    return `Signaux démographiques repérés : ${labels.join(", ")}.${signals.some((signal) => signal.status === "proxy") ? " Indices indirects de marché et de services à vérifier séparément." : ""}`;
  }
  if (status === "market_proxy") {
    const labels = [...new Set(signals.map((signal) => signal.label))].slice(0, 3);
    return `Lecture provisoire par proxys : ${labels.join(", ")}.`;
  }
  if (status === "location_only") {
    return "Localisation connue : données démographiques INSEE/IRIS à connecter.";
  }
  return "Analyse démographique à enrichir : localisation et données locales insuffisantes.";
}

function decisionImpact(status: DemographicAnalysis["status"]): string {
  if (status === "source_signals") {
    return "Vérifier ces mentions avec des données locales datées avant d’ajuster la cible locative ou le plafond.";
  }
  if (status === "market_proxy") {
    return "Traiter les proxys comme indices faibles avant de valider loyer, vacance et revente.";
  }
  return "Ne pas fonder le plafond sur la demande locale tant que les données démographiques ne sont pas enrichies.";
}

function nextActions({
  status,
  signals,
  missingData,
}: {
  status: DemographicAnalysis["status"];
  signals: DemographicSignal[];
  missingData: string[];
}): string[] {
  const actions = signals
    .filter((signal) => signal.status === "source_signal")
    .map((signal) => signal.impact);

  if (status !== "source_signals") {
    actions.push(
      "Brancher les données INSEE commune/IRIS pour objectiver population, revenus et ménages.",
    );
  }
  if (missingData.length) {
    actions.push(`Compléter : ${missingData.slice(0, 3).join(", ")}.`);
  }
  actions.push("Croiser la cible démographique avec le scénario travaux, location ou revente.");

  return dedupeStrings(actions).slice(0, 6);
}

function collectTextCandidates(sale: AuctionSale): TextCandidate[] {
  const candidates: TextCandidate[] = [];
  addCandidate(candidates, sale.source_description ?? sale.description, "Description source");
  for (const item of flattenKeyValues(sale.source_blocks ?? {})) {
    addCandidate(candidates, `${item.path}: ${cleanText(item.value)}`, "Données source");
  }
  for (const [sourceName, blocks] of Object.entries(sale.source_blocks_by_source ?? {})) {
    for (const item of flattenKeyValues(blocks)) {
      addCandidate(
        candidates,
        `${item.path}: ${cleanText(item.value)}`,
        `Données source ${sourceName}`,
      );
    }
  }

  return candidates.filter((candidate) =>
    SIGNAL_DEFINITIONS.some((definition) => matches(definition, candidate.text)),
  );
}

function matches(definition: SignalDefinition, text: string): boolean {
  const normalized = normalizeText(text);
  return definition.patterns.some((pattern) => pattern.test(normalized));
}

function addCandidate(candidates: TextCandidate[], value: unknown, source: string) {
  const text = cleanText(value);
  if (text) candidates.push({ text, source });
}

function dedupeSignals(signals: DemographicSignal[]): DemographicSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.kind}-${signal.status}-${normalizeText(signal.detail)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flattenKeyValues(value: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenPrimitiveOrObject(item, `${path}[${index}]`));
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    flattenPrimitiveOrObject(item, path ? `${path}.${key}` : key),
  );
}

function flattenPrimitiveOrObject(
  value: unknown,
  path: string,
): Array<{ path: string; value: unknown }> {
  if (value && typeof value === "object") return flattenKeyValues(value, path);
  return [{ path, value }];
}

function cleanText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text || null;
  }
  if (Array.isArray(value)) {
    const text = value.map(cleanText).filter(Boolean).join(" ");
    return text || null;
  }
  if (value && typeof value === "object") {
    const text = Object.values(value as Record<string, unknown>)
      .map(cleanText)
      .filter(Boolean)
      .join(" ");
    return text || null;
  }
  return null;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function excerpt(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177).trim()}...` : text;
}
