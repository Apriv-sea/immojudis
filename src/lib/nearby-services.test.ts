import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildNearbyServicesAnalysis } from "@/lib/nearby-services";

describe("nearby services analysis", () => {
  it("does not turn woodwork, legal venues or website navigation into nearby services", () => {
    const analysis = buildNearbyServicesAnalysis({
      ...EXAMPLE_SALE,
      source_description: "Audience au tribunal. Porte en bois. Appartement loué.",
      source_blocks: {
        page_text: "Marché immobilier. Santé et diagnostics. Jardin.",
        sale_procedure: { venue_type: "tribunal" },
      },
      source_blocks_by_source: {},
      llm_display_description: "Proche commerces et pharmacie.",
      risks: [
        {
          risk_type: "works",
          risk_label: "Boiseries",
          evidence: "Porte en bois proche du cellier.",
          severity: 1,
        },
      ],
    });
    expect(analysis.mentionedCategories).toEqual([]);
    expect(analysis.status).toBe("geocoded_to_measure");
  });

  it("detects proximity signals from collected source text", () => {
    const analysis = buildNearbyServicesAnalysis({
      ...EXAMPLE_SALE,
      source_description:
        "Appartement proche tram, commerces, école et pharmacie, avec accès rapide au centre-ville.",
      source_blocks: {
        quartier: "À deux pas du jardin public et du tribunal",
      },
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "source_signals",
      confidence: "medium",
      locationQuality: "coordinates",
    });
    expect(analysis.mentionedCategories).toEqual(
      expect.arrayContaining(["Transports", "Écoles", "Commerces", "Santé", "Espaces verts"]),
    );
    expect(analysis.categories.find((category) => category.key === "transport")).toMatchObject({
      status: "mentioned",
    });
    expect(analysis.nextActions[0]).toBe(
      "Calculer les distances à pied et en voiture vers écoles, transports, commerces et santé.",
    );
  });

  it("marks geocoded sales as ready for POI distance measurement", () => {
    const analysis = buildNearbyServicesAnalysis({
      ...EXAMPLE_SALE,
      description: "Appartement T2 avec balcon.",
      source_description: null,
      llm_display_description: null,
      about_description: null,
      tribunal: null,
      tribunal_name: null,
      source_blocks: null,
      source_blocks_by_source: null,
      documents_rich: [],
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "geocoded_to_measure",
      confidence: "medium",
      source: "coordonnées du bien",
    });
    expect(analysis.categories.every((category) => category.status === "to_measure")).toBe(true);
  });

  it("stays explicit when no location can qualify nearby services", () => {
    const analysis = buildNearbyServicesAnalysis({
      ...EXAMPLE_SALE,
      address: null,
      city: null,
      postal_code: null,
      tribunal: null,
      tribunal_name: null,
      latitude: null,
      longitude: null,
      description: null,
      source_description: null,
      llm_display_description: null,
      about_description: null,
      source_blocks: null,
      source_blocks_by_source: null,
      documents_rich: [],
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: false,
      status: "missing",
      confidence: "low",
      locationQuality: "missing",
      summary: "Localisation insuffisante pour qualifier les services de proximité.",
    });
    expect(analysis.categories.every((category) => category.status === "missing")).toBe(true);
  });
});
