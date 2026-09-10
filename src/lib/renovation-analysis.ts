import type { AuctionSale, SaleRisk } from "@/lib/types";

export type RenovationConditionStatus =
  | "good"
  | "light_refresh"
  | "works_to_budget"
  | "heavy_works"
  | "unknown";

export type RenovationPriority = "low" | "medium" | "high" | "unknown";
export type RenovationBudgetLevel = "none" | "light" | "standard" | "heavy" | "unknown";

export type RenovationEvidence = {
  label: string;
  status: Exclude<RenovationConditionStatus, "unknown">;
  source: string;
  excerpt: string;
};

export type RenovationBudgetRange = {
  lowEur: number | null;
  highEur: number | null;
  lowPerM2: number;
  highPerM2: number;
  surfaceM2: number | null;
};

export type RenovationAnalysis = {
  available: boolean;
  status: RenovationConditionStatus;
  label: string;
  priority: RenovationPriority;
  priorityLabel: string;
  budgetLevel: RenovationBudgetLevel;
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  budgetRange: RenovationBudgetRange | null;
  evidence: RenovationEvidence[];
  sources: string[];
  summary: string;
  decisionImpact: string;
  nextActions: string[];
  limitations: string[];
};

type TextCandidate = {
  text: string;
  source: string;
};

const WORKS_KEY =
  /travaux|renov|rénov|rafraich|rafraîch|etat|état|diagnostic|descriptif|budget|toiture|structure|humidite|humidité|degradation|dégradation/i;

const GOOD_PATTERNS = [
  /\bbon etat\b/,
  /\btres bon etat\b/,
  /\bexcellent etat\b/,
  /\baucun travaux\b/,
  /\bsans travaux\b/,
  /\brenove\b/,
  /\brefait a neuf\b/,
  /\bneuf\b/,
  /\brecent\b/,
];

const LIGHT_PATTERNS = [
  /\brafraichissement\b/,
  /\brafraichir\b/,
  /\bpeinture(?:s)?\b/,
  /\bsols? a reprendre\b/,
  /\bembellissement\b/,
  /\bremise en peinture\b/,
  /\bpetits travaux\b/,
  /\btravaux legers\b/,
];

const MEDIUM_PATTERNS = [
  /\btravaux a prevoir\b/,
  /\ba renover\b/,
  /\brenovation\b/,
  /\betat moyen\b/,
  /\bremise en etat\b/,
  /\belectricite a reprendre\b/,
  /\bplomberie a reprendre\b/,
  /\bcuisine a refaire\b/,
  /\bsalle d eau a refaire\b/,
  /\bsalle de bain a refaire\b/,
  /\bisolation a reprendre\b/,
  /\bventilation a (?:controler|reprendre|verifier)\b/,
];

const HEAVY_PATTERNS = [
  /\bgros travaux\b/,
  /\blourds travaux\b/,
  /\brehabilitation complete\b/,
  /\bimmeuble a rehabiliter\b/,
  /\binhabitable\b/,
  /\binsalubre\b/,
  /\bperil\b/,
  /\bruine\b/,
  /\bsinistre\b/,
  /\btoiture a (?:reprendre|refaire)\b/,
  /\bstructure a reprendre\b/,
  /\bfissures? importantes?\b/,
  /\bhumidite importante\b/,
  /\bdegradation(?:s)? importante(?:s)?\b/,
  /\bdesamiantage\b/,
];

export function buildRenovationAnalysis({
  sale,
  surfaceM2,
}: {
  sale: AuctionSale;
  surfaceM2: number | null;
}): RenovationAnalysis {
  const candidates = collectTextCandidates(sale);
  const evidence = dedupeEvidence(collectEvidence(candidates)).slice(0, 8);
  const status = resolveStatus(evidence);
  const sources = [...new Set(evidence.map((item) => item.source))].slice(0, 8);
  const priority = priorityForStatus(status);
  const budgetLevel = budgetLevelForStatus(status);
  const confidence = confidenceForEvidence(evidence);
  const budgetRange = budgetRangeForStatus({ status, surfaceM2 });

  return {
    available: evidence.length > 0,
    status,
    label: statusLabel(status),
    priority,
    priorityLabel: priorityLabel(priority),
    budgetLevel,
    confidence,
    confidenceLabel: confidenceLabel({ status, confidence, evidence }),
    budgetRange,
    evidence,
    sources,
    summary: summary({ status, evidence, budgetRange }),
    decisionImpact: decisionImpact({ status, budgetRange }),
    nextActions: nextActions({ status, budgetRange }),
    limitations: limitations(status),
  };
}

