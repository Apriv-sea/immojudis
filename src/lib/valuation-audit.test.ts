import { describe, expect, it } from "vitest";
import { EXAMPLE_MARKET_ESTIMATE, EXAMPLE_SALE } from "@/lib/example-sale";
import { buildValuationAudit } from "@/lib/valuation-audit";

describe("valuation audit", () => {
  it.each([6, 7])("does not call a short sample of %s robust", (sampleSize) => {
    const audit = buildValuationAudit({
      sale: EXAMPLE_SALE,
      surfaceM2: EXAMPLE_SALE.app_surface_m2,
      marketEstimate: { ...EXAMPLE_MARKET_ESTIMATE, sampleSize, qualityScore: 95 },
    });
    expect(audit.status).toBe("usable");
    expect(audit.checkpoints).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "sample_size", status: "watch" })]),
    );
  });
  it("marks a well-sampled DVF estimate as robust", () => {
    const audit = buildValuationAudit({
      sale: EXAMPLE_SALE,
      surfaceM2: EXAMPLE_SALE.app_surface_m2,
      marketEstimate: EXAMPLE_MARKET_ESTIMATE,
    });

    expect(audit).toMatchObject({
      available: true,
      status: "robust",
      confidenceLabel: "Estimation robuste pour cadrer le plafond",
    });
    expect(audit.score).toBeGreaterThanOrEqual(82);
    expect(audit.checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "sample_size", status: "ok" }),
        expect.objectContaining({ key: "comparable_mode", status: "ok" }),
        expect.objectContaining({ key: "deviation", status: "ok" }),
      ]),
    );
  });

  it("downgrades an address-history fallback with warnings and wide radius", () => {
    const audit = buildValuationAudit({
      sale: {
        ...EXAMPLE_SALE,
        starting_price_eur: 250_000,
      },
      surfaceM2: 42,
      marketEstimate: {
        ...EXAMPLE_MARKET_ESTIMATE,
        radiusM: 2200,
        sampleSize: 2,
        parcelSampleSize: 0,
        totalNearbySampleSize: 2,
        outliersRemoved: 3,
        qualityScore: 42,
        qualityLabel: "fragile",
        qualityWarnings: ["historique adresse exact utilisé", "rayon élargi"],
        comparableMode: "address_history",
        medianPricePerM2: 4_000,
        surfaceMinM2: 70,
        surfaceMaxM2: 120,
      },
    });

    expect(audit).toMatchObject({
      available: true,
      status: "fragile",
      confidenceLabel: "Estimation fragile à recouper",
    });
    expect(audit.riskFlags).toEqual(
      expect.arrayContaining(["Score qualité DVF", "Mode de comparaison", "Rayon de marché"]),
    );
    expect(audit.nextActions[0]).toContain("comparables complémentaires");
  });

  it("keeps missing valuation explicit", () => {
    const audit = buildValuationAudit({
      sale: EXAMPLE_SALE,
      surfaceM2: EXAMPLE_SALE.app_surface_m2,
      marketEstimate: null,
    });

    expect(audit).toMatchObject({
      available: false,
      status: "missing",
      score: 0,
      confidenceLabel: "Estimation à construire",
    });
    expect(audit.summary).toContain("Audit impossible");
  });
});
