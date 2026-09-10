// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ bien: "bordeaux" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === "bien" ? mocks.bien : null),
  }),
}));

vi.mock("@/components/SimplifiedSaleDetailView", () => ({
  AnalysisSaleDetailView: ({
    sale,
    marketEstimateOverride,
    publicDemo,
    returnTo,
  }: {
    sale: { city: string; title: string };
    marketEstimateOverride: { actionable?: boolean };
    publicDemo?: boolean;
    returnTo?: string;
  }) => (
    <div
      data-testid="example-detail"
      data-city={sale.city}
      data-access={publicDemo ? "public-analysis" : "restricted"}
      data-market={marketEstimateOverride.actionable ? "complete" : "missing"}
      data-return-to={returnTo}
    >
      {sale.title}
    </div>
  ),
}));

import { EXAMPLE_SALE_RECORDS } from "@/lib/example-sale";
import { ExampleSalePage } from "@/routes/annonce-exemple";

describe("ExampleSalePage", () => {
  afterEach(cleanup);

  it.each([
    ["bordeaux", "Bordeaux"],
    ["nantes", "Nantes"],
    ["toulouse", "Toulouse"],
  ] as const)("rend l'exemple %s avec l'analyse publique complète", async (bien, city) => {
    mocks.bien = bien;
    render(<ExampleSalePage examples={EXAMPLE_SALE_RECORDS} />);

    const detail = await screen.findByTestId("example-detail");
    expect(detail.dataset.city).toBe(city);
    expect(detail.dataset.access).toBe("public-analysis");
    expect(detail.dataset.market).toBe("complete");
    expect(detail.dataset.returnTo).toBe("/#exemples");
  });

  it("ignore l'ancien paramètre de limitation et conserve l'analyse complète", async () => {
    mocks.bien = "decouverte";
    render(<ExampleSalePage examples={EXAMPLE_SALE_RECORDS} />);

    expect((await screen.findByTestId("example-detail")).dataset.city).toBe("Bordeaux");
  });
});
