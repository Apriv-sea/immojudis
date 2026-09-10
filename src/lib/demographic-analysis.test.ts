import { describe, expect, it } from "vitest";
import { buildDemographicAnalysis } from "@/lib/demographic-analysis";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { MarketEstimate } from "@/lib/market.functions";
import { buildNearbyServicesAnalysis, type NearbyServicesAnalysis } from "@/lib/nearby-services";

const EMPTY_NEARBY: NearbyServicesAnalysis = {
  available: false,
  status: "missing",
  confidence: "low",
  confidenceLabel: "Services de proximité non qualifiés",
  locationQuality: "missing",
  categories: [],
  mentionedCategories: [],
  summary: "Localisation insuffisante pour qualifier les services de proximité.",
  source: "à connecter à BAN/POI",
  nextActions: [],
  limitations: [],
};

function marketEstimate(overrides: Partial<MarketEstimate> = {}): MarketEstimate {
  return {
    source: "DVF Cerema",
    radiusM: 300,
    yearsBack: 6,
    areaKind: "urban",
    commune: "Bordeaux",
    sampleSize: 14,
    parcelSampleSize: 14,
    totalNearbySampleSize: 30,
    outliersRemoved: 2,
    qualityScore: 75,
    qualityLabel: "correcte",
    qualityWarnings: [],
    comparableMode: "surface_matched",
    surfaceMinM2: 30,
    surfaceMaxM2: 60,
    medianPricePerM2: 4_000,
    p25PricePerM2: 3_500,
    p75PricePerM2: 4_500,
    minPricePerM2: 3_000,
    maxPricePerM2: 5_000,
    deviationPct: -25,
    addressHistory: [],
    recentTransactions: [],
    ...overrides,
  };
}

describe("demographic analysis", () => {
  it("does not extrapolate a property's occupant to the local population", () => {
    const analysis = buildDemographicAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        source_description:
          "Le propriétaire occupe sa résidence principale. Un locataire dispose du garage.",
        source_blocks: {},
        source_blocks_by_source: {},
      },
      marketEstimate: null,
      nearbyServices: EMPTY_NEARBY,
    });
    expect(analysis.signals).toEqual([]);
    expect(analysis.status).toBe("location_only");
  });

  it("keeps rental proxies separate from an unrelated sourced population signal", () => {
    const analysis = buildDemographicAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        source_description: "Population communale en croissance.",
        source_blocks: {},
        source_blocks_by_source: {},
      },
      marketEstimate: null,
      nearbyServices: { ...EMPTY_NEARBY, mentionedCategories: ["Commerces"] },
    });
    expect(analysis.status).toBe("source_signals");
    expect(analysis.demandLabel).toBe("Demande locative à tester par proxys");
    expect(analysis.summary).not.toContain("Mobilité et demande locative");
  });

  it("does not infer population or rental demand from property scores and a request for documents", () => {
    const analysis = buildDemographicAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        description: "Appartement, garage et jardin. Demande de pièces auprès de l’avocat.",
        source_description: "Actif immobilier. Meuble de cuisine. Loyer du bail : 600 euros.",
        llm_display_description: "Population en croissance et forte demande locative.",
        source_blocks: {},
        source_blocks_by_source: {},
        score_factors: [
          {
            factor_key: "financial_attractiveness",
            label: "Attractivité",
            reason: "Surface exploitable et actif mixte",
            delta: 1,
          },
        ],
      },
      marketEstimate: null,
      nearbyServices: EMPTY_NEARBY,
    });
    expect(analysis.signals).toEqual([]);
    expect(analysis.status).toBe("location_only");
  });
  it("turns sourced demographic data into actionable signals", () => {
    const sale = {
      ...EXAMPLE_SALE,
      source_blocks: {
        population: "Population en croissance, densité urbaine élevée.",
        revenus: "Revenu médian et pouvoir d'achat à comparer avec les loyers.",
        locatif: "Forte demande locative étudiante liée au campus et aux jeunes actifs.",
      },
      source_blocks_by_source: null,
    };

    const analysis = buildDemographicAnalysis({
      sale,
      marketEstimate: marketEstimate(),
      nearbyServices: buildNearbyServicesAnalysis(sale),
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "source_signals",
      confidence: "medium",
      profileLabel: "Étudiants / jeunes actifs à tester",
    });
    expect(analysis.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "population" }),
        expect.objectContaining({ kind: "income" }),
        expect.objectContaining({ kind: "student" }),
        expect.objectContaining({ kind: "rental_demand" }),
      ]),
    );
    expect(analysis.summary).toContain("Signaux démographiques repérés");
  });

  it("builds a cautious proxy analysis from services and market depth", () => {
    const sale = {
      ...EXAMPLE_SALE,
      description: "Appartement proche tram, commerces et écoles.",
      source_description: null,
      llm_display_description: null,
      about_description: null,
      investment_summary: null,
      risk_notes: null,
      source_blocks: null,
      source_blocks_by_source: null,
      score_factors: [],
    };

    const analysis = buildDemographicAnalysis({
      sale,
      marketEstimate: marketEstimate({ sampleSize: 8, qualityLabel: "fragile" }),
      nearbyServices: buildNearbyServicesAnalysis(sale),
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "market_proxy",
      confidenceLabel: "Lecture par proxys marché et services",
    });
    expect(analysis.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "household", status: "proxy" }),
        expect.objectContaining({ kind: "rental_demand", status: "proxy" }),
        expect.objectContaining({ kind: "market_depth", status: "proxy" }),
      ]),
    );
    expect(analysis.decisionImpact).toContain("proxys");
  });

  it("keeps missing demographic data explicit", () => {
    const analysis = buildDemographicAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        city: null,
        department: null,
        postal_code: null,
        address: null,
        description: null,
        source_description: null,
        llm_display_description: null,
        about_description: null,
        investment_summary: null,
        risk_notes: null,
        source_blocks: null,
        source_blocks_by_source: null,
        score_factors: [],
      },
      marketEstimate: null,
      nearbyServices: EMPTY_NEARBY,
    });

    expect(analysis).toMatchObject({
      available: false,
      status: "missing",
      confidence: "low",
      signals: [],
    });
    expect(analysis.missingData).toEqual(
      expect.arrayContaining([
        "Population, évolution et densité INSEE/commune",
        "Revenus médians et pouvoir d'achat local",
        "Part locataires/propriétaires, vacance et tension locative",
      ]),
    );
    expect(analysis.nextActions[0]).toContain("INSEE");
  });
});
