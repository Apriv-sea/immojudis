import type { EnvironmentalContext } from "@/lib/environment.functions";
import type { MarketEstimate } from "@/lib/market.functions";
import type { NearbyServicesAnalysis } from "@/lib/nearby-services";
import type { StreetFacadeAnalysis } from "@/lib/street-facade-analysis";
import type { AuctionSale, SaleRisk } from "@/lib/types";

export type NeighborhoodStatus = "profiled" | "market_only" | "location_only" | "missing";
export type NeighborhoodSignalKind = "market" | "services" | "street" | "environment" | "source";
export type NeighborhoodSignalStatus = "positive" | "watch" | "to_enrich";

export type NeighborhoodSignal = {
  kind: NeighborhoodSignalKind;
  label: string;
  status: NeighborhoodSignalStatus;
  source: string;
  detail: string;
};

export type NeighborhoodAnalysis = {
  available: boolean;
  status: NeighborhoodStatus;
  label: string;
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  dimensions: string[];
  marketPositionLabel: string;
  serviceCoverageLabel: string;
  locationQualityLabel: string;
  signals: NeighborhoodSignal[];
  summary: string;
  decisionImpact: string;
  nextActions: string[];
  limitations: string[];
};

type TextCandidate = {
  text: string;
  source: string;
};

const NEIGHBORHOOD_KEY =
  /quartier|secteur|environnement|proximite|proximité|commerce|transport|calme|nuisance|bruit|rue|centre|parc|ecole|école|gare|tram|bus|stationnement/i;

const POSITIVE_PATTERNS = [
  /\bcalme\b/,
  /\brecherche\b/,
  /\bprise\b/,
  /\bproche (?:des |du |de la |de l )?(?:commerces|transports|ecoles|ecole|centre|gare|tram|bus|parc|jardin)\b/,
  /\bproche (?:du |de la |de l )?tribunal\b/,
  /\ba proximite (?:des |du |de la |de l )?(?:commerces|transports|ecoles|ecole|centre|gare|tram|bus|parc|jardin|tribunal)\b/,
  /\ba deux pas\b/,
  /\bjardin public\b/,
  /\bcentre[- ]ville\b/,
  /\bcommerces? a proximite\b/,
  /\btransports? a proximite\b/,
  /\bquartier residentiel\b/,
  /\bbonne desserte\b/,
];

const WATCH_PATTERNS = [
  /\bbruit\b/,
  /\bbruyant\b/,
  /\bnuisance(?:s)?\b/,
  /\broute passante\b/,
  /\baxe passant\b/,
  /\bvoie ferree\b/,
  /\bvis[- ]a[- ]vis\b/,
  /\bisole\b/,
  /\beloigne\b/,
  /\bstationnement difficile\b/,
  /\bquartier a verifier\b/,
];

export function buildNeighborhoodAnalysis({
  sale,
  marketEstimate,
  nearbyServices,
  streetFacade,
  environmentalContext,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  nearbyServices: NearbyServicesAnalysis;
  streetFacade: StreetFacadeAnalysis;
  environmentalContext?: EnvironmentalContext | null;
}): NeighborhoodAnalysis {
  const sourceSignals = collectSourceSignals(sale);
  const signals = [
    marketSignal(marketEstimate),
    servicesSignal(nearbyServices),
    streetSignal(streetFacade),
    environmentSignal(environmentalContext ?? null),
    ...sourceSignals,
  ].filter((signal): signal is NeighborhoodSignal => Boolean(signal));
  const dimensions = resolveDimensions({
    marketEstimate,
    nearbyServices,
    streetFacade,
    environmentalContext: environmentalContext ?? null,
    sourceSignals,
  });
  const status = resolveStatus({
    dimensions,
    marketEstimate,
    hasLocation: streetFacade.available || nearbyServices.available,
  });
  const confidence = resolveConfidence({
    dimensions,
    marketEstimate,
    nearbyServices,
    streetFacade,
  });

  return {
    available: status !== "missing",
    status,
    label: statusLabel(status),
    confidence,
    confidenceLabel: confidenceLabel({ status, confidence }),
    dimensions,
    marketPositionLabel: marketPositionLabel(marketEstimate),
    serviceCoverageLabel: serviceCoverageLabel(nearbyServices),
    locationQualityLabel: locationQualityLabel(streetFacade),
    signals: signals.slice(0, 10),
    summary: summary({ status, dimensions, signals }),
    decisionImpact: decisionImpact(status),
    nextActions: nextActions({ status, marketEstimate, nearbyServices, streetFacade }),
    limitations: limitations(status),
  };
}

