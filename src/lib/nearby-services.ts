import type { AuctionSale } from "@/lib/types";

export type NearbyServiceCategoryKey =
  | "transport"
  | "education"
  | "commerce"
  | "health"
  | "green_space"
  | "administration";

export type NearbyServiceCategory = {
  key: NearbyServiceCategoryKey;
  label: string;
  status: "mentioned" | "to_measure" | "missing";
  evidence: string[];
  sources: string[];
};

export type NearbyServicesAnalysis = {
  available: boolean;
  status: "source_signals" | "geocoded_to_measure" | "location_only" | "missing";
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  locationQuality: "coordinates" | "address" | "commune" | "missing";
  categories: NearbyServiceCategory[];
  mentionedCategories: string[];
  summary: string;
  source: string;
  nextActions: string[];
  limitations: string[];
};

type TextCandidate = {
  text: string;
  source: string;
};

type CategoryDefinition = {
  key: NearbyServiceCategoryKey;
  label: string;
  patterns: RegExp[];
};

const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  {
    key: "transport",
    label: "Transports",
    patterns: [
      /\btram(?:way)?\b/i,
      /\bmetro\b/i,
      /\bbus\b/i,
      /\bgare\b/i,
      /\bstation\b/i,
      /\baeroport\b/i,
      /\btransport(?:s)?\b/i,
    ],
  },
  {
    key: "education",
    label: "Écoles",
    patterns: [
      /\becole(?:s)?\b/i,
      /\bcreche(?:s)?\b/i,
      /\bcollege(?:s)?\b/i,
      /\blycee(?:s)?\b/i,
      /\bcampus\b/i,
      /\buniversite\b/i,
    ],
  },
  {
    key: "commerce",
    label: "Commerces",
    patterns: [
      /\bcommerce(?:s)?\b/i,
      /\bcommercant\b/i,
      /\bmarche\b/i,
      /\bsupermarche\b/i,
      /\bboulangerie\b/i,
      /\brestaurant(?:s)?\b/i,
      /\bcentre[- ]ville\b/i,
    ],
  },
  {
    key: "health",
    label: "Santé",
    patterns: [
      /\bhopital\b/i,
      /\bclinique\b/i,
      /\bpharmacie\b/i,
      /\bmedecin(?:s)?\b/i,
      /\bsante\b/i,
      /\bmedical\b/i,
    ],
  },
  {
    key: "green_space",
    label: "Espaces verts",
    patterns: [
      /\bparc\b/i,
      /\bjardin(?:s)?\b/i,
      /\bespace(?:s)? vert(?:s)?\b/i,
      /\bbois\b/i,
      /\bplage\b/i,
      /\bpromenade\b/i,
    ],
  },
  {
    key: "administration",
    label: "Services publics",
    patterns: [
      /\bmairie\b/i,
      /\btribunal\b/i,
      /\bprefecture\b/i,
      /\bposte\b/i,
      /\bservice(?:s)? public(?:s)?\b/i,
    ],
  },
];

export function buildNearbyServicesAnalysis(sale: AuctionSale): NearbyServicesAnalysis {
  const candidates = collectTextCandidates(sale);
  const locationQuality = resolveLocationQuality(sale);
  const categories = CATEGORY_DEFINITIONS.map((definition) =>
    buildCategory(definition, candidates, locationQuality),
  );
  const mentionedCategories = categories
    .filter((category) => category.status === "mentioned")
    .map((category) => category.label);
  const status = nearbyStatus({ mentionedCategories, locationQuality });
  const confidence = nearbyConfidence({ mentionedCategories, locationQuality });

  return {
    available: status !== "missing",
    status,
    confidence,
    confidenceLabel: nearbyConfidenceLabel({ status, confidence }),
    locationQuality,
    categories,
    mentionedCategories,
    summary: nearbySummary({ mentionedCategories, locationQuality }),
    source: nearbySource(status),
    nextActions: nearbyNextActions({ mentionedCategories, locationQuality }),
    limitations: nearbyLimitations(status),
  };
}

function buildCategory(
  definition: CategoryDefinition,
  candidates: TextCandidate[],
  locationQuality: NearbyServicesAnalysis["locationQuality"],
): NearbyServiceCategory {
  const evidence: string[] = [];
  const sources = new Set<string>();

  for (const candidate of candidates) {
    const normalizedText = normalizeText(candidate.text);
    if (!definition.patterns.some((pattern) => pattern.test(normalizedText))) continue;
    evidence.push(excerpt(candidate.text));
    sources.add(candidate.source);
    if (evidence.length >= 3) break;
  }

  return {
    key: definition.key,
    label: definition.label,
    status: evidence.length
      ? "mentioned"
      : locationQuality !== "missing"
        ? "to_measure"
        : "missing",
    evidence,
    sources: [...sources],
  };
}

function nearbyStatus({
  mentionedCategories,
  locationQuality,
}: {
  mentionedCategories: string[];
  locationQuality: NearbyServicesAnalysis["locationQuality"];
}): NearbyServicesAnalysis["status"] {
  if (mentionedCategories.length) return "source_signals";
  if (locationQuality === "coordinates") return "geocoded_to_measure";
  if (locationQuality === "address" || locationQuality === "commune") return "location_only";
  return "missing";
}