function collectEvidence(candidates: TextCandidate[]): RenovationEvidence[] {
  const evidence: RenovationEvidence[] = [];
  for (const candidate of candidates) {
    const status = detectStatus(candidate.text);
    if (!status) continue;
    evidence.push({
      status,
      label: statusLabel(status),
      source: candidate.source,
      excerpt: excerpt(candidate.text),
    });
  }
  return evidence;
}

function detectStatus(value: string): RenovationEvidence["status"] | null {
  const text = normalizeText(value);
  const riskText = text.replace(/\b(?:sans|aucun) travaux(?: a prevoir)?\b/g, "");
  if (HEAVY_PATTERNS.some((pattern) => pattern.test(riskText))) return "heavy_works";
  if (MEDIUM_PATTERNS.some((pattern) => pattern.test(riskText))) return "works_to_budget";
  if (LIGHT_PATTERNS.some((pattern) => pattern.test(riskText))) return "light_refresh";
  if (GOOD_PATTERNS.some((pattern) => pattern.test(text))) return "good";
  return null;
}

function resolveStatus(evidence: RenovationEvidence[]): RenovationConditionStatus {
  const statuses = new Set(evidence.map((item) => item.status));
  if (statuses.has("heavy_works")) return "heavy_works";
  if (statuses.has("works_to_budget")) return "works_to_budget";
  if (statuses.has("light_refresh")) return "light_refresh";
  if (statuses.has("good")) return "good";
  return "unknown";
}

function priorityForStatus(status: RenovationConditionStatus): RenovationPriority {
  if (status === "heavy_works") return "high";
  if (status === "works_to_budget" || status === "light_refresh") return "medium";
  if (status === "good") return "low";
  return "unknown";
}

function budgetLevelForStatus(status: RenovationConditionStatus): RenovationBudgetLevel {
  if (status === "heavy_works") return "heavy";
  if (status === "works_to_budget") return "standard";
  if (status === "light_refresh") return "light";
  if (status === "good") return "none";
  return "unknown";
}

function confidenceForEvidence(evidence: RenovationEvidence[]): RenovationAnalysis["confidence"] {
  if (!evidence.length) return "low";
  // Distinct field labels may repeat the same publication; independence is not established.
  return "medium";
}

function budgetRangeForStatus({
  status,
  surfaceM2,
}: {
  status: RenovationConditionStatus;
  surfaceM2: number | null;
}): RenovationBudgetRange | null {
  const perM2 = perM2Range(status);
  if (!perM2) return null;
  const surface = typeof surfaceM2 === "number" && Number.isFinite(surfaceM2) && surfaceM2 > 0;
  return {
    lowPerM2: perM2.low,
    highPerM2: perM2.high,
    lowEur: surface ? Math.round(surfaceM2 * perM2.low) : null,
    highEur: surface ? Math.round(surfaceM2 * perM2.high) : null,
    surfaceM2: surface ? surfaceM2 : null,
  };
}

function perM2Range(status: RenovationConditionStatus): { low: number; high: number } | null {
  if (status === "good") return { low: 0, high: 120 };
  if (status === "light_refresh") return { low: 150, high: 350 };
  if (status === "works_to_budget") return { low: 350, high: 800 };
  if (status === "heavy_works") return { low: 800, high: 1500 };
  return null;
}

function statusLabel(status: RenovationConditionStatus): string {
  const labels: Record<RenovationConditionStatus, string> = {
    good: "État favorable",
    light_refresh: "Rafraîchissement à prévoir",
    works_to_budget: "Travaux à chiffrer",
    heavy_works: "Travaux lourds à arbitrer",
    unknown: "État à qualifier",
  };
  return labels[status];
}

function priorityLabel(priority: RenovationPriority): string {
  const labels: Record<RenovationPriority, string> = {
    low: "Faible",
    medium: "À chiffrer",
    high: "Prioritaire",
    unknown: "À qualifier",
  };
  return labels[priority];
}

function confidenceLabel({
  status,
  confidence,
  evidence,
}: {
  status: RenovationConditionStatus;
  confidence: RenovationAnalysis["confidence"];
  evidence: RenovationEvidence[];
}): string {
  if (status === "unknown") return "Aucun indice travaux exploitable";
  if (confidence === "high") return "Indices concordants, état à confirmer";
  if (confidence === "medium") return "Indice travaux repéré, à confirmer";
  if (evidence.length) return "Signal faible";
  return "À rechercher dans le PV descriptif";
}

function summary({
  status,
  evidence,
  budgetRange,
}: {
  status: RenovationConditionStatus;
  evidence: RenovationEvidence[];
  budgetRange: RenovationBudgetRange | null;
}): string {
  const parts = [statusLabel(status)];
  if (budgetRange) parts.push(formatBudgetRange(budgetRange));
  if (evidence.length) parts.push(`${evidence.length} indice(s)`);
  return `${parts.join(" · ")}.`;
}

