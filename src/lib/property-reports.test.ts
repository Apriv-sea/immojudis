import { describe, expect, it } from "vitest";
import {
  buildOpportunityAnalysis,
  buildPropertyReportShare,
  buildPublicSharedPropertyReport,
  resolvePlanEntitlements,
} from "@/lib/property-reports";
import type { Json } from "@/integrations/supabase/types";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { computeAcquisitionCosts, computeRentabilityScore } from "@/lib/profitability";
import { buildCeilingSnapshot } from "./property-report/analysis";

describe("property report sharing", () => {
  it("does not recreate a withdrawn documentary score from financial indicators", () => {
    const sale = { ...EXAMPLE_SALE, investment_score: null, score_confidence: 0.9 };
    const result = buildOpportunityAnalysis({
      sale,
      surfaceM2: 80,
      marketEstimate: null,
      ceilingSnapshot: buildCeilingSnapshot(sale, null),
    });
    expect(result.score).toBeNull();
    expect(result.scoreConfidencePct).toBeNull();
    expect(result.label).toBe("À compléter");
    expect(result.summary).not.toMatch(/score \d/);
  });
  it("builds a public report without private user notes", () => {
    const report = buildPublicSharedPropertyReport({
      id: "report-1",
      title: "Rapport Bordeaux",
      report_kind: "opportunity",
      report_snapshot: {
        plan: "analyse",
        sale: { city: "Bordeaux", startingPrice: 120000 },
        analysis: { documentsCount: 4 },
        sourceTraceability: {
          entries: [
            {
              id: "source-1",
              kind: "judicial_listing",
              label: "Annonce judiciaire",
              sourceName: "Source test",
              url: "https://example.test/vente",
              capturedAt: "2026-07-06T09:00:00.000Z",
              confidenceLabel: "Source primaire",
              detail: "Fiche source",
              limitation: "A verifier",
            },
          ],
          limitations: ["Limiter l'interpretation aux donnees disponibles."],
          complianceNotice: "Notice test sans promesse de gain.",
        },
      } as Json,
      market_snapshot: { sampleSize: 8 } as Json,
      environmental_snapshot: null,
      ceiling_snapshot: { available: true, maxBid: 98000 } as Json,
      shared_at: "2026-07-06T10:00:00.000Z",
      share_expires_at: null,
      share_view_count: 2,
      updated_at: "2026-07-06T10:00:00.000Z",
    });

    expect(report).toMatchObject({
      id: "report-1",
      title: "Rapport Bordeaux",
      plan: "analyse",
      sale: { city: "Bordeaux", startingPrice: 120000 },
      analysis: { documentsCount: 4 },
      viewCount: 2,
      sourceTrace: [{ label: "Annonce judiciaire", sourceName: "Source test" }],
      limitations: ["Limiter l'interpretation aux donnees disponibles."],
      disclaimer: "Notice test sans promesse de gain.",
    });
    expect(JSON.stringify(report)).not.toContain("user_notes");
  });

  it("strips Analyse-only details from public Decouverte shared reports", () => {
    const report = buildPublicSharedPropertyReport({
      id: "report-locked",
      title: "Rapport limité",
      report_kind: "opportunity",
      report_snapshot: {
        plan: "decouverte",
        sale: { city: "Bordeaux", startingPrice: 120000 },
        analysis: {
          documentsCount: 4,
          marketComparablesAnalysis: {
            available: true,
            retainedComparables: ["vente DVF détaillée"],
            addressHistory: ["historique adresse détaillé"],
          },
          valuationBacktest: {
            available: true,
            summary: { interpretation: "backtest avancé" },
          },
          urbanPlanningAnalysis: {
            available: true,
            status: "documented",
            items: ["signal urbanisme"],
            missingChecks: ["contrôle PLU"],
          },
          streetFacadeAnalysis: {
            available: true,
            streetLevelUrl: "https://maps.example.test/street-level",
            summary: "vue façade exploitable",
          },
          neighborhoodAnalysis: {
            available: true,
            summary: "quartier profilé",
            signals: ["signal quartier"],
          },
          activeComparablesAnalysis: {
            available: true,
            summary: "3 biens comparables actifs",
            items: ["bien concurrent"],
          },
        },
        sourceTraceability: {
          entries: [],
          limitations: [],
          complianceNotice: "Notice test.",
        },
      } as Json,
      market_snapshot: { sampleSize: 8 } as Json,
      environmental_snapshot: null,
      ceiling_snapshot: { available: true, maxBid: 98000 } as Json,
      shared_at: "2026-07-06T10:00:00.000Z",
      share_expires_at: null,
      share_view_count: 0,
      updated_at: "2026-07-06T10:00:00.000Z",
    });

    const analysis = report.analysis;
    const marketComparables = record(analysis.marketComparablesAnalysis);
    const urbanPlanning = record(analysis.urbanPlanningAnalysis);
    const streetFacade = record(analysis.streetFacadeAnalysis);
    const neighborhood = record(analysis.neighborhoodAnalysis);
    const activeComparables = record(analysis.activeComparablesAnalysis);

    expect(marketComparables.retainedComparables).toEqual([]);
    expect(marketComparables.addressHistory).toEqual([]);
    expect(analysis.valuationBacktest).toBeNull();
    expect(urbanPlanning).toMatchObject({ available: false, items: [], missingChecks: [] });
    expect(streetFacade).toMatchObject({ available: false, streetLevelUrl: null });
    expect(neighborhood).toMatchObject({ available: false, signals: [] });
    expect(activeComparables).toMatchObject({ available: false, items: [] });
  });

  it("keeps Analyse details in public shared reports", () => {
    const report = buildPublicSharedPropertyReport({
      id: "report-analyse",
      title: "Rapport Analyse",
      report_kind: "opportunity",
      report_snapshot: {
        plan: "analyse",
        sale: { city: "Bordeaux", startingPrice: 120000 },
        analysis: {
          marketComparablesAnalysis: {
            available: true,
            retainedComparables: ["vente DVF détaillée"],
            addressHistory: ["historique adresse détaillé"],
          },
          valuationBacktest: {
            available: true,
            summary: { interpretation: "backtest avancé" },
          },
          urbanPlanningAnalysis: {
            available: true,
            status: "documented",
            items: ["signal urbanisme"],
            missingChecks: ["contrôle PLU"],
          },
          streetFacadeAnalysis: {
            available: true,
            streetLevelUrl: "https://maps.example.test/street-level",
          },
          neighborhoodAnalysis: {
            available: true,
            signals: ["signal quartier"],
          },
          activeComparablesAnalysis: {
            available: true,
            items: ["bien concurrent"],
          },
        },
        sourceTraceability: {
          entries: [],
          limitations: [],
          complianceNotice: "Notice test.",
        },
      } as Json,
      market_snapshot: { sampleSize: 8 } as Json,
      environmental_snapshot: null,
      ceiling_snapshot: { available: true, maxBid: 98000 } as Json,
      shared_at: "2026-07-06T10:00:00.000Z",
      share_expires_at: null,
      share_view_count: 0,
      updated_at: "2026-07-06T10:00:00.000Z",
    });

    const analysis = report.analysis;

    expect(record(analysis.marketComparablesAnalysis).retainedComparables).toEqual([
      "vente DVF détaillée",
    ]);
    expect(record(analysis.marketComparablesAnalysis).addressHistory).toEqual([
      "historique adresse détaillé",
    ]);
    expect(record(analysis.valuationBacktest).available).toBe(true);
    expect(record(analysis.urbanPlanningAnalysis).items).toEqual(["signal urbanisme"]);
    expect(record(analysis.streetFacadeAnalysis).streetLevelUrl).toBe(
      "https://maps.example.test/street-level",
    );
    expect(record(analysis.neighborhoodAnalysis).signals).toEqual(["signal quartier"]);
    expect(record(analysis.activeComparablesAnalysis).items).toEqual(["bien concurrent"]);
  });

  it("creates a page URL only for active non-expired share links", () => {
    const active = buildPropertyReportShare(
      {
        share_enabled: true,
        share_token: "abcDEF123_-abcDEF123_-abcDEF123",
        shared_at: "2026-07-06T10:00:00.000Z",
        share_expires_at: null,
        share_view_count: 0,
      },
      "https://app.immojudis.test",
    );

    const disabled = buildPropertyReportShare(
      {
        share_enabled: false,
        share_token: "abcDEF123_-abcDEF123_-abcDEF123",
        shared_at: null,
        share_expires_at: null,
        share_view_count: 0,
      },
      "https://app.immojudis.test",
    );

    expect(active.url).toBe(
      "https://app.immojudis.test/reports/shared/abcDEF123_-abcDEF123_-abcDEF123",
    );
    expect(disabled.url).toBeNull();
  });

  it("builds opportunity metrics for judicial-sale reports", () => {
    const acquisition = computeAcquisitionCosts({ price: 140_000, works: 25_000, fpt: 5_000 });
    const opportunity = buildOpportunityAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        starting_price_eur: 120_000,
        app_surface_m2: 80,
        department: "33",
        investment_score: 78,
        score_confidence: 0.84,
      },
      surfaceM2: 80,
      marketEstimate: {
        source: "DVF Cerema",
        yearsBack: 3,
        areaKind: "urban",
        commune: "Bordeaux",
        medianPricePerM2: 2_000,
        p25PricePerM2: 1_800,
        p75PricePerM2: 2_300,
        estimatedValueLowEur: 116_000,
        estimatedValueHighEur: 249_000,
        minPricePerM2: 1_500,
        maxPricePerM2: 2_800,
        sampleSize: 12,
        parcelSampleSize: 0,
        totalNearbySampleSize: 16,
        outliersRemoved: 1,
        radiusM: 900,
        qualityScore: 76,
        qualityLabel: "correcte",
        qualityWarnings: [],
        comparableMode: "surface_matched",
        surfaceMinM2: 56,
        surfaceMaxM2: 104,
        deviationPct: null,
        addressHistory: [],
        recentTransactions: [],
      },
      ceilingSnapshot: {
        scenario: "prudent",
        available: true,
        reason: null,
        maxBid: 130_000,
        maxBidWithoutWorks: 160_000,
        maxBidWithRefreshWorks: 130_000,
        refreshWorksBudget: 30_000,
        targetTotalCost: 145_000,
        marketReferencePricePerM2: 2_000,
        safetyDiscountPct: 8,
        marginTotal: 8_000,
        marginPerM2: 100,
        acquisition,
      },
    });

    expect(opportunity.rentabilityScore).toEqual(
      computeRentabilityScore({
        surface: 80,
        price: 140_000,
        works: 25_000,
        fpt: 5_000,
        department: "33",
        marketMarginPerM2: 100,
      }),
    );
    expect(opportunity.acquisitionCosts.price).toBe(140_000);
    expect(opportunity).toMatchObject({
      score: 78,
      scoreConfidencePct: 84,
      label: "À étudier en priorité",
      startingPricePerM2: 1_500,
      estimatedMarketValue: 160_000,
      estimatedMarketLow: 116_000,
      estimatedMarketHigh: 249_000,
      estimatedMarketRangeLabel: "Fourchette de valeur estimée",
      apparentDiscountPct: 25,
      grossYieldPct: 10.2,
      rentabilityScore: {
        available: true,
        rentSource: "department_estimate",
        monthlyRent: 1_120,
      },
      acquisitionCosts: {
        acquisitionFeesTotal: Math.round(acquisition.acquisitionFeesTotal),
        totalCost: Math.round(acquisition.totalCost),
      },
      bidCeiling: {
        maxBid: 130_000,
        marginTotal: 8_000,
      },
    });
  });

  it("gives administrators Analyse entitlements for premium offer testing", async () => {
    const auth = {
      userId: "11111111-1111-4111-8111-111111111111",
      claims: { app_metadata: { role: "admin" } },
      accountTier: "premium",
      userRole: "admin",
      isAdmin: true,
      supabase: {
        from() {
          throw new Error("Admin entitlements should not query user_subscriptions.");
        },
      },
    } as unknown as SupabaseAuthContext;

    const plan = await resolvePlanEntitlements(auth);

    expect(plan.plan).toBe("analyse");
    expect(plan.hasAnalysisAccess).toBe(true);
    expect(plan.features.realtimeAlertChanges).toBe("included");
    expect(plan.features.workspaceCollaboration).toBe("included");
    expect(plan.features.outcomeGraph).toBe("included");
    expect(plan.limits.workspaceCollaborators).toBeNull();
    expect(plan.limits.watchedZones).toBeNull();
    expect(plan.limits.apiKeys).toBeNull();
  });

  it("keeps commercial Analyse quotas for a manually promoted premium user", async () => {
    const auth = {
      userId: "22222222-2222-4222-8222-222222222222",
      claims: {},
      accountTier: "premium",
      userRole: "user",
      isAdmin: false,
      supabase: {
        from() {
          throw new Error("Manual premium entitlements should not query user_subscriptions.");
        },
      },
    } as unknown as SupabaseAuthContext;

    const plan = await resolvePlanEntitlements(auth);

    expect(plan.plan).toBe("analyse");
    expect(plan.features.outcomeGraph).toBe("included");
    expect(plan.limits.apiKeys).toBe(2);
    expect(plan.limits.watchedZones).toBe(25);
    expect(plan.limits.workspaceCollaborators).toBe(25);
  });
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
