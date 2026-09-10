import { describe, expect, it } from "vitest";
import { riskEvidence } from "./risk-evidence";
import type { SaleRisk } from "./types";

const base: SaleRisk = {
  risk_type: "occupation",
  risk_label: "Occupation à vérifier",
  severity: 3,
  evidence: null,
};
describe("risk evidence", () => {
  it("uses a readable document type for reviewed findings without a document title", () => {
    expect(
      riskEvidence({ ...base, evidence_json: { document_type: "diagnostics_techniques" } })
        .proofs[0].label,
    ).toBe("Diagnostics techniques");
  });
  it("does not claim a dossier document when no source is recorded", () => {
    expect(riskEvidence(base).proofs).toEqual([
      { label: "Source non précisée", url: null, excerpt: null, page: null },
    ]);
  });
  it("retains every occurrence while rejecting unsafe document links", () => {
    const result = riskEvidence({
      ...base,
      occurrences: [
        {
          document_url: "https://example.fr/pv.pdf",
          document_label: "PV descriptif",
          document_type: "pv",
          page_number: 3,
          excerpt: "Occupé lors de la visite",
          confidence: 0.9,
        },
        {
          document_url: "javascript:alert(1)",
          document_label: "Autre source",
          document_type: null,
          page_number: null,
          excerpt: "À confirmer",
          confidence: null,
        },
      ],
    });
    expect(result.proofs).toHaveLength(2);
    expect(result.proofs[0]).toMatchObject({
      url: "https://example.fr/pv.pdf",
      page: 3,
      excerpt: "Occupé lors de la visite",
    });
    expect(result.proofs[1].url).toBeNull();
  });
  it("retains the recorded next action and excerpt when occurrences are unavailable", () => {
    expect(
      riskEvidence({
        ...base,
        evidence_json: {
          excerpt: "Pas de bail joint",
          next_action: "Demander le bail",
          document_label: "Analyse du dossier",
        },
      }),
    ).toMatchObject({ action: "Demander le bail", proofs: [{ excerpt: "Pas de bail joint" }] });
  });
});
