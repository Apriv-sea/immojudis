import { describe, expect, it } from "vitest";
import { buildAuctionCostAnalysis } from "@/lib/auction-cost-analysis";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { computeAcquisitionCosts } from "@/lib/profitability";

describe("auction cost analysis", () => {
  it("shows the fee clause instead of a long source heading and ignores property rights", () => {
    const sale = {
      ...EXAMPLE_SALE,
      source_blocks: null,
      source_blocks_by_source: null,
      risks: [],
      documents_rich: [],
      source_description: "Vente des biens et droits immobiliers par adjudication.",
    };
    const acquisition = computeAcquisitionCosts({ price: 50000 });
    expect(buildAuctionCostAnalysis({ sale, acquisition }).sourceFeeSignals).toEqual([]);
    const analysis = buildAuctionCostAnalysis({
      sale: {
        ...sale,
        source_description:
          "Présentation du bien. ".repeat(30) + "Frais préalables : 3 200 € à confirmer.",
      },
      acquisition,
    });
    expect(analysis.sourceFeeSignals[0]).toContain("Frais préalables : 3 200 €");
    expect(analysis.sourceFeeSignals[0].length).toBeLessThan(220);
  });

  it("does not label a personal simulated cost as a cost at the starting price", () => {
    const acquisition = computeAcquisitionCosts({ price: 80000, works: 31000 });
    const analysis = buildAuctionCostAnalysis({
      sale: { ...EXAMPLE_SALE, starting_price_eur: 50000 },
      acquisition,
    });
    expect(analysis.totalCostAtStartingPriceEur).toBeNull();
    expect(analysis.totalCostAtSimulatedPriceEur).toBe(Math.round(acquisition.totalCost));
    expect(analysis.summary).toContain("coût complet au prix simulé");
    expect(analysis.summary).not.toContain("coût complet mise à prix");
  });

  it("does not present generic page text or generated summaries as evidence of this property's fees", () => {
    const analysis = buildAuctionCostAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        source_description: "Appartement. Frais préalables à confirmer au cahier.",
        source_blocks: {
          description: "Vente aux enchères Terrain. Frais préalables : 4 049,49 €",
          page_text: "Autres annonces : frais préalables 4 049,49 €",
          frais_preliminaires: "Frais taxés à confirmer.",
        },
        source_blocks_by_source: null,
        llm_display_description: "Frais garantis 999 €",
        about_description: "Frais garantis 999 €",
        investment_summary: "Frais garantis 999 €",
        risks: [],
      },
      acquisition: computeAcquisitionCosts({ price: 50000 }),
    });
    const signals = analysis.sourceFeeSignals.join(" ");
    expect(signals).toContain("Frais taxés à confirmer");
    expect(signals).toContain("Frais préalables à confirmer");
    expect(signals).not.toMatch(/Terrain|4 049|999/);
  });

  it("ignores deposits in generic pages and related listings", () => {
    const sale = {
      ...EXAMPLE_SALE,
      source_description: "Appartement. Consignation à confirmer.",
      source_blocks_by_source: null,
      source_blocks: {
        page_text: "Autre vente : consignation 5 000 €",
        related: [{ consignation: 9000 }],
      },
    };
    const acquisition = computeAcquisitionCosts({ price: 50000 });
    expect(buildAuctionCostAnalysis({ sale, acquisition }).consignation).toBeNull();
    expect(
      buildAuctionCostAnalysis({
        sale: { ...sale, source_blocks: { ...sale.source_blocks, consignation: 7000 } },
        acquisition,
      }).consignation?.amountEur,
    ).toBe(7000);
  });

  it("does not mistake the starting price for a later deposit", () => {
    const analysis = buildAuctionCostAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        source_blocks: null,
        source_description:
          "Mise à prix : 50 000 €. Frais préalables : 4 049,49 €. Consignation : 5 000 €.",
        description: null,
      },
      acquisition: computeAcquisitionCosts({ price: 50_000 }),
    });
    expect(analysis.consignation?.amountEur).toBe(5000);
  });
  it("does not turn a percentage, generic instruction or conflicting amounts into a confirmed deposit", () => {
    for (const text of [
      "Mise à prix 50 000 €. Consignation à vérifier.",
      "Consignation de 10 % de la mise à prix de 50 000 €.",
      "Consignation : 5 000 €. Autre consignation : 7 000 €.",
    ]) {
      const analysis = buildAuctionCostAnalysis({
        sale: { ...EXAMPLE_SALE, source_blocks: null, source_description: text, description: null },
        acquisition: computeAcquisitionCosts({ price: 50_000 }),
      });
      expect(analysis.consignation).toBeNull();
    }
  });
  it("combines simulated judicial auction fees with source consignation", () => {
    const acquisition = computeAcquisitionCosts({ price: 120_000, fpt: 3_000 });
    const analysis = buildAuctionCostAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        starting_price_eur: 120_000,
        source_blocks: {
          consignation: 12_000,
          seance_paiement: "Paiement selon cahier des conditions, surenchère sous délai légal.",
        },
      },
      acquisition,
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "costed_with_consignation",
      confidence: "high",
      startingPriceEur: 120_000,
      estimatedFeesEur: Math.round(acquisition.acquisitionFeesTotal),
      consignation: {
        amountEur: 12_000,
        source: "Données source",
      },
    });
    expect(analysis.paymentTerms).toEqual(
      expect.arrayContaining([expect.stringContaining("Paiement selon cahier")]),
    );
  });

  it("detects consignation from source text when no structured field exists", () => {
    const acquisition = computeAcquisitionCosts({ price: 92_000, fpt: 3_000 });
    const analysis = buildAuctionCostAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        source_blocks: null,
        source_blocks_by_source: {
          source: {
            conditions: "Chèque de banque de consignation de 9 200 EUR à remettre avant audience.",
          },
        },
      },
      acquisition,
    });

    expect(analysis.consignation).toMatchObject({
      amountEur: 9_200,
      label: "Consignation",
      source: "Données source source",
    });
    expect(analysis.sourceFeeSignals.length).toBeGreaterThan(0);
  });

  it("keeps source-only fee signals explicit when the starting price is unavailable", () => {
    const analysis = buildAuctionCostAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        starting_price_eur: null,
        source_description: null,
        source_blocks: null,
        description: "Frais préalables et frais taxés à vérifier dans le cahier des conditions.",
      },
      acquisition: computeAcquisitionCosts({ price: 0 }),
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "source_signals",
      confidence: "low",
      estimatedFeesEur: null,
      totalCostAtStartingPriceEur: null,
    });
    expect(analysis.nextActions).toEqual(
      expect.arrayContaining(["Identifier le montant de consignation exigé avant l'audience."]),
    );
  });
});