function resolveDimensions({
  marketEstimate,
  nearbyServices,
  environmentalContext,
  sourceSignals,
}: {
  marketEstimate: MarketEstimate | null;
  nearbyServices: NearbyServicesAnalysis;
  streetFacade: StreetFacadeAnalysis;
  environmentalContext: EnvironmentalContext | null;
  sourceSignals: NeighborhoodSignal[];
}): string[] {
  const dimensions: string[] = [];
  if (marketEstimate) dimensions.push("Marché DVF");
  if (nearbyServices.mentionedCategories.length) dimensions.push("Services mentionnés");
  if (environmentalContext) dimensions.push("Environnement");
  if (sourceSignals.length) dimensions.push("Signaux source");
  return dimensions;
}

function resolveStatus({
  dimensions,
  marketEstimate,
  hasLocation,
}: {
  dimensions: string[];
  marketEstimate: MarketEstimate | null;
  hasLocation: boolean;
}): NeighborhoodStatus {
  if (dimensions.length >= 2) return "profiled";
  if (marketEstimate) return "market_only";
  if (dimensions.length === 1 || hasLocation) return "location_only";
  return "missing";
}

function resolveConfidence({
  dimensions,
  marketEstimate,
}: {
  dimensions: string[];
  marketEstimate: MarketEstimate | null;
  nearbyServices: NearbyServicesAnalysis;
  streetFacade: StreetFacadeAnalysis;
}): NeighborhoodAnalysis["confidence"] {
  if (dimensions.length >= 2 || marketEstimate) return "medium";
  return "low";
}

function marketSignal(marketEstimate: MarketEstimate | null): NeighborhoodSignal | null {
  if (!marketEstimate) return null;
  const parts = [
    `${marketEstimate.sampleSize} vente(s) comparable(s)`,
    marketEstimate.radiusM ? `rayon ${marketEstimate.radiusM} m` : null,
    marketEstimate.medianPricePerM2
      ? `${formatNumber(marketEstimate.medianPricePerM2)} €/m²`
      : null,
    `qualité ${marketEstimate.qualityLabel}`,
  ].filter(Boolean);
  return {
    kind: "market",
    label: "Marché local",
    status: marketEstimate.qualityLabel === "fragile" ? "to_enrich" : "positive",
    source: marketEstimate.source,
    detail: parts.join(" · "),
  };
}

function servicesSignal(nearbyServices: NearbyServicesAnalysis): NeighborhoodSignal | null {
  if (!nearbyServices.available) return null;
  return {
    kind: "services",
    label: "Services de proximité",
    status: nearbyServices.mentionedCategories.length ? "positive" : "to_enrich",
    source: nearbyServices.source,
    detail: nearbyServices.summary,
  };
}

function streetSignal(streetFacade: StreetFacadeAnalysis): NeighborhoodSignal | null {
  if (!streetFacade.available) return null;
  return {
    kind: "street",
    label: "Façade et rue",
    status: "to_enrich",
    source: "Localisation annonce",
    detail: streetFacade.summary,
  };
}

