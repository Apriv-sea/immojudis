import { describe, expect, it } from "vitest";
import {
  computeAcquisitionCosts,
  computeMarketCeiling,
  computeRecommendedCeilings,
  computeRentabilityScore,
  estimateWorksBudget,
  MARKET_CEILING_SCENARIOS,
  WORKS_SCENARIOS,
} from "./profitability";

describe("estimateWorksBudget", () => {
  it("names the market statistic actually used when the prudent P10 is missing", () => {
    const input = {
      surface: 57.6,
      price: 110000,
      works: 28800,
      scenario: "prudent" as const,
      medianPricePerM2: 3022,
    };
    const fallback = computeMarketCeiling(input);
    expect(fallback.basis).toBe("median");
    expect(fallback.basisLabel).toBe("médiane locale (P10 indisponible)");
    const p10 = computeMarketCeiling({ ...input, p10PricePerM2: 2400 });
    expect(p10.basis).toBe("p10");
    expect(p10.marketReferencePricePerM2).toBe(2400);
    expect(p10.maxBid).toBeLessThan(fallback.maxBid);
  });
  it("exposes the three reference prices per square metre", () => {
    expect(WORKS_SCENARIOS.map((scenario) => scenario.pricePerM2)).toEqual([500, 1_440, 1_850]);
  });

  it("reproduces the reference budgets from the renovation examples", () => {
    expect(estimateWorksBudget(25, "rafraichissement")).toBe(12_500);
    expect(estimateWorksBudget(65, "confort")).toBe(93_600);
    expect(estimateWorksBudget(120, "premium")).toBe(222_000);
  });

  it("never returns a negative works budget", () => {
    expect(estimateWorksBudget(-25, "premium")).toBe(0);
    expect(estimateWorksBudget(null, "confort")).toBe(0);
  });
});

describe("computeAcquisitionCosts", () => {
  it("applies judicial auction fees and registration duties", () => {
    const result = computeAcquisitionCosts({ price: 100_000 });

    expect(result.emolumentsHT).toBeCloseTo(2_266.75, 2);
    expect(result.emolumentsTTC).toBeCloseTo(2_720.1, 2);
    expect(result.registrationDuties).toBe(5_800);
    expect(result.fpt).toBe(3_000);
    expect(result.acquisitionFeesTotal).toBeCloseTo(11_520.1, 2);
    expect(result.totalCost).toBeCloseTo(111_520.1, 2);
  });

  it("clamps negative inputs to zero", () => {
    const result = computeAcquisitionCosts({ price: -10_000, works: -5_000, fpt: -1_000 });

    expect(result.price).toBe(0);
    expect(result.works).toBe(0);
    expect(result.fpt).toBe(0);
    expect(result.totalCost).toBe(0);
  });
});

describe("computeMarketCeiling", () => {
  it("exposes only the Prudent 8% and Offensif 4% profiles", () => {
    expect(
      MARKET_CEILING_SCENARIOS.map((scenario) => [scenario.key, scenario.safetyDiscountPct]),
    ).toEqual([
      ["prudent", 8],
      ["offensif", 4],
    ]);
  });

  it("returns unavailable when surface is missing", () => {
    const result = computeMarketCeiling({
      surface: null,
      price: 100_000,
      scenario: "prudent",
      medianPricePerM2: 3_000,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("Surface manquante");
  });

  it("uses manual market price as the reference when provided", () => {
    const result = computeMarketCeiling({
      surface: 50,
      price: 90_000,
      scenario: "prudent",
      medianPricePerM2: 3_000,
      manualMarketPricePerM2: 2_800,
    });

    expect(result.available).toBe(true);
    expect(result.basis).toBe("manual");
    expect(result.safetyDiscountPct).toBe(8);
    expect(result.marketReferencePricePerM2).toBe(2_800);
  });

  it("deducts a selected works scenario from the auction ceiling", () => {
    const ceilings = computeRecommendedCeilings({
      surface: 50,
      price: 90_000,
      scenario: "prudent",
      medianPricePerM2: 3_000,
      p25PricePerM2: 2_700,
    });

    expect(ceilings.refreshWorksBudget).toBe(25_000);
    expect(ceilings.withoutWorks.simulated.works).toBe(0);
    expect(ceilings.withRefreshWorks.simulated.works).toBe(25_000);
    expect(ceilings.withRefreshWorks.maxBid).toBeLessThan(ceilings.withoutWorks.maxBid);
    expect(ceilings.withRefreshWorks.maxBid).toBeLessThanOrEqual(
      ceilings.withoutWorks.maxBid - 23_000,
    );
  });
});

describe("computeRentabilityScore", () => {
  it("scores a rental project with explicit rent and financing assumptions", () => {
    const result = computeRentabilityScore({
      surface: 50,
      price: 100_000,
      works: 10_000,
      fpt: 3_000,
      department: "33",
      monthlyRent: 900,
      downPaymentPct: 30,
      annualInterestRatePct: 3.8,
      loanDurationYears: 20,
      marketMarginPerM2: 260,
    });

    expect(result.available).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.label).toBe("Très rentable à confirmer");
    expect(result.rentSource).toBe("manual");
    expect(result.grossYieldPct).toBeGreaterThan(result.netYieldPct ?? 0);
    expect(result.cashflowMonthly).not.toBeNull();
    expect(result.factors.map((factor) => factor.key)).toEqual(
      expect.arrayContaining(["gross_yield", "net_yield", "cashflow", "market_margin"]),
    );
  });

  it("uses a department rent estimate when monthly rent is missing", () => {
    const result = computeRentabilityScore({
      surface: 40,
      price: 120_000,
      department: "75",
    });

    expect(result.available).toBe(true);
    expect(result.rentSource).toBe("department_estimate");
    expect(result.monthlyRent).toBe(1_280);
    expect(result.factors.some((factor) => factor.key === "rent_source" && factor.delta < 0)).toBe(
      true,
    );
  });

  it("returns unavailable when the surface is missing", () => {
    const result = computeRentabilityScore({
      surface: null,
      price: 120_000,
      department: "75",
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("Surface manquante");
    expect(result.score).toBeNull();
  });
});
