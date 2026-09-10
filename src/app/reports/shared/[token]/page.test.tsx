import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SharedReportPage from "./page";
const mocks = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/property-reports", () => ({ getSharedPropertyReport: mocks.report }));

async function markup(personal: boolean) {
  mocks.report.mockResolvedValue({
    title: "Rapport de recette",
    updatedAt: "2026-09-09",
    sharedAt: null,
    sale: { startingPrice: 50000 },
    analysis: { opportunity: { acquisitionCosts: { totalCost: 143000 } } },
    sourceTrace: [],
    limitations: [],
    ceiling: {
      available: true,
      maxBid: 244100,
      safetyDiscountPct: 8,
      basisLabel: "Médiane locale",
      ...(personal
        ? {
            personalSimulation: {
              price: 100000,
              works: 31000,
              fpt: 5000,
              scenario: "prudent",
              manualMarketPricePerM2: null,
              expectedMaxBid: 244100,
            },
          }
        : {}),
    },
  });
  return renderToStaticMarkup(
    await SharedReportPage({ params: Promise.resolve({ token: "test" }) }),
  ).replace(/\s/g, "");
}

describe("shared personal simulation", () => {
  it("shows the saved hypotheses and simulated total alongside the same ceiling", async () => {
    const html = await markup(true);
    expect(html).toContain("Scénariopersonnelsauvegardé");
    for (const value of ["100000", "31000", "5000", "143000", "244100"])
      expect(html).toContain(value);
    expect(html).toContain("Coûtcompletauprixsimulé");
    expect(html).toContain("Médianelocale");
  });
  it("does not invent personal inputs for a report without a saved simulation", async () => {
    expect(await markup(false)).not.toContain("Scénariopersonnelsauvegardé");
  });
});