function nearbyConfidence({
  mentionedCategories,
  locationQuality,
}: {
  mentionedCategories: string[];
  locationQuality: NearbyServicesAnalysis["locationQuality"];
}): NearbyServicesAnalysis["confidence"] {
  // Several keywords and coordinates do not independently confirm nearby services.
  if (mentionedCategories.length || locationQuality === "coordinates") return "medium";
  return "low";
}

function nearbyConfidenceLabel({
  status,
  confidence,
}: {
  status: NearbyServicesAnalysis["status"];
  confidence: NearbyServicesAnalysis["confidence"];
}): string {
  if (status === "source_signals" && confidence === "high") {
    return "Signaux de proximité recoupés et bien localisés";
  }
  if (status === "source_signals") return "Signaux de proximité repérés dans les sources";
  if (status === "geocoded_to_measure") return "Coordonnées disponibles, distances à calculer";
  if (status === "location_only") return "Localisation connue, points d'intérêt à mesurer";
  return "Services de proximité non qualifiés";
}

function nearbySummary({
  mentionedCategories,
  locationQuality,
}: {
  mentionedCategories: string[];
  locationQuality: NearbyServicesAnalysis["locationQuality"];
}): string {
  if (mentionedCategories.length) {
    return `${mentionedCategories.length} famille(s) de services repérée(s) : ${mentionedCategories.join(", ")}.`;
  }
  if (locationQuality === "coordinates") {
    return "Bien localisé : distances aux services à vérifier.";
  }
  if (locationQuality === "address" || locationQuality === "commune") {
    return "Localisation disponible : services de proximité à enrichir.";
  }
  return "Localisation insuffisante pour qualifier les services de proximité.";
}

function nearbySource(status: NearbyServicesAnalysis["status"]): string {
  if (status === "source_signals") return "sources collectées et descriptions";
  if (status === "geocoded_to_measure") return "coordonnées du bien";
  if (status === "location_only") return "adresse ou commune";
  return "à connecter à BAN/POI";
}

function nearbyNextActions({
  mentionedCategories,
  locationQuality,
}: {
  mentionedCategories: string[];
  locationQuality: NearbyServicesAnalysis["locationQuality"];
}): string[] {
  const actions: string[] = [];

  if (locationQuality === "coordinates") {
    actions.push(
      "Calculer les distances à pied et en voiture vers écoles, transports, commerces et santé.",
    );
  } else {
    actions.push(
      "Géocoder précisément l'adresse avant de calculer les distances aux points d'intérêt.",
    );
  }

  if (mentionedCategories.length) {
    actions.push(
      "Vérifier les services mentionnés dans une source POI avant de les utiliser dans la décision.",
    );
  } else {
    actions.push(
      "Consulter une carte à jour pour repérer transports, écoles, commerces, santé et espaces verts.",
    );
  }

  actions.push(
    "Contrôler les nuisances locales qui peuvent compenser une bonne proximité apparente.",
  );
  return actions;
}

function nearbyLimitations(status: NearbyServicesAnalysis["status"]): string[] {
  const limitations = [
    "Les mentions de proximité issues des descriptions ne donnent ni distance réelle ni temps de trajet.",
    "Les services locaux doivent être vérifiés dans une source cartographique ou administrative à jour.",
  ];
  if (status !== "source_signals") {
    limitations.unshift(
      "Aucun service de proximité précis n'est encore confirmé par les sources collectées.",
    );
  }
  return limitations;
}

function collectTextCandidates(sale: AuctionSale): TextCandidate[] {
  const candidates: TextCandidate[] = [];
  addCandidate(candidates, sale.source_description ?? sale.description, "Description source");
  const addBlocks = (blocks: unknown, source: string) => {
    for (const item of flattenKeyValues(blocks)) {
      if (
        /(?:^|\.)(?:quartier|neighborhood|proximite|nearby_services|services_proximite)(?:\.|$)/i.test(
          item.path,
        )
      ) {
        addCandidate(candidates, item.value, source);
      }
    }
  };
  addBlocks(sale.source_blocks, "Données source");
  for (const [source, blocks] of Object.entries(sale.source_blocks_by_source ?? {})) {
    addBlocks(blocks, `Données source ${source}`);
  }
  return candidates;
}

function resolveLocationQuality(sale: AuctionSale): NearbyServicesAnalysis["locationQuality"] {
  if (sale.latitude != null && sale.longitude != null) return "coordinates";
  if (cleanText(sale.address)) return "address";
  if (cleanText(sale.city) || cleanText(sale.postal_code)) return "commune";
  return "missing";
}

function addCandidate(candidates: TextCandidate[], value: unknown, source: string) {
  const text = cleanText(value);
  if (!text) return;
  for (const sentence of text.split(/[.!?;\n]+/)) {
    if (
      /\b(?:proche|proximite|deux pas|a cote|distance|a pied)\b|\b\d+\s*(?:m|metres|km|minutes|min)\b/i.test(
        normalizeText(sentence),
      )
    ) {
      candidates.push({ text: sentence.trim(), source });
    }
  }
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
  return text.length > 160 ? `${text.slice(0, 157).trim()}...` : text;
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
  return null;
}
