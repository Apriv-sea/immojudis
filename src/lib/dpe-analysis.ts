import {
  extractDpe,
  dpeClassFromText,
  type DpeClass,
  type DpeSource,
  type StructuredDpeDiagnostic,
} from "@/lib/dpe";
import type { AuctionSale, SaleRisk } from "@/lib/types";

export type DpeImpactLevel = "positive" | "neutral" | "watch" | "risk" | "unknown";

export type DpeEvidence = {
  label: string;
  source: string;
  excerpt: string;
  sourceField?: string;
};

export type DpeAnalysis = {
  available: boolean;
  class: DpeClass | null;
  gesClass: DpeClass | null;
  label: string;
  source: DpeSource | "risk_evidence" | null;
  status: "known" | "document_to_read" | "risk_evidence" | "missing";
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  diagnostic: StructuredDpeDiagnostic | null;
  impactLevel: DpeImpactLevel;
  impactLabel: string;
  renovationPriority: "low" | "medium" | "high" | "unknown";
  evidence: DpeEvidence[];
  summary: string;
  nextActions: string[];
  limitations: string[];
};

type TextCandidate = {
  text: string;
  source: string;
  displayText?: string;
  sourceField?: string;
};

const DPE_CONTEXT =
  /dpe|diagnostic|classe energie|classe energetique|énergie|energie|amiante|plomb|termite|gaz|electricite|électricité|ventilation|isolation/i;

export function buildDpeAnalysis(
  sale: AuctionSale,
  diagnostics: StructuredDpeDiagnostic[] = [],
): DpeAnalysis {
  const extracted = extractDpe(sale, diagnostics);
  const candidates = collectTextCandidates(sale);
  const evidence = collectEvidence({ extracted, candidates });
  const riskClass = dpeClassFromText(candidates.map((candidate) => candidate.text).join("\n"));
  const dpeClass = extracted.class ?? riskClass;
  const source = extracted.source ?? (riskClass ? "risk_evidence" : null);
  const status = resolveStatus({ dpeClass, extractedSource: extracted.source, evidence });
  const impactLevel = impactLevelForClass(dpeClass);
  const renovationPriority = renovationPriorityForClass(dpeClass);

  return {
    available: status !== "missing",
    class: dpeClass,
    gesClass: extracted.diagnostic?.gesClass ?? null,
    label: dpeClass ? `DPE ${dpeClass}` : (extracted.label ?? "DPE à rechercher"),
    source,
    status,
    diagnostic: extracted.diagnostic,
    confidence: confidenceForStatus({ status, source, dpeClass }),
    confidenceLabel: confidenceLabel({ status, source, dpeClass }),
    impactLevel,
    impactLabel: impactLabel({ dpeClass, impactLevel }),
    renovationPriority,
    evidence,
    summary: summary({ dpeClass, status, impactLevel, evidence }),
    nextActions: nextActions({ dpeClass, status, renovationPriority }),
    limitations: limitations(status),
  };
}

function resolveStatus({
  dpeClass,
  extractedSource,
  evidence,
}: {
  dpeClass: DpeClass | null;
  extractedSource: DpeSource | null;
  evidence: DpeEvidence[];
}): DpeAnalysis["status"] {
  if (dpeClass) return "known";
  if (extractedSource === "documents") return "document_to_read";
  if (evidence.length) return "risk_evidence";
  return "missing";
}

function confidenceForStatus({
  status,
  source,
}: {
  status: DpeAnalysis["status"];
  source: DpeAnalysis["source"];
  dpeClass: DpeClass | null;
}): DpeAnalysis["confidence"] {
  if (status === "known" && source === "ademe") return "high";
  if (status === "known" && source === "source_blocks") return "high";
  if (status === "known") return "medium";
  if (status === "document_to_read" || status === "risk_evidence") return "low";
  return "low";
}

function confidenceLabel({
  status,
  source,
}: {
  status: DpeAnalysis["status"];
  source: DpeAnalysis["source"];
  dpeClass: DpeClass | null;
}): string {
  if (status === "known" && source === "ademe") return "DPE ADEME rattaché";
  if (status === "known" && source === "source_blocks") return "Classe DPE structurée";
  if (status === "known") return "Classe DPE détectée à confirmer";
  if (status === "document_to_read") return "Diagnostic repéré, classe à lire";
  if (status === "risk_evidence") return "Indice diagnostic dans les preuves";
  return "DPE non identifié";
}

function impactLevelForClass(dpeClass: DpeClass | null): DpeImpactLevel {
  if (!dpeClass) return "unknown";
  if (dpeClass === "A" || dpeClass === "B") return "positive";
  if (dpeClass === "C" || dpeClass === "D") return "neutral";
  if (dpeClass === "E") return "watch";
  return "risk";
}

function renovationPriorityForClass(dpeClass: DpeClass | null): DpeAnalysis["renovationPriority"] {
  if (!dpeClass) return "unknown";
  if (dpeClass === "A" || dpeClass === "B" || dpeClass === "C") return "low";
  if (dpeClass === "D" || dpeClass === "E") return "medium";
  return "high";
}

