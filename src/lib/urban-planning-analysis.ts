import type { AuctionSale, SaleDocumentRich, SaleRisk } from "@/lib/types";

export type UrbanPlanningSignalKind =
  | "zoning"
  | "permit"
  | "servitude"
  | "coownership"
  | "usage"
  | "public_record";

export type UrbanPlanningPriority = "high" | "medium" | "low";

export type UrbanPlanningItem = {
  key: string;
  kind: UrbanPlanningSignalKind;
  label: string;
  priority: UrbanPlanningPriority;
  status: "documented" | "to_verify" | "missing";
  source: string;
  detail: string;
  action: string;
};

export type StructuredUrbanPlanningSignal = {
  signalKey: string;
  signalKind: UrbanPlanningSignalKind;
  label: string | null;
  status: "documented" | "to_verify";
  priority: UrbanPlanningPriority | null;
  sourceName: string | null;
  sourceKind: string | null;
  documentUrl: string | null;
  documentLabel: string | null;
  documentType: string | null;
  pageNumber: number | null;
  excerpt: string | null;
  action: string | null;
  confidence: number | null;
  updatedAt?: string | null;
};

export type UrbanPlanningAnalysis = {
  available: boolean;
  status: "documented" | "source_signals" | "missing";
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  items: UrbanPlanningItem[];
  missingChecks: string[];
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
  kind: UrbanPlanningSignalKind;
  label: string;
  priority: UrbanPlanningPriority;
  patterns: RegExp[];
  action: string;
};

const SIGNAL_DEFINITIONS: SignalDefinition[] = [
  {
    kind: "zoning",
    label: "Urbanisme / PLU",
    priority: "medium",
    patterns: [
      /\bplu\b/i,
      /\burbanisme\b/i,
      /\bzonage\b/i,
      /\bzone\s+(?:urbaine|agricole|naturelle|inondable|constructible)\b/i,
      /\bplan local d urbanisme\b/i,
      /\bpreemption\b/i,
      /\bpréemption\b/i,
    ],
    action: "Contrôler le zonage, les droits de préemption et les contraintes d'usage.",
  },
  {
    kind: "permit",
    label: "Permis et autorisations",
    priority: "medium",
    patterns: [
      /\bpermis\b/i,
      /\bdeclaration prealable\b/i,
      /\bdéclaration préalable\b/i,
      /\bautorisation(?:s)? de travaux\b/i,
      /\bconformite\b/i,
      /\bconformité\b/i,
      /\bregularisation\b/i,
      /\brégularisation\b/i,
    ],
    action: "Vérifier les autorisations, déclarations préalables et conformité des travaux.",
  },
  {
    kind: "servitude",
    label: "Servitudes et accès",
    priority: "high",
    patterns: [
      /\bservitude(?:s)?\b/i,
      /\bdroit de passage\b/i,
      /\bacces\b/i,
      /\baccès\b/i,
      /\bmitoyennete\b/i,
      /\bmitoyenneté\b/i,
      /\bindivision\b/i,
      /\benclave\b/i,
    ],
    action: "Qualifier l'impact sur l'accès, l'usage, les travaux et la revente.",
  },
  {
    kind: "coownership",
    label: "Copropriété",
    priority: "medium",
    patterns: [
      /\bcopropriete\b/i,
      /\bcopropriété\b/i,
      /\breglement de copro\b/i,
      /\brèglement de copro\b/i,
      /\bcharges\b/i,
      /\bsyndic\b/i,
      /\btantieme(?:s)?\b/i,
      /\bassembl[ée]e generale\b/i,
    ],
    action: "Relire règlement, charges, travaux votés, tantièmes et impayés éventuels.",
  },
  {
    kind: "usage",
    label: "Usage et destination",
    priority: "medium",
    patterns: [
      /\bdestination\b/i,
      /\busage\b/i,
      /\bhabitation\b/i,
      /\bcommercial\b/i,
      /\bprofessionnel\b/i,
      /\bchangement d usage\b/i,
      /\bchangement de destination\b/i,
    ],
    action: "Confirmer que l'usage envisagé est compatible avec les pièces et règles locales.",
  },
  {
    kind: "public_record",
    label: "Pièces publiques",
    priority: "low",
    patterns: [
      /\bcadastre\b/i,
      /\bplan cadastral\b/i,
      /\bgeoportail\b/i,
      /\bgéoportail\b/i,
      /\bregistre\b/i,
    ],
    action: "Recouper les pièces publiques avec le cahier des conditions et le cadastre.",
  },
];

