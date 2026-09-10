import { describe, expect, it } from "vitest";
import { buildDpeAnalysis } from "@/lib/dpe-analysis";
import { EXAMPLE_SALE } from "@/lib/example-sale";

describe("DPE analysis", () => {
  it("keeps technical provenance separate from the readable evidence excerpt", () => {
    const analysis = buildDpeAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: {
        sale_procedure: {
          verification: { case_sources: [{ label: "Diagnostics techniques.pdf" }] },
        },
      },
      source_blocks_by_source: {},
      documents_rich: [],
      risks: [],
    });
    expect(analysis.evidence).toContainEqual(
      expect.objectContaining({
        excerpt: "Diagnostics techniques.pdf",
        sourceField: "sale_procedure.verification.case_sources[0].label",
      }),
    );
    expect(analysis.evidence.every((item) => !item.excerpt.includes("sale_procedure"))).toBe(true);
    expect(analysis.class).toBeNull();
  });
  it("does not label a building letter in a source page as an energy rating", () => {
    const analysis = buildDpeAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: {
        page_text: "Appartement à Toulouse, bâtiment A. Diagnostics techniques disponibles.",
      },
      source_blocks_by_source: {},
      documents_rich: [],
      risks: [],
    });
    expect(analysis.class).toBeNull();
    expect(analysis.impactLevel).toBe("unknown");
    expect(analysis.renovationPriority).toBe("unknown");
    expect(analysis.evidence.every((item) => item.label === "Indice diagnostic")).toBe(true);
  });

  it("uses ADEME structured diagnostics as high-confidence DPE evidence", () => {
    const analysis = buildDpeAnalysis(
      {
        ...EXAMPLE_SALE,
        source_blocks: null,
        risks: [],
      },
      [
        {
          diagnosticNumber: "2133E0178774F",
          dpeClass: "E",
          gesClass: "C",
          establishedAt: "2025-05-10",
          validUntil: "2035-05-09",
          propertyType: "maison",
          address: "10 Rue Exemple 33000 Bordeaux",
          city: "Bordeaux",
          postalCode: "33000",
          inseeCode: "33063",
          department: "33",
          surfaceM2: 82.4,
          energyConsumptionKwhM2Year: 294.2,
          emissionsKgCo2M2Year: 42,
          latitude: 44.8378,
          longitude: -0.5792,
          matchKind: "geo_distance",
          confidence: 0.92,
          sourceApi: "ADEME DPE Open Data",
        },
      ],
    );

    expect(analysis).toMatchObject({
      available: true,
      class: "E",
      gesClass: "C",
      status: "known",
      confidence: "high",
      confidenceLabel: "DPE ADEME rattaché",
      source: "ademe",
      diagnostic: {
        diagnosticNumber: "2133E0178774F",
      },
    });
    expect(analysis.evidence[0]).toMatchObject({
      source: "ADEME DPE Open Data",
      excerpt: "Diagnostic 2133E0178774F · DPE E",
    });
  });

  it("builds a high-confidence analysis from structured DPE source data", () => {
    const analysis = buildDpeAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: {
        dpe_classe: "F",
      },
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      class: "F",
      status: "known",
      confidence: "high",
      impactLevel: "risk",
      renovationPriority: "high",
    });
    expect(analysis.nextActions).toEqual(
      expect.arrayContaining([
        "Chiffrer un scénario de rénovation énergétique avant de fixer la mise maximale.",
      ]),
    );
  });

  it("marks diagnostic documents as DPE to read when no class is structured", () => {
    const analysis = buildDpeAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: null,
      risks: [],
      documents_rich: [
        {
          url: "/diagnostics.pdf",
          label: "Diagnostics techniques",
          type: "diagnostics_techniques",
          document_type: "diagnostics_techniques",
          extraction_status: "downloaded",
        },
      ],
    });

    expect(analysis).toMatchObject({
      available: true,
      class: null,
      status: "document_to_read",
      confidenceLabel: "Diagnostic repéré, classe à lire",
      source: "documents",
    });
  });

  it("uses risk evidence as a low-confidence diagnostic signal", () => {
    const analysis = buildDpeAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: null,
      documents_rich: [],
      risks: [
        {
          risk_type: "energy_works",
          risk_label: "Isolation à vérifier",
          severity: 2,
          evidence:
            "Le diagnostic mentionne une ventilation insuffisante et une isolation à reprendre.",
        },
      ],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "risk_evidence",
      confidence: "low",
      impactLevel: "unknown",
    });
    expect(analysis.evidence[0]).toMatchObject({
      label: "Indice diagnostic",
      source: "Preuves de risques",
    });
  });
});
