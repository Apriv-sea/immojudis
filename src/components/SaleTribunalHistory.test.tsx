// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTribunalJudicialActivity,
  TribunalCourtUnresolvedError,
} from "@/lib/tribunal-judicial-activity";
import { buildTribunalJudicialActivityDirectory } from "@/lib/tribunal-judicial-activity-directory";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { SaleTribunalHistory } from "./SaleTribunalHistory";

const mocks = vi.hoisted(() => ({
  fetchActivity: vi.fn(),
  fetchAdjudicationStatistics: vi.fn(),
  fetchDirectory: vi.fn(),
}));

vi.mock("@/lib/adjudication-price-statistics-client", () => ({
  fetchAdjudicationPriceStatistics: mocks.fetchAdjudicationStatistics,
}));

vi.mock("@/lib/tribunal-judicial-activity-client", () => ({
  fetchTribunalJudicialActivity: mocks.fetchActivity,
}));

vi.mock("@/lib/tribunal-judicial-activity-directory-client", () => ({
  fetchTribunalJudicialActivityDirectory: mocks.fetchDirectory,
}));

const activity = buildTribunalJudicialActivity({
  court: {
    code: "justice_tj_1_59",
    name: "TJ Marseille",
    judicialRegion: "Aix-en-Provence",
  },
  sales: [],
  asOf: new Date("2026-08-20T12:00:00.000Z"),
  historyMonths: 36,
});

const directory = buildTribunalJudicialActivityDirectory({
  courts: [activity.court],
  sales: Array.from({ length: 5 }, (_, index) => ({
    id: `sale-${index + 1}`,
    tribunalCode: activity.court.code,
    saleDate: new Date(Date.UTC(2026, 8, 1 + index)).toISOString(),
    status: "upcoming",
    startingPriceEur: 80_000 + index * 10_000,
    propertyType: "apartment",
    visitDates: [new Date(Date.UTC(2026, 7, 25 + index)).toISOString()],
    firstSeenAt: new Date(Date.UTC(2026, 6, 1 + index)).toISOString(),
  })),
  asOf: new Date("2026-08-20T12:00:00.000Z"),
  historyMonths: 36,
});