export function buildUrbanPlanningAnalysis({
  sale,
  documents,
  risks,
  structuredSignals = [],
}: {
  sale: AuctionSale;
  documents: SaleDocumentRich[];
  risks: SaleRisk[];
  structuredSignals?: StructuredUrbanPlanningSignal[];
}): UrbanPlanningAnalysis {
  const candidates = collectTextCandidates({ sale, documents, risks });
  const structuredItems = structuredSignalItems(structuredSignals);
  const detectedItems = SIGNAL_DEFINITIONS.flatMap((definition) =>
    itemsForDefinition(definition, candidates),
  );
  const documentItems = documentEvidenceItems(documents);
  const items = dedupeItems([...structuredItems, ...detectedItems, ...documentItems]).slice(0, 12);
  const missingChecks = missingChecksForItems(items);
  const status = resolveStatus(items);
  const confidence = resolveConfidence(status);

  return {
    available: items.length > 0,
    status,
    confidence,
    confidenceLabel: confidenceLabel(status),
    items,
    missingChecks,
    summary: summary({ items, missingChecks }),
    decisionImpact: decisionImpact(status),
    nextActions: nextActions({ items, missingChecks }),
    limitations: [
      "L'analyse détecte des signaux urbanisme/permis dans les sources collectées ; elle ne remplace pas une consultation PLU ou notariale.",
      "Les servitudes, autorisations et règles de copropriété doivent être confirmées dans les pièces officielles avant enchère.",
    ],
  };
}

function structuredSignalItems(signals: StructuredUrbanPlanningSignal[]): UrbanPlanningItem[] {
  return signals.map((signal): UrbanPlanningItem => {
    const definition = SIGNAL_DEFINITIONS.find((item) => item.kind === signal.signalKind);
    const source =
      cleanText(signal.sourceName) ?? cleanText(signal.documentLabel) ?? "Signal structuré";
    const page = typeof signal.pageNumber === "number" ? ` · page ${signal.pageNumber}` : "";
    return {
      key: `structured_${signal.signalKey}`,
      kind: signal.signalKind,
      label: cleanText(signal.label) ?? definition?.label ?? signal.signalKind,
      priority: signal.priority ?? definition?.priority ?? "medium",
      status: signal.status,
      source: `${source}${page}`,
      detail:
        cleanText(signal.excerpt) ??
        cleanText(signal.documentLabel) ??
        cleanText(signal.documentType) ??
        definition?.label ??
        "Signal urbanisme structuré",
      action:
        cleanText(signal.action) ??
        definition?.action ??
        "Contrôler le point dans les pièces officielles.",
    };
  });
}

function itemsForDefinition(
  definition: SignalDefinition,
  candidates: TextCandidate[],
): UrbanPlanningItem[] {
  return candidates
    .filter((candidate) => matches(definition, candidate.text))
    .slice(0, 3)
    .map((candidate, index) => ({
      key: `${definition.kind}_${index}_${candidate.source}`,
      kind: definition.kind,
      label: definition.label,
      priority: definition.priority,
      status: "to_verify",
      source: candidate.source,
      detail: excerpt(candidate.text),
      action: definition.action,
    }));
}

function documentEvidenceItems(documents: SaleDocumentRich[]): UrbanPlanningItem[] {
  return documents
    .map((document): UrbanPlanningItem | null => {
      const text = `${document.type ?? ""} ${document.document_type ?? ""} ${document.label ?? ""}`;
      const definition = SIGNAL_DEFINITIONS.find((item) => matches(item, text));
      if (!definition) return null;
      return {
        key: `document_${definition.kind}_${document.label ?? document.type ?? ""}`,
        kind: definition.kind,
        label: definition.label,
        priority: definition.priority,
        status: "to_verify",
        source: "Pièces du dossier",
        detail: document.label ?? document.type ?? definition.label,
        action: definition.action,
      };
    })
    .filter((item): item is UrbanPlanningItem => Boolean(item));
}

function matches(definition: SignalDefinition, text: string): boolean {
  const normalized = normalizeText(text);
  return definition.patterns.some((pattern) => pattern.test(normalized));
}

function resolveStatus(items: UrbanPlanningItem[]): UrbanPlanningAnalysis["status"] {
  if (items.some((item) => item.status === "documented")) return "documented";
  if (items.length) return "source_signals";
  return "missing";
}

function resolveConfidence(
  status: UrbanPlanningAnalysis["status"],
): UrbanPlanningAnalysis["confidence"] {
  // A number of mentions is not independent corroboration.
  if (status === "documented") return "medium";
  return "low";
}

function confidenceLabel(status: UrbanPlanningAnalysis["status"]): string {
  if (status === "documented") return "Pièce urbanisme ou contrainte repérée";
  if (status === "source_signals") return "Signaux urbanisme à confirmer";
  return "Urbanisme, permis et servitudes non qualifiés";
}

