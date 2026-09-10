import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "./example-sale";
import { computeReportSimulation, reportSimulationSchema } from "./report-simulation";

describe("report simulation", () => {
  const sale = {
    ...EXAMPLE_SALE,
    property_type: "apartment",
    app_surface_m2: 50,
    app_surface_kind: "habitable",
  };
  const input = {
    price: 100000,
    works: 20000,
    fpt: 5000,
    scenario: "custom" as const,
    customSafetyDiscountPct: 20,
    manualMarketPricePerM2: 4000,
    expectedMaxBid: 0,
  };
  it("rejects an obsolete or forged ceiling instead of exporting a different result", () => {
    expect(() => computeReportSimulation(sale, null, input)).toThrow(/ont changé/);
  });
  it("validates finite nonnegative financial inputs", () => {
    expect(reportSimulationSchema.safeParse({ ...input, works: -1 }).success).toBe(false);
    expect(reportSimulationSchema.safeParse({ ...input, price: Infinity }).success).toBe(false);
  });
  it("rejects a contradictory property classification on the server", () => {
    expect(() =>
      computeReportSimulation(
        { ...sale, property_type: "land", source_blocks: { titre_detail: "Appartement T5" } },
        null,
        input,
      ),
    ).toThrow(/contradictoire/);
  });
});
