import { occupancyLabel } from "@/lib/format";
import { listingOccupation } from "@/lib/listing-evidence";
import type { AuctionSale, SaleRisk } from "@/lib/types";

export type OccupancyStatusKind = "free" | "occupied" | "rented" | "to_confirm" | "conflicting";

export type OccupancyEvidence = {
  status: Exclude<OccupancyStatusKind, "conflicting">;
  label: string;
  excerpt: string;
  source: string;
};

export type OccupancyAnalysis = {
  available: boolean;
  status: OccupancyStatusKind;
  label: string;
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  hasLeaseSignal: boolean;
  hasEvictionSignal: boolean;
  evidence: OccupancyEvidence[];
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

const OCCUPANCY_KEY = /occup|occupation|occupancy|bail|locataire|tenant|rented|lease|vacant|libre/i;

const FREE_PATTERNS = [
  /\blibre(?:\s+de\s+toute\s+occupation)?\b/i,
  /\bfree\b/i,
  /\bnon\s+occup(?:e|ee|é|ée)\b/i,
  /\binoccup(?:e|ee|é|ée)\b/i,
  /\bvacant\b/i,
  /\bvide\b/i,
];

const RENTED_PATTERNS = [
  /\blou(?:e|ee|é|ée)\b/i,
  /\blocataire\b/i,
  /\bbail\b/i,
  /\bloyer\b/i,
  /\brented\b/i,
  /\btenant\b/i,
  /\blease\b/i,
];

const OCCUPIED_PATTERNS = [
  /\boccup(?:e|ee|ant|ante|ants|é|ée)\b/i,
  /\bpresence\s+(?:d\s+|de\s+|des\s+)(?:un\s+|une\s+)?(?:occupants?|locataires?|habitants?|personnes?)\b/i,
  /\bhabite\b/i,
  /\bse\s+declarant\s+occupant\b/i,
];

const TO_CONFIRM_PATTERNS = [
  /\ba\s+confirmer\b/i,
  /\bnon\s+(?:renseigne|precise|stabilise|communique)\b/i,
  /\binconnu\b/i,
  /\babsence\s+de\s+bail\b/i,
  /\bbail\s+non\s+(?:produit|communique)\b/i,
];

const EVICTION_PATTERNS = [
  /\bexpulsion\b/i,
  /\bliberation\b/i,
  /\bdelai\s+de\s+sortie\b/i,
  /\bcommandement\s+de\s+quitter\b/i,
  /\bmaintien\s+dans\s+les\s+lieux\b/i,
];

export function buildOccupancyAnalysis(sale: AuctionSale): OccupancyAnalysis {
  const candidates = collectTextCandidates(sale);
  const fieldEvidence = evidenceFromOccupancyStatus(sale.occupancy_status);
  const textEvidence = collectTextEvidence(candidates);
  const allEvidence = dedupeEvidence([...fieldEvidence, ...textEvidence]);
  // Keep each distinct status visible, including contradictions found after the display cap.
  const seenStatuses = new Set<OccupancyEvidence["status"]>();
  const firstByStatus = allEvidence.filter((item) => {
    if (seenStatuses.has(item.status)) return false;
    seenStatuses.add(item.status);
    return true;
  });
  const evidence = [
    ...firstByStatus,
    ...allEvidence.filter((item) => !firstByStatus.includes(item)),
  ].slice(0, 8);
  const atConstat = listingOccupation(sale) === "Inoccupé au constat";
  const resolvedStatus = resolveStatus(allEvidence);
  const status = atConstat && resolvedStatus === "free" ? "to_confirm" : resolvedStatus;
  const sources = [...new Set(evidence.map((item) => item.source))].slice(0, 8);
  const hasLeaseSignal =
    evidence.some((item) => item.status === "rented") || hasPattern(candidates, RENTED_PATTERNS);
  const hasEvictionSignal = hasPattern(candidates, EVICTION_PATTERNS);
  const confidence = resolveConfidence({ status, evidence, fieldEvidence });

  return {
    available: status !== "to_confirm" || evidence.length > 0,
    status,
    label: atConstat && status === "to_confirm" ? "Inoccupé au constat" : statusLabel(status),
    confidence,
    confidenceLabel: confidenceLabel({ status, confidence }),
    hasLeaseSignal,
    hasEvictionSignal,
    evidence,
    sources,
    summary:
      atConstat && status === "to_confirm"
        ? "Inoccupé au constat. La disponibilité actuelle reste à confirmer."
        : summary({ status, evidence, hasLeaseSignal, hasEvictionSignal }),
    decisionImpact: decisionImpact({ status, hasLeaseSignal, hasEvictionSignal }),
    nextActions: nextActions({ status, hasLeaseSignal, hasEvictionSignal }),
    limitations: limitations(status),
  };
}

function evidenceFromOccupancyStatus(status: AuctionSale["occupancy_status"]): OccupancyEvidence[] {
  const normalized = normalizeText(status ?? "");
  if (!normalized || normalized === "unknown" || normalized === "inconnu") {
    return [
      {
        status: "to_confirm",
        label: "Statut non renseigné",
        excerpt: occupancyLabel(status),
        source: "Champ occupation",
      },
    ];
  }
  const detected = detectStatus(normalized);
  return [
    {
      status: detected ?? "to_confirm",
      label: occupancyLabel(status),
      excerpt: occupancyLabel(status),
      source: "Champ occupation",
    },
  ];
}

function collectTextEvidence(candidates: TextCandidate[]): OccupancyEvidence[] {
  const evidence: OccupancyEvidence[] = [];
  for (const candidate of candidates) {
    const detected = detectStatus(candidate.text);
    if (!detected) continue;
    evidence.push({
      status: detected,
      label: statusLabel(detected),
      excerpt: excerpt(candidate.text),
      source: candidate.source,
    });
  }
  return evidence;
}

function detectStatus(value: string): OccupancyEvidence["status"] | null {
  const text = normalizeText(value);
  if (FREE_PATTERNS.some((pattern) => pattern.test(text))) return "free";
  if (TO_CONFIRM_PATTERNS.some((pattern) => pattern.test(text))) return "to_confirm";
  if (RENTED_PATTERNS.some((pattern) => pattern.test(text))) return "rented";
  if (OCCUPIED_PATTERNS.some((pattern) => pattern.test(text))) return "occupied";
  return null;
}

function resolveStatus(evidence: OccupancyEvidence[]): OccupancyStatusKind {
  const statuses = new Set(
    evidence.map((item) => item.status).filter((status) => status !== "to_confirm"),
  );
  if (statuses.has("free") && (statuses.has("rented") || statuses.has("occupied")))
    return "conflicting";
  if (statuses.has("rented")) return "rented";
  if (statuses.has("occupied")) return "occupied";
  if (statuses.has("free")) return "free";
  return "to_confirm";
}

function resolveConfidence({
  status,
  evidence,
  fieldEvidence,
}: {
  status: OccupancyStatusKind;
  evidence: OccupancyEvidence[];
  fieldEvidence: OccupancyEvidence[];
}): OccupancyAnalysis["confidence"] {
  if (status === "conflicting" || status === "to_confirm") return "low";
  const fieldStatus = fieldEvidence[0]?.status;
  const corroboratingSources = new Set(
    evidence.filter((item) => item.status === status).map((item) => item.source),
  );
  // Field labels do not establish independent provenance: several fields may come from one publication.
  if (fieldStatus === status || corroboratingSources.size >= 2) return "medium";
  return "low";
}

function confidenceLabel({
  status,
  confidence,
}: {
  status: OccupancyStatusKind;
  confidence: OccupancyAnalysis["confidence"];
}): string {
  if (status === "conflicting") return "Signaux contradictoires à arbitrer";
  if (status === "to_confirm") return "Occupation à confirmer dans les pièces";
  if (confidence === "high") return "Indices concordants, occupation à confirmer";
  if (confidence === "medium") return "Statut repéré, à confirmer";
  return "Indice faible";
}

function summary({
  status,
  evidence,
  hasLeaseSignal,
  hasEvictionSignal,
}: {
  status: OccupancyStatusKind;
  evidence: OccupancyEvidence[];
  hasLeaseSignal: boolean;
  hasEvictionSignal: boolean;
}): string {
  const parts = [statusLabel(status)];
  if (hasLeaseSignal) parts.push("signal de bail ou loyer");
  if (hasEvictionSignal) parts.push("signal de délai de libération");
  if (evidence.length) parts.push(`${evidence.length} indice(s)`);
  return `${parts.join(" · ")}.`;
}

function decisionImpact({
  status,
  hasLeaseSignal,
  hasEvictionSignal,
}: {
  status: OccupancyStatusKind;
  hasLeaseSignal: boolean;
  hasEvictionSignal: boolean;
}): string {
  if (status === "conflicting") {
    return "Ne pas figer le plafond d'enchère avant arbitrage des pièces contradictoires.";
  }
  if (status === "free") {
    return "Hypothèse favorable pour la jouissance et les travaux, sous réserve de confirmation au PV.";
  }
  if (status === "rented" || hasLeaseSignal) {
    return "Le plafond dépend du bail, du loyer, des impayés éventuels et des conditions de sortie.";
  }
  if (status === "occupied" || hasEvictionSignal) {
    return "Anticiper délai de libération, accès au bien, trésorerie immobilisée et calendrier travaux.";
  }
  return "Statut bloquant pour le plafond : une occupation inconnue peut déplacer le risque et le calendrier.";
}

function nextActions({
  status,
  hasLeaseSignal,
  hasEvictionSignal,
}: {
  status: OccupancyStatusKind;
  hasLeaseSignal: boolean;
  hasEvictionSignal: boolean;
}): string[] {
  const actions = [
    "Relire le PV descriptif et le cahier des conditions pour confirmer qui occupe le bien.",
  ];
  if (status === "rented" || hasLeaseSignal) {
    actions.push("Relever bail, loyer, dépôt, impayés, durée restante et clauses de sortie.");
  }
  if (status === "occupied" || hasEvictionSignal || status === "conflicting") {
    actions.push("Chiffrer le délai de libération et son impact sur travaux, revente ou location.");
  }
  if (status === "free") {
    actions.push("Confirmer l'absence d'occupation le jour de la visite ou auprès du conseil.");
  }
  actions.push("Demander au conseil les conséquences pratiques avant de déposer la consignation.");
  return actions.slice(0, 4);
}

function limitations(status: OccupancyStatusKind): string[] {
  const items = [
    "L'analyse repose sur les champs collectés et les extraits disponibles, pas sur une consultation juridique.",
    "Le statut réel doit être confirmé dans les pièces officielles et, si possible, lors de la visite.",
  ];
  if (status === "conflicting" || status === "to_confirm") {
    items.unshift("Le dossier ne permet pas encore de qualifier fermement l'occupation.");
  }
  return items;
}

function statusLabel(status: OccupancyStatusKind): string {
  const labels: Record<OccupancyStatusKind, string> = {
    free: "Libre",
    occupied: "Occupé",
    rented: "Loué",
    to_confirm: "À confirmer",
    conflicting: "Signaux contradictoires",
  };
  return labels[status];
}

function collectTextCandidates(sale: AuctionSale): TextCandidate[] {
  const candidates: TextCandidate[] = [];

  addCandidate(candidates, sale.description, "Description annonce");
  addCandidate(candidates, sale.source_description, "Description source");
  addCandidate(candidates, sale.risk_notes, "Notes de risques");

  // Generated scores and summaries are not independent evidence about the property.

  for (const item of flattenKeyValues(sale.source_blocks ?? {})) {
    if (OCCUPANCY_KEY.test(item.path) || hasOccupancyText(item.value)) {
      addCandidate(candidates, `${item.path}: ${cleanText(item.value)}`, "Données source");
    }
  }

  for (const [sourceName, blocks] of Object.entries(sale.source_blocks_by_source ?? {})) {
    for (const item of flattenKeyValues(blocks)) {
      if (OCCUPANCY_KEY.test(item.path) || hasOccupancyText(item.value)) {
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

  return candidates.filter((candidate) => hasOccupancyText(candidate.text));
}

function riskTexts(risk: SaleRisk): string[] {
  const texts: unknown[] = [risk.risk_label, risk.evidence];
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

function hasPattern(candidates: TextCandidate[], patterns: RegExp[]): boolean {
  return candidates.some((candidate) =>
    patterns.some((pattern) => pattern.test(normalizeText(candidate.text))),
  );
}

function hasOccupancyText(value: unknown): boolean {
  const text = cleanText(value);
  return Boolean(text && detectStatus(text));
}

function addCandidate(candidates: TextCandidate[], value: unknown, source: string) {
  const text = cleanText(value);
  if (text) candidates.push({ text, source });
}

function dedupeEvidence(evidence: OccupancyEvidence[]): OccupancyEvidence[] {
  const byKey = new Map<string, OccupancyEvidence>();
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
  return null;
}