function missingChecksForItems(items: UrbanPlanningItem[]): string[] {
  const kinds = new Set(items.map((item) => item.kind));
  const missing: string[] = [];
  if (!kinds.has("zoning")) missing.push("Zonage PLU ou règles locales");
  if (!kinds.has("permit")) missing.push("Permis, autorisations ou conformité des travaux");
  if (!kinds.has("servitude")) missing.push("Servitudes, accès et droits de passage");
  if (!kinds.has("coownership")) missing.push("Règlement de copropriété, charges et travaux votés");
  return missing.slice(0, 5);
}

function summary({
  items,
  missingChecks,
}: {
  items: UrbanPlanningItem[];
  missingChecks: string[];
}): string {
  if (!items.length) {
    return "Urbanisme, permis, servitudes et copropriété à vérifier dans les pièces.";
  }
  const labels = [...new Set(items.map((item) => item.label))].slice(0, 4);
  const suffix = missingChecks.length ? ` · ${missingChecks.length} contrôle(s) manquant(s)` : "";
  return `${labels.length} famille(s) repérée(s) : ${labels.join(", ")}${suffix}.`;
}

function decisionImpact(status: UrbanPlanningAnalysis["status"]): string {
  if (status === "documented") {
    return "Transformer les contraintes repérées en impact sur usage, travaux, délai ou revente avant de figer le plafond.";
  }
  if (status === "source_signals") {
    return "Les signaux doivent être confirmés dans les pièces officielles avant d'influencer la stratégie d'enchère.";
  }
  return "Prévoir une réserve tant que zonage, permis, servitudes et copropriété ne sont pas qualifiés.";
}

function nextActions({
  items,
  missingChecks,
}: {
  items: UrbanPlanningItem[];
  missingChecks: string[];
}): string[] {
  const actions = [
    ...items.filter((item) => item.priority === "high").map((item) => item.action),
    ...items.filter((item) => item.priority === "medium").map((item) => item.action),
    ...missingChecks.map((check) => `Contrôler : ${check}.`),
  ];
  if (!actions.length) actions.push("Récupérer les pièces urbanisme, copropriété et cadastre.");
  return dedupeStrings(actions).slice(0, 6);
}

function collectTextCandidates({
  sale,
  documents,
  risks,
}: {
  sale: AuctionSale;
  documents: SaleDocumentRich[];
  risks: SaleRisk[];
}): TextCandidate[] {
  const candidates: TextCandidate[] = [];
  addCandidate(candidates, sale.source_description ?? sale.description, "Description source");

  for (const item of dedicatedSourceFields(sale.source_blocks ?? {})) {
    addCandidate(candidates, `${item.path}: ${cleanText(item.value)}`, "Données source");
  }
  for (const [sourceName, blocks] of Object.entries(sale.source_blocks_by_source ?? {})) {
    for (const item of dedicatedSourceFields(blocks)) {
      addCandidate(
        candidates,
        `${item.path}: ${cleanText(item.value)}`,
        `Données source ${sourceName}`,
      );
    }
  }
  for (const document of documents) {
    addCandidate(
      candidates,
      `${document.type ?? ""} ${document.document_type ?? ""} ${document.label ?? ""}`,
      "Pièces du dossier",
    );
  }
  for (const risk of risks) {
    for (const text of riskTexts(risk)) addCandidate(candidates, text, "Preuves de risques");
  }

  return candidates.filter((candidate) =>
    SIGNAL_DEFINITIONS.some((definition) => matches(definition, candidate.text)),
  );
}

function dedicatedSourceFields(blocks: Record<string, unknown>) {
  return flattenKeyValues(blocks).filter(
    ({ path }) =>
      !/(?:^|\.)(?:page_text|description|sale_procedure|related|similar|autres_annonces)(?:$|\.|\[)/i.test(
        path,
      ) &&
      /plu|urbanisme|zoning|zonage|permit|permis|servitude|coownership|copropriete|copropriété|usage|cadastre/i.test(
        path,
      ),
  );
}

function riskTexts(risk: SaleRisk): string[] {
  const texts: unknown[] = [risk.risk_type, risk.risk_label, risk.evidence];
  const evidence = risk.evidence_json;
  if (evidence && typeof evidence === "object") {
    const record = evidence as Record<string, unknown>;
    texts.push(record.excerpt);
  }
  for (const occurrence of risk.occurrences ?? []) {
    texts.push(occurrence.document_label, occurrence.document_type, occurrence.excerpt);
  }
  return texts.map(cleanText).filter((text): text is string => Boolean(text));
}

function addCandidate(candidates: TextCandidate[], value: unknown, source: string) {
  const text = cleanText(value);
  if (text) candidates.push({ text, source });
}

function dedupeItems(items: UrbanPlanningItem[]): UrbanPlanningItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}-${normalizeText(item.detail)}-${item.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
