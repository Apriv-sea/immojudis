import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildRenovationAnalysis } from "@/lib/renovation-analysis";

describe("renovation analysis", () => {
  it("does not treat repeated source fields as independent condition confirmation", () => {
    const text = "Appartement en bon état général.";
    const analysis = buildRenovationAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        description: text,
        source_description: text,
        source_blocks: { etat: text },
        source_blocks_by_source: { licitor: { etat: text } },
        risks: [],
        documents_rich: [],
        risk_notes: null,
      },
      surfaceM2: 21,
    });
    expect(analysis.status).toBe("good");
    expect(analysis.confidence).toBe("medium");
    expect(analysis.confidenceLabel).toBe("Indice travaux repéré, à confirmer");
  });
  it("detects a light refresh from structured source data and estimates a budget range", () => {
    const analysis = buildRenovationAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        source_blocks: {
          etat: "Rafraîchissement à prévoir",
        },
        risks: [],
      },
      surfaceM2: 42.6,
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "light_refresh",
      priority: "medium",
      budgetLevel: "light",
      budgetRange: {
        lowEur: 6390,
        highEur: 14910,
        lowPerM2: 150,
        highPerM2: 350,
      },
    });
    expect(analysis.nextActions).toEqual(
      expect.arrayContaining(["Reporter l'enveloppe travaux dans le calcul de mise maximale."]),
    );
  });

  it("keeps heavy works as a high-priority bidding risk", () => {
    const analysis = buildRenovationAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        source_blocks: null,
        risks: [
          {
            risk_type: "heavy_works",
            risk_label: "Gros travaux",
            severity: 3,
            evidence:
              "Toiture à refaire, structure à reprendre et humidité importante relevées dans le PV.",
          },
        ],
      },
      surfaceM2: 80,
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "heavy_works",
      priority: "high",
      budgetLevel: "heavy",
      budgetRange: {
        lowEur: 64000,
        highEur: 120000,
      },
    });
    expect(analysis.decisionImpact).toContain("devis");
  });

  it("recognizes favorable condition signals without forcing a works alert", () => {
    const analysis = buildRenovationAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        description: "Appartement rénové, en bon état, sans travaux à prévoir.",
        source_description: null,
        llm_display_description: null,
        about_description: null,
        investment_summary: null,
        risk_notes: null,
        source_blocks: null,
        source_blocks_by_source: null,
        score_factors: [],
        documents_rich: [],
        risks: [],
      },
      surfaceM2: 50,
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "good",
      priority: "low",
      budgetLevel: "none",
      budgetRange: {
        lowEur: 0,
        highEur: 6000,
      },
    });
    expect(analysis.nextActions).toEqual(
      expect.arrayContaining([
        "Conserver une marge de sécurité pour les défauts non visibles ou non documentés.",
      ]),
    );
  });

  it("keeps missing works data explicit when no reliable signal is available", () => {
    const analysis = buildRenovationAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        description: "Appartement T2 avec balcon.",
        source_description: null,
        llm_display_description: null,
        about_description: null,
        investment_summary: null,
        risk_notes: null,
        source_blocks: null,
        source_blocks_by_source: null,
        score_factors: [],
        documents_rich: [],
        risks: [],
      },
      surfaceM2: 42,
    });

    expect(analysis).toMatchObject({
      available: false,
      status: "unknown",
      priority: "unknown",
      budgetRange: null,
      confidenceLabel: "Aucun indice travaux exploitable",
    });
    expect(analysis.limitations[0]).toContain("Aucun état fiable");
  });
});
