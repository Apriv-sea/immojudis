import { describe, expect, it } from "vitest";
import {
  featureIncluded,
  isPlanPeriodActive,
  normalizePlanCode,
  PLAN_FEATURES,
  PLAN_LABELS,
  PLAN_LIMITS,
} from "@/lib/plans";

describe("plan matrix", () => {
  it("exposes exactly Découverte and Analyse while folding legacy plans into Analyse", () => {
    expect(Object.keys(PLAN_LABELS)).toEqual(["decouverte", "analyse"]);
    expect(normalizePlanCode("investisseur")).toBe("analyse");
    expect(normalizePlanCode("analyse")).toBe("analyse");
    expect(normalizePlanCode("unknown")).toBe("decouverte");
  });

  it("keeps premium features locked while exposing lawyer discovery and one comparison", () => {
    const unexpectedlyUnlocked = Object.entries(PLAN_FEATURES.decouverte)
      .filter(
        (feature) =>
          ![
            "sales.filters",
            "alerts.advanced",
            "alerts.watchedZones",
            "sales.favorites",
            "sales.multiPropertyAnalysis",
            "lawyers.directory",
          ].includes(feature[0]),
      )
      .filter(([, access]) => access !== "locked");

    expect(unexpectedlyUnlocked).toEqual([]);
    expect(featureIncluded("decouverte", "lawyers.directory")).toBe(true);
    expect(PLAN_FEATURES.decouverte["sales.multiPropertyAnalysis"]).toBe("limited");
    expect(featureIncluded("decouverte", "lawyers.referrals")).toBe(false);
    expect(featureIncluded("decouverte", "property.outcomeGraph")).toBe(false);
    expect(featureIncluded("decouverte", "property.informationAgent")).toBe(false);
    expect(PLAN_LIMITS.decouverte.propertyReportsPerMonth).toBe(0);
    expect(PLAN_LIMITS.decouverte.pdfExportsPerMonth).toBe(0);
    expect(PLAN_LIMITS.decouverte.favoriteSales).toBe(10);
    expect(PLAN_LIMITS.decouverte.saleAnalysisSets).toBe(1);
    expect(PLAN_LIMITS.decouverte.saleAnalysisItems).toBe(3);
  });

  it("unlocks all analysis and collaboration capabilities for Analyse", () => {
    expect(Object.values(PLAN_FEATURES.analyse).every((access) => access === "included")).toBe(
      true,
    );
    expect(featureIncluded("analyse", "property.valueEstimate")).toBe(true);
    expect(featureIncluded("analyse", "alerts.realtimeChanges")).toBe(true);
    expect(featureIncluded("analyse", "workspace.collaboration")).toBe(true);
    expect(featureIncluded("analyse", "property.outcomeGraph")).toBe(true);
    expect(featureIncluded("analyse", "property.informationAgent")).toBe(true);
    expect(PLAN_LIMITS.analyse.informationAgentMissionsPer30Days).toBe(3);
    expect(PLAN_LIMITS.analyse.workspaceCollaborators).toBeGreaterThan(0);
  });

  it("expires paid access at the end of its 30-day period", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    expect(isPlanPeriodActive("active", "2026-07-11T10:00:00.000Z", now)).toBe(true);
    expect(isPlanPeriodActive("active", "2026-07-09T10:00:00.000Z", now)).toBe(false);
    expect(isPlanPeriodActive("expired", "2026-07-11T10:00:00.000Z", now)).toBe(false);
    expect(isPlanPeriodActive("active", null, now)).toBe(true);
  });
});