describe("SaleTribunalHistory", () => {
  it("loads catalogue activity only when its details are opened", () => {
    renderHistory(tribunalSaleWithoutPublishedCode());
    expect(mocks.fetchActivity).not.toHaveBeenCalled();
    expect(mocks.fetchDirectory).not.toHaveBeenCalled();
    openActivity();
    expect(mocks.fetchActivity).toHaveBeenCalledTimes(1);
    expect(mocks.fetchDirectory).toHaveBeenCalledTimes(1);
  });

  it("retries failed adjudication statistics without refetching the other sections", async () => {
    mocks.fetchAdjudicationStatistics.mockRejectedValueOnce(new Error("network"));
    renderHistory({ ...tribunalSaleWithoutPublishedCode(), property_type: "apartment" }, true);
    const retry = await screen.findByRole("button", {
      name: /Réessayer : Résultats d’adjudication/,
    });
    const stats = adjudicationStatistics();
    mocks.fetchAdjudicationStatistics.mockResolvedValue({
      ...stats,
      national: { ...stats.national, propertyTypes: [typeDistribution(100, 50000)] },
    });
    fireEvent.click(retry);
    expect(
      await screen.findByRole("region", { name: "Historique du même type de bien" }),
    ).toBeTruthy();
    expect(mocks.fetchAdjudicationStatistics).toHaveBeenCalledTimes(2);
    expect(mocks.fetchActivity).not.toHaveBeenCalled();
    expect(mocks.fetchDirectory).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /Réessayer : Résultats d’adjudication/ }),
    ).toBeNull();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchActivity.mockResolvedValue(activity);
    mocks.fetchAdjudicationStatistics.mockResolvedValue(adjudicationStatistics());
    mocks.fetchDirectory.mockResolvedValue(directory);
  });

  afterEach(cleanup);

  it("résout côté serveur le tribunal d’une vente judiciaire encore en cours de vérification", async () => {
    const sale = tribunalSaleWithoutPublishedCode();

    renderHistory(sale);
    openActivity();

    expect(await screen.findByText("Mise à prix médiane · France")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "TJ Marseille" })).toBeTruthy();
    expect(mocks.fetchActivity).toHaveBeenCalledWith({
      saleId: sale.id,
      historyMonths: 36,
    });
    expect(mocks.fetchDirectory).toHaveBeenCalledWith(36);
    expect(screen.getByText(/Profil local en cours de consolidation/)).toBeTruthy();
    expect(screen.getByText(/uniquement lorsqu’ils sont publiés/i)).toBeTruthy();
  });

  it("garde une section explicite lorsque le rattachement exact n’est pas encore publiable", async () => {
    mocks.fetchActivity.mockRejectedValue(new TribunalCourtUnresolvedError());

    renderHistory(tribunalSaleWithoutPublishedCode());
    openActivity();

    expect(
      await screen.findByText(
        "Statistiques de Tribunal judiciaire de Bordeaux en cours de consolidation",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/aucune statistique approximative n’est substituée/i)).toBeTruthy();
    expect(await screen.findByText("Mise à prix médiane · France")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Réessayer.*consolidation/ })).toBeNull();
  });

  it("publie le détail du tribunal lorsque les prix et délais dépassent le seuil", async () => {
    mocks.fetchActivity.mockResolvedValue(directory.tribunals[0]!);

    renderHistory(tribunalSaleWithoutPublishedCode());
    openActivity();

    expect(await screen.findByText("Mise à prix médiane · Tribunal")).toBeTruthy();
    expect(screen.getByText("Détection → vente · Tribunal")).toBeTruthy();
    expect(screen.queryByText(/Profil local en cours de consolidation/)).toBeNull();
  });

  it("ne charge jamais les résultats d’adjudication pour l’accès Découverte", async () => {
    renderHistory(tribunalSaleWithoutPublishedCode());
    openActivity();

    expect(await screen.findByText("Mise à prix médiane · France")).toBeTruthy();
    expect(mocks.fetchAdjudicationStatistics).not.toHaveBeenCalled();
    expect(screen.queryByText("Du prix de départ au prix adjugé")).toBeNull();
  });

  it("présente d’abord la France puis le tribunal aux membres Analyse", async () => {
    const { container } = renderHistory(tribunalSaleWithoutPublishedCode(), true);

    expect(await screen.findByText("Du prix de départ au prix adjugé")).toBeTruthy();
    expect(mocks.fetchAdjudicationStatistics).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(await screen.findAllByText("Multiplicateur médian")).toHaveLength(2);
    expect(screen.getAllByText("Au-dessus de la mise")).toHaveLength(2);
    expect(screen.getAllByText("Au moins doublé")).toHaveLength(2);
    expect(screen.getAllByText("Prix adjugé médian")).toHaveLength(2);
    expect(screen.getAllByText("Mise à prix médiane")).toHaveLength(2);
    const text = container.textContent ?? "";
    expect(text.indexOf("France entière")).toBeLessThan(
      text.indexOf("Tribunal judiciaire de Marseille"),
    );
    expect(screen.getByText(/3\s868 adjudications/)).toBeTruthy();
    expect(screen.getByText(/152 adjudications/)).toBeTruthy();
  });

  it("garde le niveau France sans révéler un petit échantillon tribunal", async () => {
    mocks.fetchAdjudicationStatistics.mockResolvedValue(adjudicationStatistics({ tribunal: null }));

    renderHistory(tribunalSaleWithoutPublishedCode(), true);

    expect(await screen.findByText(/Aucun échantillon publiable pour/)).toBeTruthy();
    expect(screen.getByText(/3\s868 adjudications/)).toBeTruthy();
    expect(screen.queryByText(/9 adjudications/)).toBeNull();
  });

  it("affiche l’état de validation tant que le build reste fermé", async () => {
    mocks.fetchAdjudicationStatistics.mockRejectedValue(new Error("publication disabled"));

    renderHistory(tribunalSaleWithoutPublishedCode(), true);

    expect(await screen.findByText("Résultats d’adjudication en cours de validation")).toBeTruthy();
    expect(screen.getByText(/Les résultats ne sont pas disponibles pour le moment/)).toBeTruthy();
  });

  it("prioritizes the matching local type and keeps the general catalogue collapsed", async () => {
    const stats = adjudicationStatistics();
    const national = typeDistribution(100, 50000);
    const local = typeDistribution(20, 90000);
    mocks.fetchAdjudicationStatistics.mockResolvedValue({
      ...stats,
      national: { ...stats.national, propertyTypes: [national] },
      tribunal: { ...stats.tribunal, propertyTypes: [local] },
    });
    const { container } = renderHistory(
      { ...tribunalSaleWithoutPublishedCode(), property_type: "apartment" },
      true,
    );
    const region = await screen.findByRole("region", { name: "Historique du même type de bien" });
    expect(within(region).getByText(/^20 résultats/)).toBeTruthy();
    expect(within(region).getByText(/90.000/)).toBeTruthy();
    expect(within(region).queryByText(/50.000/)).toBeNull();
    expect(within(region).getByText(/sur 20 résultats/)).toBeTruthy();
    expect(within(region).getByText(/Échantillon limité : moins de 30 résultats/)).toBeTruthy();
    expect([...container.querySelectorAll("details")].every((item) => !item.open)).toBe(true);
    expect(screen.queryByText(/au-dessus de la médiane nationale/)).toBeNull();
  });

  it("falls back to the national matching type rather than another local type", async () => {
    const stats = adjudicationStatistics();
    mocks.fetchAdjudicationStatistics.mockResolvedValue({
      ...stats,
      national: { ...stats.national, propertyTypes: [typeDistribution(100, 50000)] },
      tribunal: {
        ...stats.tribunal,
        propertyTypes: [{ ...typeDistribution(20, 90000), propertyType: "house" }],
      },
    });
    renderHistory({ ...tribunalSaleWithoutPublishedCode(), property_type: "apartment" }, true);
    const region = await screen.findByRole("region", { name: "Historique du même type de bien" });
    expect(within(region).getByText(/^100 résultats/)).toBeTruthy();
    expect(within(region).getByText(/Les données nationales sont présentées/)).toBeTruthy();
    expect(within(region).queryByText(/90.000/)).toBeNull();
    expect(within(region).queryByText(/Échantillon limité/)).toBeNull();
  });

  it.each([10, 29, 30])(
    "qualifie le sous-échantillon de %i résultats indépendamment du total national",
    async (sampleSize) => {
      const stats = adjudicationStatistics();
      mocks.fetchAdjudicationStatistics.mockResolvedValue({
        ...stats,
        national: { ...stats.national, propertyTypes: [typeDistribution(sampleSize, 50000)] },
        tribunal: null,
      });
      renderHistory({ ...tribunalSaleWithoutPublishedCode(), property_type: "apartment" }, true);
      const region = await screen.findByRole("region", { name: "Historique du même type de bien" });
      expect(Boolean(within(region).queryByText(/Échantillon limité/))).toBe(sampleSize < 30);
    },
  );

  it("affiche les fourchettes et les types documentés sans inventer les types absents", async () => {
    const statistics = adjudicationStatistics();
    const distribution = {
      sampleSize: 3868,
      hammerPriceMiddle50Eur: { p25: 67750, p75: 225250 },
      ratioMiddle50: { p25: 1.17, p75: 3.1 },
      bidDistribution: [
        "below_starting",
        "at_starting",
        "above_1_below_1_5",
        "from_1_5_below_2",
        "at_least_2",
      ].map((band, index) => ({ band, count: index === 0 ? 3868 : 0, share: index === 0 ? 1 : 0 })),
    };
    mocks.fetchAdjudicationStatistics.mockResolvedValue({
      ...statistics,
      national: {
        ...statistics.national,
        distribution,
        propertyTypes: [{ propertyType: "house", distribution }],
      },
    });
    renderHistory(tribunalSaleWithoutPublishedCode(), true);
    expect(await screen.findByText("Repères par type de bien")).toBeTruthy();
    expect(screen.getByText("Sous la mise à prix")).toBeTruthy();
    expect(screen.getByText("Maison")).toBeTruthy();
    expect(screen.queryByText("Bien mixte")).toBeNull();
  });
});