function impactLabel({
  dpeClass,
  impactLevel,
}: {
  dpeClass: DpeClass | null;
  impactLevel: DpeImpactLevel;
}): string {
  if (!dpeClass) return "Impact énergétique à qualifier.";
  if (impactLevel === "positive") return "Signal énergétique favorable à préserver.";
  if (impactLevel === "neutral") return "Signal énergétique exploitable, travaux à calibrer.";
  if (impactLevel === "watch") return "Point de vigilance énergétique à chiffrer.";
  return "Risque énergétique fort à transformer en budget et calendrier.";
}

function summary({
  dpeClass,
  status,
  impactLevel,
  evidence,
}: {
  dpeClass: DpeClass | null;
  status: DpeAnalysis["status"];
  impactLevel: DpeImpactLevel;
  evidence: DpeEvidence[];
}): string {
  if (dpeClass) {
    return `DPE ${dpeClass} · impact ${impactLevel} · ${evidence.length} indice(s) diagnostic.`;
  }
  if (status === "document_to_read") return "Diagnostic repéré dans les pièces, classe DPE à lire.";
  if (status === "risk_evidence") return "Indice diagnostic ou énergie détecté dans les preuves.";
  return "DPE et diagnostics à rechercher ou confirmer.";
}

function nextActions({
  dpeClass,
  status,
  renovationPriority,
}: {
  dpeClass: DpeClass | null;
  status: DpeAnalysis["status"];
  renovationPriority: DpeAnalysis["renovationPriority"];
}): string[] {
  const actions: string[] = [];
  if (dpeClass) {
    actions.push(`Vérifier la classe DPE ${dpeClass} dans le diagnostic complet et sa date.`);
  } else if (status === "document_to_read") {
    actions.push("Ouvrir le diagnostic technique repéré pour extraire la classe DPE.");
  } else {
    actions.push("Rechercher DPE, amiante, plomb, termites, gaz et électricité dans les pièces.");
  }
  if (renovationPriority === "high") {
    actions.push("Chiffrer un scénario de rénovation énergétique avant de fixer la mise maximale.");
  } else if (renovationPriority === "medium") {
    actions.push("Prévoir une enveloppe de travaux ou d'amélioration énergétique dans le plafond.");
  }
  actions.push("Comparer le DPE avec les risques travaux et le budget de remise en état.");
  return actions.slice(0, 4);
}

function limitations(status: DpeAnalysis["status"]): string[] {
  const items = [
    "Le DPE doit être relu dans le diagnostic complet : la classe seule ne suffit pas à chiffrer les travaux.",
    "Les diagnostics techniques peuvent être anciens, partiels ou incomplets dans les sources collectées.",
  ];
  if (status !== "known") {
    items.unshift("La classe DPE n'est pas encore structurée dans les données du rapport.");
  }
  return items;
}

function collectEvidence({
  extracted,
  candidates,
}: {
  extracted: ReturnType<typeof extractDpe>;
  candidates: TextCandidate[];
}): DpeEvidence[] {
  const evidence: DpeEvidence[] = [];
  if (extracted.source) {
    evidence.push({
      label: extracted.label ?? "DPE repéré",
      source:
        extracted.source === "ademe"
          ? "ADEME DPE Open Data"
          : extracted.source === "source_blocks"
            ? "Données source"
            : "Pièces du dossier",
      excerpt:
        extracted.diagnostic?.diagnosticNumber && extracted.class
          ? `Diagnostic ${extracted.diagnostic.diagnosticNumber} · DPE ${extracted.class}`
          : (extracted.label ?? "Diagnostic énergétique à confirmer"),
    });
  }
  for (const candidate of candidates) {
    evidence.push({
      label: dpeClassFromText(candidate.text)
        ? `DPE ${dpeClassFromText(candidate.text)}`
        : "Indice diagnostic",
      source: candidate.source,
      excerpt: excerpt(candidate.displayText ?? candidate.text),
      ...(candidate.sourceField ? { sourceField: candidate.sourceField } : {}),
    });
  }
  return dedupeEvidence(evidence).slice(0, 8);
}

function collectTextCandidates(sale: AuctionSale): TextCandidate[] {
  const candidates: TextCandidate[] = [];

  for (const item of flattenKeyValues(sale.source_blocks ?? {})) {
    if (DPE_CONTEXT.test(item.path) || DPE_CONTEXT.test(cleanText(item.value) ?? "")) {
      addCandidate(candidates, `${item.path}: ${cleanText(item.value)}`, "Données source", item);
    }
  }

  for (const [sourceName, blocks] of Object.entries(sale.source_blocks_by_source ?? {})) {
    for (const item of flattenKeyValues(blocks)) {
      if (DPE_CONTEXT.test(item.path) || DPE_CONTEXT.test(cleanText(item.value) ?? "")) {
        addCandidate(
          candidates,
          `${item.path}: ${cleanText(item.value)}`,
          `Données source ${sourceName}`,
          item,
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

  return candidates.filter((candidate) => DPE_CONTEXT.test(candidate.text));
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

function addCandidate(
  candidates: TextCandidate[],
  value: unknown,
  source: string,
  field?: { path: string; value: unknown },
) {
  const text = cleanText(value);
  if (text)
    candidates.push({
      text,
      source,
      ...(field
        ? {
            displayText: cleanText(field.value) ?? "Valeur non renseignée",
            sourceField: field.path,
          }
        : {}),
    });
}

function dedupeEvidence(evidence: DpeEvidence[]): DpeEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.label}-${item.source}-${item.excerpt}`.toLowerCase();
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
