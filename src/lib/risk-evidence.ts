import { safeExternalHttpUrl } from "./external-url";
import { documentTypeLabel } from "./format/documents";
import type { SaleRisk } from "./types";

export function riskEvidence(risk: SaleRisk) {
  const evidence =
    risk.evidence_json &&
    typeof risk.evidence_json === "object" &&
    !Array.isArray(risk.evidence_json)
      ? (risk.evidence_json as Record<string, unknown>)
      : {};
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.replace(/\p{Cc}/gu, " ").trim() : null;
  const occurrences = risk.occurrences ?? [];
  const proofs = occurrences.map((item) => ({
    label:
      text(item.document_label) ||
      (text(item.document_type) ? documentTypeLabel(item.document_type) : "Source du constat"),
    url: safeExternalHttpUrl(item.document_url),
    excerpt: text(item.excerpt),
    page: item.page_number,
  }));
  if (!proofs.length) {
    proofs.push({
      label:
        text(evidence.document_label) ||
        (text(evidence.document_type)
          ? documentTypeLabel(text(evidence.document_type))
          : "Source non précisée"),
      url: safeExternalHttpUrl(evidence.document_url),
      excerpt: text(evidence.excerpt) || text(risk.evidence),
      page: typeof evidence.page_number === "number" ? evidence.page_number : null,
    });
  }
  return {
    proofs,
    action: text(evidence.next_action) || "Faire confirmer ce point auprès de l’intermédiaire.",
  };
}