function tribunalSaleWithoutPublishedCode(): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    id: "11111111-1111-4111-8111-111111111111",
    tribunal_code: null,
    sale_verification_status: "pending",
    sale_procedure: null,
    source_blocks: null,
  } as AuctionSale;
}

function renderHistory(sale: AuctionSale, premium = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SaleTribunalHistory sale={sale} premium={premium} />
    </QueryClientProvider>,
  );
}

function adjudicationStatistics(overrides: Record<string, unknown> = {}) {
  return {
    national: {
      scopeType: "national",
      label: "France entière",
      courtCode: null,
      judicialRegion: null,
      periodStart: "2023-09-07",
      periodEnd: "2026-09-07",
      sampleSize: 3_868,
      reliability: "extended",
      metrics: {
        medianHammerToStartingRatio: 1.94,
        aboveStartingRate: 0.89,
        atLeastDoubleRate: 0.49,
        medianHammerPriceEur: 126_000,
        medianStartingPriceEur: 55_000,
      },
    },
    tribunal: {
      scopeType: "tribunal",
      label: "Tribunal judiciaire de Marseille",
      courtCode: "justice_tj_1_59",
      judicialRegion: "Aix-en-Provence",
      periodStart: "2023-09-07",
      periodEnd: "2026-09-07",
      sampleSize: 152,
      reliability: "extended",
      metrics: {
        medianHammerToStartingRatio: 1.83,
        aboveStartingRate: 0.86,
        atLeastDoubleRate: 0.43,
        medianHammerPriceEur: 132_000,
        medianStartingPriceEur: 62_000,
      },
    },
    meta: {
      sourceName: "licitor",
      sourceLabel: "Résultats d’adjudication publiés par Licitor",
      methodologyVersion: "licitor_canonical_price_statistics_v1",
      builtAt: "2026-09-07T12:00:00.000Z",
      reviewedAt: "2026-09-07T13:00:00.000Z",
      experimental: true,
      warning:
        "Statistiques descriptives historiques sur trois ans, sans valeur prédictive ni estimation du bien.",
    },
    ...overrides,
  };
}

function typeDistribution(sampleSize: number, low: number) {
  return {
    propertyType: "apartment",
    distribution: {
      sampleSize,
      hammerPriceMiddle50Eur: { p25: low, p75: low * 2 },
      ratioMiddle50: { p25: 1.2, p75: 2.5 },
      bidDistribution: [
        "below_starting",
        "at_starting",
        "above_1_below_1_5",
        "from_1_5_below_2",
        "at_least_2",
      ].map((band) => ({ band, count: sampleSize / 5, share: 0.2 })),
    },
  };
}

function openActivity() {
  const details = screen
    .getByText("Suivi des annonces : couverture, visites et délais")
    .closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
