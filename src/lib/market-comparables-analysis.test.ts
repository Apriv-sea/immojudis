import { describe, expect, it } from "vitest";
import { EXAMPLE_MARKET_ESTIMATE } from "@/lib/example-sale";
import { buildMarketComparablesAnalysis } from "@/lib/market-comparables-analysis";

describe("market comparables analysis", () => {
  it.each([6, 7])(
    "keeps a short sample of %s comparables cautious despite high quality score",
    (sampleSize) => {
      const analysis = buildMarketComparablesAnalysis({
        ...EXAMPLE_MARKET_ESTIMATE,
        sampleSize,
        qualityScore: 95,
      });
      expect(analysis.confidence).toBe("medium");
      expect(analysis.confidenceLabel).toBe("Échantillon DVF exploitable avec prudence");
    },
  );
  it("summarizes detailed DVF comparables and quality signals", () => {
    const analysis = buildMarketComparablesAnalysis(EXAMPLE_MARKET_ESTIMATE);

    expect(analysis).toMatchObject({
      available: true,
      status: "detailed",
      confidence: "high",
      confidenceLabel: "Échantillon DVF solide",
      comparableModeLabel: "Surfaces comparables",
      sampleSize: 12,
      radiusM: 100,
      surfaceWindowLabel: "32 à 58 m²",
      priceRangeLabel: "3 780 €/m² à 4 450 €/m²",
    });
    expect(analysis.retainedComparables).toHaveLength(4);
    expect(analysis.summary).toContain("12 vente(s) retenue(s)");
  });

  it("marks address-history fallback as a cautious market reference", () => {
    const analysis = buildMarketComparablesAnalysis({
      ...EXAMPLE_MARKET_ESTIMATE,
      sampleSize: 2,
      parcelSampleSize: 0,
      totalNearbySampleSize: 2,
      qualityScore: 45,
      qualityLabel: "fragile",
      qualityWarnings: ["historique adresse exact utilisé"],
      comparableMode: "address_history",
      recentTransactions: [],
      addressHistory: [
        {
          date: "2025-01-10",
          totalPrice: 180_000,
          surface: 42,
          pricePerM2: 4_286,
          type: "Appartement",
        },
        {
          date: "2023-09-04",
          totalPrice: 170_000,
          surface: 43,
          pricePerM2: 3_953,
          type: "Appartement",
        },
      ],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "address_history",
      confidence: "low",
      confidenceLabel: "Historique adresse utilisé faute de comparables proches",
    });
    expect(analysis.addressHistory).toHaveLength(2);
    expect(analysis.limitations[0]).toContain("surfaces ou le mode de comparaison");
  });

  it("keeps missing DVF references explicit", () => {
    const analysis = buildMarketComparablesAnalysis(null);

    expect(analysis).toMatchObject({
      available: false,
      status: "missing",
      confidence: "low",
      sampleSize: 0,
      retainedComparables: [],
    });
    expect(analysis.nextActions[0]).toContain("Calculer ou renseigner une référence");
  });
});
