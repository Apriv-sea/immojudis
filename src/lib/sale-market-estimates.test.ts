import { describe, expect, it } from "vitest";
import type { MarketEstimate } from "@/lib/market.functions";
import {
  marketContextFromStoredRow,
  saleValuationFingerprint,
  type SaleValuationInput,
} from "@/lib/sale-market-estimates";

const input: SaleValuationInput = {
  saleId: "00000000-0000-4000-8000-000000000001",
  lat: 48.8566,
  lng: 2.3522,
  address: "1 rue de Rivoli",
  city: "Paris",
  postalCode: "75001",
  propertyType: "apartment",
  surfaceKind: "habitable",
  surfaceScope: "lot",
  surfaceM2: 50,
  landSurfaceM2: null,
  roomsCount: 2,
  surfaceEstimated: false,
  surfaceAssumption: null,
  surfaceUncertaintyPct: null,
};

describe("sale market estimates", () => {
  it("produces a stable fingerprint and invalidates it when valuation input changes", () => {
    const first = saleValuationFingerprint(input);
    const same = saleValuationFingerprint({ ...input });
    const changed = saleValuationFingerprint({ ...input, surfaceM2: 65 });

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("withholds a cached commercial valuation after its provisional surface is removed", () => {
    const oldInput = {
      ...input,
      propertyType: "commercial",
      surfaceM2: 56,
      surfaceEstimated: true,
    };
    const currentInput = { ...oldInput, surfaceM2: null, surfaceEstimated: false };
    const row = storedRow({
      computed_at: "2026-07-14T10:00:00.000Z",
      input_fingerprint: saleValuationFingerprint(oldInput),
      estimate: { source: "DVF", sampleSize: 7, qualityScore: 40, estimatedValueEur: 119784 },
    });
    expect(marketContextFromStoredRow(row, saleValuationFingerprint(currentInput))).toMatchObject({
      estimate: null,
      status: "queued",
      ok: false,
    });
    expect(
      marketContextFromStoredRow(row, saleValuationFingerprint(oldInput)).estimate,
    ).not.toBeNull();
  });

  it("keeps serving the previous estimate while a refresh is processing", () => {
    const estimate = {
      source: "DVF normalisé",
      radiusM: 300,
      yearsBack: 6,
      areaKind: "urban",
      commune: "Paris",
      sampleSize: 12,
      parcelSampleSize: 12,
      totalNearbySampleSize: 50,
      outliersRemoved: 2,
      qualityScore: 82,
      qualityLabel: "forte",
      qualityWarnings: [],
      comparableMode: "surface_matched",
      surfaceMinM2: 40,
      surfaceMaxM2: 60,
      medianPricePerM2: 10_000,
      p25PricePerM2: 9_000,
      p75PricePerM2: 11_000,
      minPricePerM2: 8_000,
      maxPricePerM2: 12_000,
      deviationPct: null,
      addressHistory: [],
      recentTransactions: [],
    } satisfies MarketEstimate;
    const context = marketContextFromStoredRow(
      storedRow({ status: "processing", estimate, computed_at: "2026-07-13T11:00:00Z" }),
    );

    expect(context).toMatchObject({
      ok: true,
      error: null,
      estimate,
      status: "refreshing",
      code: null,
    });
  });

  it("reports a pending precompute without calculating on demand", () => {
    const context = marketContextFromStoredRow(storedRow({ status: "pending", estimate: null }));

    expect(context.ok).toBe(false);
    expect(context.estimate).toBeNull();
    expect(context.error).toContain("préparation");
  });

  it.each(["pending", "processing", "failed", "ready"])(
    "withholds an estimate predating corrected source data (%s)",
    (status) => {
      const context = marketContextFromStoredRow(
        storedRow({
          status,
          estimate: { source: "DVF", sampleSize: 12, qualityScore: 80, estimatedValueEur: 931140 },
          computed_at: "2026-07-12T10:00:00Z",
        }),
      );
      expect(context).toMatchObject({ ok: false, estimate: null, status: "queued" });
      expect(context.error).toContain("recalculer");
    },
  );

  it("does not publish a cached valuation without a computation date", () => {
    expect(
      marketContextFromStoredRow(
        storedRow({
          estimate: { source: "DVF", sampleSize: 12, qualityScore: 80, estimatedValueEur: 931140 },
        }),
      ).estimate,
    ).toBeNull();
  });
});

function storedRow(overrides: Record<string, unknown>) {
  return {
    actionable: false,
    attempt_count: 0,
    auction_sale_id: input.saleId,
    comparable_count: 0,
    computed_at: null,
    confidence_score: null,
    created_at: "2026-07-13T10:00:00.000Z",
    engine_kind: null,
    engine_version: null,
    error_message: null,
    estimate: null,
    input_fingerprint: "pending",
    last_started_at: null,
    model_version: null,
    model_version_id: null,
    next_refresh_at: "2026-07-13T10:00:00.000Z",
    segment: null,
    source_updated_at: "2026-07-13T10:00:00.000Z",
    status: "pending",
    updated_at: "2026-07-13T10:00:00.000Z",
    value_p10_eur: null,
    value_p50_eur: null,
    value_p90_eur: null,
    ...overrides,
  } as Parameters<typeof marketContextFromStoredRow>[0];
}
