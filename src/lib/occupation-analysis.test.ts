import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";

describe("occupation analysis", () => {
  const cleanSale = {
    ...EXAMPLE_SALE,
    description: "Appartement.",
    source_description: null,
    llm_display_description: null,
    about_description: null,
    investment_summary: null,
    risk_notes: null,
    source_blocks: {},
    source_blocks_by_source: {},
    score_factors: [],
    documents_rich: [],
    risks: [],
  };

  it("does not treat copies of one publication as independent confirmation", () => {
    const text = "Studio loué avec bail en cours.";
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "rented",
      description: text,
      source_description: text,
      source_blocks: { page_text: text, occupation: "rented" },
      source_blocks_by_source: { licitor: { page_text: text, occupation: "rented" } },
    });
    expect(analysis.status).toBe("rented");
    expect(analysis.confidence).toBe("medium");
    expect(analysis.confidenceLabel).toBe("Statut repéré, à confirmer");
  });

  it.each(["Présence d'un meuble", "Présence d’un placard", "Présence d’une fenêtre"])(
    "does not turn a physical observation into occupation: %s",
    (description) => {
      const analysis = buildOccupancyAnalysis({
        ...cleanSale,
        occupancy_status: "rented",
        description,
      });
      expect(analysis.status).toBe("rented");
      expect(analysis.evidence).toHaveLength(1);
    },
  );

  it("treats rented and occupied as compatible signals", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "rented",
      source_description: "Présence d’une personne dans le logement.",
    });
    expect(analysis.status).toBe("rented");
    expect(analysis.evidence.map((item) => item.status)).toContain("occupied");
  });

  it("keeps a late contradiction in the decision and visible evidence", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "free",
      source_blocks: {
        ...Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [
            `occupation_${i}`,
            `Libre de toute occupation, constat ${i}.`,
          ]),
        ),
        occupation_finale: "Présence d’une personne dans le logement.",
      },
    });
    expect(analysis.status).toBe("conflicting");
    expect(analysis.evidence).toHaveLength(8);
    expect(analysis.evidence.map((item) => item.status)).toEqual(
      expect.arrayContaining(["free", "occupied"]),
    );
  });

  it("does not treat vacancy at a historical inspection as current availability", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "vacant",
      source_description: "Le logement était inoccupé lors du constat.",
      source_blocks: {},
      risks: [],
    });
    expect(analysis.status).toBe("to_confirm");
    expect(analysis.summary).toContain("Inoccupé au constat");
    expect(analysis.summary).toContain("disponibilité actuelle reste à confirmer");
  });
  it("qualifies free properties from a structured status and source confirmation", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "free",
      source_blocks: {
        occupation: "Libre de toute occupation",
      },
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "free",
      label: "Libre",
      confidence: "medium",
      hasLeaseSignal: false,
    });
    expect(analysis.decisionImpact).toContain("jouissance");
  });

  it("detects lease and tenant signals even when the structured status is unknown", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "unknown",
      description: "Appartement loué selon bail d'habitation, loyer mensuel à vérifier.",
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "rented",
      label: "Loué",
      hasLeaseSignal: true,
    });
    expect(analysis.nextActions).toEqual(
      expect.arrayContaining([
        "Relever bail, loyer, dépôt, impayés, durée restante et clauses de sortie.",
      ]),
    );
  });

  it("flags conflicting occupancy signals before bidding assumptions are fixed", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "free",
      description: "Présence d'une personne se déclarant occupante, bail non produit.",
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "conflicting",
      confidence: "low",
      confidenceLabel: "Signaux contradictoires à arbitrer",
    });
    expect(analysis.decisionImpact).toContain("plafond d'enchère");
  });

  it("keeps unknown occupation explicit when only weak source data is present", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "unknown",
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
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "to_confirm",
      confidence: "low",
      summary: "À confirmer · 1 indice(s).",
    });
    expect(analysis.limitations[0]).toContain("ne permet pas encore");
  });
});
