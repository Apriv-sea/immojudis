import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdjudicationPriceStatisticsResponse } from "@/lib/adjudication-price-statistics";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  assertEntitlement: vi.fn(),
  getStatistics: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => "token"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));

vi.mock("@/lib/property-reports", () => ({
  assertFeatureEntitlement: mocks.assertEntitlement,
}));

vi.mock("@/lib/adjudication-price-statistics-repository", () => ({
  getAdjudicationPriceStatisticsForSale: mocks.getStatistics,
}));

vi.mock("@/lib/usage", () => ({
  recordFeatureUsageEvent: mocks.recordUsage,
}));

import { GET } from "@/app/api/v1/sales/[id]/adjudication-statistics/route";

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const auth = { userId: "premium-user" };
const statistics: AdjudicationPriceStatisticsResponse = {
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
      medianHammerToStartingRatio: 1.9383,
      aboveStartingRate: 0.893485,
      atLeastDoubleRate: 0.485264,
      medianHammerPriceEur: 126_000,
      medianStartingPriceEur: 55_000,
    },
  },
  tribunal: null,
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
};

function request(id = SALE_ID) {
  return GET(new Request(`https://example.test/api/v1/sales/${id}/adjudication-statistics`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/v1/sales/:id/adjudication-statistics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.assertEntitlement.mockResolvedValue(undefined);
    mocks.getStatistics.mockResolvedValue(statistics);
    mocks.recordUsage.mockResolvedValue(undefined);
  });

  it("refuse une requête non authentifiée avant toute lecture", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    const response = await request();

    expect(response.status).toBe(401);
    expect(mocks.assertEntitlement).not.toHaveBeenCalled();
    expect(mocks.getStatistics).not.toHaveBeenCalled();
  });

  it("refuse le plan Découverte avant toute lecture des statistiques", async () => {
    mocks.assertEntitlement.mockRejectedValue(
      new Error("Statistiques d’adjudication réservées au plan Analyse."),
    );

    const response = await request();

    expect(response.status).toBe(403);
    expect(mocks.assertEntitlement).toHaveBeenCalledWith(
      auth,
      "sales.statistics",
      expect.stringContaining("Analyse"),
    );
    expect(mocks.getStatistics).not.toHaveBeenCalled();
  });

  it("valide l’identifiant seulement après authentification et entitlement", async () => {
    const response = await request("not-a-uuid");

    expect(response.status).toBe(400);
    expect(mocks.assertEntitlement).toHaveBeenCalledOnce();
    expect(mocks.getStatistics).not.toHaveBeenCalled();
  });

  it("renvoie une réponse privée et une télémétrie agrégée minimale", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    await expect(response.json()).resolves.toEqual(statistics);
    expect(mocks.getStatistics).toHaveBeenCalledWith(SALE_ID);
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      auth,
      eventKey: "tribunal.statistics_viewed",
      subjectType: "auction_sale",
      subjectId: SALE_ID,
      metadata: {
        window_months: 36,
        national_sample_size: 3_868,
        tribunal_available: false,
        experimental: true,
      },
    });
  });

  it("classe un snapshot absent comme une indisponibilité temporaire privée", async () => {
    mocks.getStatistics.mockRejectedValue(new Error("No reviewed build available"));

    const response = await request();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("ne fait pas échouer la lecture si la télémétrie asynchrone échoue", async () => {
    mocks.recordUsage.mockRejectedValue(new Error("telemetry unavailable"));

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(statistics);
  });
});