function decisionImpact({
  status,
  budgetRange,
}: {
  status: RenovationConditionStatus;
  budgetRange: RenovationBudgetRange | null;
}): string {
  if (status === "heavy_works") {
    return "Ne pas fixer la mise maximale sans devis ou visite technique : le coût complet peut absorber toute la décote.";
  }
  if (status === "works_to_budget") {
    return "Transformer les travaux repérés en enveloppe basse, médiane et haute avant stratégie d'enchère.";
  }
  if (status === "light_refresh") {
    return "Intégrer une enveloppe de remise en état dans le plafond, même si le signal reste modéré.";
  }
  if (status === "good") {
    return "Signal favorable, mais une marge de sécurité reste nécessaire tant que le PV complet n'est pas relu.";
  }
  return budgetRange
    ? "Budget indicatif à confronter aux pièces avant audience."
    : "État insuffisamment qualifié : prévoir une marge de sécurité dans la mise maximale.";
}

function nextActions({
  status,
  budgetRange,
}: {
  status: RenovationConditionStatus;
  budgetRange: RenovationBudgetRange | null;
}): string[] {
  const actions = [
    "Relire le PV descriptif, les diagnostics et les photos pour isoler les postes de travaux.",
  ];
  if (status === "heavy_works") {
    actions.push(
      "Demander un avis technique ou un chiffrage artisan avant toute enchère offensive.",
    );
  } else if (status === "works_to_budget" || status === "light_refresh") {
    actions.push("Reporter l'enveloppe travaux dans le calcul de mise maximale.");
  } else if (status === "good") {
    actions.push(
      "Conserver une marge de sécurité pour les défauts non visibles ou non documentés.",
    );
  } else {
    actions.push(
      "Ajouter une hypothèse prudente de travaux tant que l'état réel n'est pas confirmé.",
    );
  }
  if (budgetRange?.lowEur != null && budgetRange.highEur != null) {
    actions.push(`Tester le plafond avec ${formatBudgetRange(budgetRange)}.`);
  }
  actions.push("Vérifier si l'occupation empêche l'accès, la visite ou le démarrage des travaux.");
  return actions.slice(0, 4);
}

function limitations(status: RenovationConditionStatus): string[] {
  const items = [
    "La fourchette travaux est une hypothèse indicative au m², pas un devis ni une expertise technique.",
    "Les sources judiciaires peuvent décrire imparfaitement l'état réel du bien au jour de l'audience.",
  ];
  if (status === "unknown") {
    items.unshift("Aucun état fiable n'est encore structuré dans les données exploitées.");
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
    if (WORKS_KEY.test(item.path) || hasRenovationText(item.value)) {
      addCandidate(candidates, `${item.path}: ${cleanText(item.value)}`, "Données source");
    }
  }

  for (const [sourceName, blocks] of Object.entries(sale.source_blocks_by_source ?? {})) {
    for (const item of flattenKeyValues(blocks)) {
      if (WORKS_KEY.test(item.path) || hasRenovationText(item.value)) {
        addCandidate(
          candidates,
          `${item.path}: ${cleanText(item.value)}`,
          `Données source ${sourceName}`,
        );
      }
    }
  }

  for (const document of sale.documents_rich ?? []) {
    addCandidate(
      candidates,
      `${document.type ?? ""} ${document.document_type ?? ""} ${document.label ?? ""}`,
      "Pièces du dossier",
    );
  }

  for (const risk of sale.risks ?? []) {
    for (const text of riskTexts(risk)) addCandidate(candidates, text, "Preuves de risques");
  }

  return candidates.filter((candidate) => hasRenovationText(candidate.text));
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

function hasRenovationText(value: unknown): boolean {
  const text = cleanText(value);
  return Boolean(text && detectStatus(text));
}

function addCandidate(candidates: TextCandidate[], value: unknown, source: string) {
  const text = cleanText(value);
  if (text) candidates.push({ text, source });
}

function dedupeEvidence(evidence: RenovationEvidence[]): RenovationEvidence[] {
  const byKey = new Map<string, RenovationEvidence>();
  for (const item of evidence) {
    const key = `${item.status}-${normalizeText(item.excerpt)}-${item.source}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
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
  return text.length > 180 ? `${text.slice(0, 177).trim()}...` : text;
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

function formatBudgetRange(range: RenovationBudgetRange): string {
  if (range.lowEur != null && range.highEur != null) {
    return `${formatPrice(range.lowEur)} à ${formatPrice(range.highEur)}`;
  }
  return `${range.lowPerM2} à ${range.highPerM2} €/m²`;
}

function formatPrice(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value)} €`;
}