function environmentSignal(context: EnvironmentalContext | null): NeighborhoodSignal | null {
  if (!context) return null;
  const sunshine = context.sun.avgAnnualSunshineHours;
  const wind = context.weather.avgAnnualWindKmh;
  return {
    kind: "environment",
    label: "Contexte environnemental",
    status: "positive",
    source: context.source,
    detail: [
      context.resolvedAddress.label,
      sunshine != null ? `${formatNumber(sunshine)} h de soleil/an` : null,
      wind != null ? `vent moyen ${formatNumber(wind)} km/h` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function collectSourceSignals(sale: AuctionSale): NeighborhoodSignal[] {
  const candidates = collectTextCandidates(sale);
  const signals: NeighborhoodSignal[] = [];
  for (const candidate of candidates) {
    const status = sourceSignalStatus(candidate.text);
    if (!status) continue;
    signals.push({
      kind: "source",
      label: status === "watch" ? "Point quartier à vérifier" : "Atout quartier",
      status,
      source: candidate.source,
      detail: excerpt(candidate.text),
    });
  }
  return dedupeSignals(signals).slice(0, 4);
}

function sourceSignalStatus(value: string): NeighborhoodSignalStatus | null {
  const text = normalizeText(value);
  if (WATCH_PATTERNS.some((pattern) => pattern.test(text))) return "watch";
  if (POSITIVE_PATTERNS.some((pattern) => pattern.test(text))) return "positive";
  return null;
}

function statusLabel(status: NeighborhoodStatus): string {
  const labels: Record<NeighborhoodStatus, string> = {
    profiled: "Quartier analysé",
    market_only: "Quartier documenté par le marché",
    location_only: "Quartier à enrichir",
    missing: "Quartier non qualifié",
  };
  return labels[status];
}

function confidenceLabel({
  status,
  confidence,
}: {
  status: NeighborhoodStatus;
  confidence: NeighborhoodAnalysis["confidence"];
}): string {
  if (status === "missing") return "Données quartier insuffisantes";
  if (confidence === "high") return "Marché, localisation et services recoupés";
  if (confidence === "medium") return "Quartier partiellement documenté";
  return "Indice faible, à enrichir";
}

function marketPositionLabel(marketEstimate: MarketEstimate | null): string {
  if (!marketEstimate) return "Marché local à calculer";
  return `${marketEstimate.qualityLabel} · ${marketEstimate.sampleSize} vente(s) · ${marketEstimate.radiusM} m`;
}

function serviceCoverageLabel(nearbyServices: NearbyServicesAnalysis): string {
  if (!nearbyServices.available) return "Services à qualifier";
  if (nearbyServices.mentionedCategories.length) {
    return nearbyServices.mentionedCategories.join(", ");
  }
  return nearbyServices.locationQuality === "coordinates"
    ? "Coordonnées prêtes pour mesure POI"
    : "Distances aux services à enrichir";
}

function locationQualityLabel(streetFacade: StreetFacadeAnalysis): string {
  if (streetFacade.status === "coordinates_ready") return "Coordonnées exploitables";
  if (streetFacade.status === "address_only") return "Adresse exploitable";
  return "Localisation à géocoder";
}

function summary({
  status,
  dimensions,
  signals,
}: {
  status: NeighborhoodStatus;
  dimensions: string[];
  signals: NeighborhoodSignal[];
}): string {
  if (status === "missing")
    return "Quartier à qualifier : marché, localisation et services manquent.";
  if (status === "location_only" && !dimensions.length)
    return "Localisation disponible ; quartier et services à qualifier.";
  const watchCount = signals.filter((signal) => signal.status === "watch").length;
  const intro =
    status === "profiled"
      ? `Quartier documenté par ${dimensions.join(", ")}`
      : `Quartier partiellement documenté par ${dimensions.join(", ")}`;
  return watchCount ? `${intro} · ${watchCount} point(s) à vérifier.` : `${intro}.`;
}

function decisionImpact(status: NeighborhoodStatus): string {
  if (status === "profiled") {
    return "Croiser marché, services, façade/rue et signaux source pour ajuster décote, liquidité et stratégie de plafond.";
  }
  if (status === "market_only") {
    return "Le marché local existe, mais il faut compléter l'environnement visible et les services avant décision.";
  }
  if (status === "location_only") {
    return "La localisation donne un premier contexte, mais la liquidité du quartier reste à confirmer par les comparables.";
  }
  return "Ne pas valoriser ou pénaliser le quartier tant que les données locales ne sont pas disponibles.";
}

function nextActions({
  status,
  marketEstimate,
  nearbyServices,
  streetFacade,
}: {
  status: NeighborhoodStatus;
  marketEstimate: MarketEstimate | null;
  nearbyServices: NearbyServicesAnalysis;
  streetFacade: StreetFacadeAnalysis;
}): string[] {
  const actions: string[] = [];
  if (!marketEstimate || marketEstimate.qualityLabel === "fragile") {
    actions.push("Renforcer l'échantillon DVF ou élargir prudemment le rayon de comparables.");
  }
  if (!nearbyServices.mentionedCategories.length) {
    actions.push(
      "Mesurer les distances vers transports, écoles, commerces, santé et espaces verts.",
    );
  }
  if (streetFacade.status !== "coordinates_ready") {
    actions.push("Confirmer les coordonnées avant analyse façade/rue.");
  } else {
    actions.push(
      "Relire la vue 3D Mapbox du quartier pour repérer nuisances, accès et configuration de la rue.",
    );
  }
  if (status === "profiled") {
    actions.push("Reporter les points favorables et défavorables dans le calcul de mise maximale.");
  }
  return actions.slice(0, 4);
}

function limitations(status: NeighborhoodStatus): string[] {
  const items = [
    "L'analyse quartier agrège des signaux disponibles ; elle ne remplace pas une visite ni une étude locale complète.",
    "Les comparables DVF ont un délai de publication et ne captent pas toutes les qualités ou nuisances du secteur.",
  ];
  if (status !== "profiled") {
    items.unshift("Le quartier n'est pas encore recoupé par assez de dimensions indépendantes.");
  }
  return items;
}

function collectTextCandidates(sale: AuctionSale): TextCandidate[] {
  const candidates: TextCandidate[] = [];
  addCandidate(candidates, sale.description, "Description annonce");
  addCandidate(candidates, sale.source_description, "Description source");
  addCandidate(candidates, sale.risk_notes, "Notes de risques");

  // Generated scores and summaries are not independent evidence about the property.

  for (const item of flattenKeyValues(sale.source_blocks ?? {})) {
    if (NEIGHBORHOOD_KEY.test(item.path) || hasNeighborhoodSignal(item.value)) {
      addCandidate(candidates, `${item.path}: ${cleanText(item.value)}`, "Données source");
    }
  }

  for (const [sourceName, blocks] of Object.entries(sale.source_blocks_by_source ?? {})) {
    for (const item of flattenKeyValues(blocks)) {
      if (NEIGHBORHOOD_KEY.test(item.path) || hasNeighborhoodSignal(item.value)) {
        addCandidate(
          candidates,
          `${item.path}: ${cleanText(item.value)}`,
          `Données source ${sourceName}`,
        );
      }
    }
  }

  for (const risk of sale.risks ?? []) {
    for (const text of riskTexts(risk)) addCandidate(candidates, text, "Preuves de risques");
  }

  return candidates.filter((candidate) => hasNeighborhoodSignal(candidate.text));
}

function riskTexts(risk: SaleRisk): string[] {
  const texts: unknown[] = [risk.risk_type, risk.risk_label, risk.evidence];
  const evidence = risk.evidence_json;
  if (evidence && typeof evidence === "object") {
    const record = evidence as Record<string, unknown>;
    texts.push(record.excerpt, record.reasoning, record.why_it_matters, record.next_action);
  }
  for (const occurrence of risk.occurrences ?? []) {
    texts.push(occurrence.document_label, occurrence.document_type, occurrence.excerpt);
  }
  return texts.map(cleanText).filter((text): text is string => Boolean(text));
}

function hasNeighborhoodSignal(value: unknown): boolean {
  const text = cleanText(value);
  return Boolean(text && sourceSignalStatus(text));
}

function addCandidate(candidates: TextCandidate[], value: unknown, source: string) {
  const text = cleanText(value);
  if (text) candidates.push({ text, source });
}

function dedupeSignals(signals: NeighborhoodSignal[]): NeighborhoodSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.status}-${normalizeText(signal.detail)}-${signal.source}`;
    if (seen.has(key)) return false;
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

function formatNumber(value: number): string {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value);
}
