import { describe, expect, it } from "vitest";
import type { AuctionCostAnalysis } from "@/lib/auction-cost-analysis";
import { buildAudienceReadinessAnalysis } from "@/lib/audience-readiness-analysis";
import type { LegalAttentionAnalysis } from "@/lib/legal-attention-analysis";
import type { OccupancyAnalysis } from "@/lib/occupation-analysis";
import type { RenovationAnalysis } from "@/lib/renovation-analysis";
import { EXAMPLE_SALE } from "@/lib/example-sale";

const now = new Date("2026-07-06T12:00:00.000Z");

describe("audience readiness analysis", () => {
  it.each([
    ["2026-09-10T14:30:00Z", "2026-09-10T10:00:00Z", 0, "today"],
    ["2026-09-10T22:30:00Z", "2026-09-10T20:00:00Z", 1, "week"],
    ["2026-09-10T00:30:00Z", "2026-09-09T22:30:00Z", 0, "today"],
    ["2026-03-29T10:00:00Z", "2026-03-28T10:00:00Z", 1, "week"],
    ["2026-10-25T11:00:00Z", "2026-10-24T10:00:00Z", 1, "week"],
    ["2026-09-09T14:30:00Z", "2026-09-10T10:00:00Z", -1, "past"],
  ])("counts French calendar days for %s at %s", (saleDate, clock, days, urgency) => {
    const analysis = buildAudienceReadinessAnalysis({
      sale: { ...EXAMPLE_SALE, sale_date: saleDate },
      documents: [],
      auctionCostAnalysis: costAnalysis({ withConsignation: true }),
      occupancyAnalysis: occupancyAnalysis("free"),
      renovationAnalysis: renovationAnalysis("good"),
      legalAttentionAnalysis: legalAttentionAnalysis("low"),
      bidCeilingAvailable: true,
      now: new Date(clock),
    });
    expect(analysis.daysUntilAudience).toBe(days);
    expect(analysis.urgency).toBe(urgency);
    if (days === 0) expect(analysis.urgencyLabel).toBe("Audience aujourd'hui");
  });

  it.each(["", "javascript:alert(1)", "https://example.test/conditions.pdf"])(
    "requires a usable document URL before marking conditions present: %s",
    (url) => {
      const analysis = buildAudienceReadinessAnalysis({
        sale: EXAMPLE_SALE,
        documents: [
          {
            url,
            label: "Cahier des conditions",
            type: "cahier_conditions",
            extraction_status: null,
          },
        ],
        auctionCostAnalysis: costAnalysis({ withConsignation: true }),
        occupancyAnalysis: occupancyAnalysis("free"),
        renovationAnalysis: renovationAnalysis("light_refresh"),
        legalAttentionAnalysis: legalAttentionAnalysis("low"),
        bidCeilingAvailable: true,
        now,
      });
      expect(analysis.checklist.find((item) => item.key === "conditions")?.status).toBe(
        url.startsWith("https:") ? "done" : "to_do",
      );
    },
  );
  it("recovers the actual dated visit from source text when the structured field only names the organizer", () => {
    const analysis = buildAudienceReadinessAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        visit_dates: ["SAS MAS LABORIE Commissaires de Justice."],
        source_description: "Visite le jeudi 3 septembre 2026 à 11 h 00. SAS MAS LABORIE.",
        source_blocks: {},
        source_blocks_by_source: {},
      },
      documents: [],
      auctionCostAnalysis: costAnalysis({ withConsignation: true }),
      occupancyAnalysis: occupancyAnalysis("free"),
      renovationAnalysis: renovationAnalysis("light_refresh"),
      legalAttentionAnalysis: legalAttentionAnalysis("low"),
      bidCeilingAvailable: true,
      now: new Date("2026-09-09T12:00:00Z"),
    });
    expect(analysis.visitDates.some((date) => date.includes("3 septembre 2026"))).toBe(true);
    expect(analysis.checklist.find((item) => item.key === "visits")).toMatchObject({
      status: "watch",
      detail: "Les créneaux datés repérés sont passés. Aucun nouveau rendez-vous confirmé.",
    });
  });
  it.each([
    ["2026-07-03 à 11:00", "watch"],
    ["Sur rendez-vous", "watch"],
    ["2026-07-06 à 11:00", "done"],
    ["2026-07-09 à 11:00", "done"],
  ])("qualifies the visit mention %s without assuming attendance", (visit, status) => {
    const analysis = buildAudienceReadinessAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        visit_dates: [visit],
        source_blocks: {},
        source_blocks_by_source: {},
      },
      documents: [],
      auctionCostAnalysis: costAnalysis({ withConsignation: true }),
      occupancyAnalysis: occupancyAnalysis("free"),
      renovationAnalysis: renovationAnalysis("light_refresh"),
      legalAttentionAnalysis: legalAttentionAnalysis("low"),
      bidCeilingAvailable: true,
      now,
    });
    expect(analysis.checklist.find((item) => item.key === "visits")?.status).toBe(status);
  });

  it("marks a sale ready when the key audience controls are present", () => {
    const analysis = buildAudienceReadinessAnalysis({
      sale: EXAMPLE_SALE,
      documents: (EXAMPLE_SALE.documents_rich ?? []).map((document, index) => ({
        ...document,
        url: `https://example.test/document-${index}.pdf`,
      })),
      auctionCostAnalysis: costAnalysis({ withConsignation: true }),
      occupancyAnalysis: occupancyAnalysis("free"),
      renovationAnalysis: renovationAnalysis("light_refresh"),
      legalAttentionAnalysis: legalAttentionAnalysis("low"),
      bidCeilingAvailable: true,
      now,
    });

    expect(analysis).toMatchObject({
      status: "ready",
      urgency: "later",
      progressPct: 100,
      highPriorityOpenCount: 0,
    });
    expect(analysis.checklist.find((item) => item.key === "consignation")).toMatchObject({
      status: "done",
    });
  });

  it("flags urgent preparation when the audience is close and priority controls are open", () => {
    const analysis = buildAudienceReadinessAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        sale_date: "2026-07-09T09:00:00+02:00",
        visit_dates: [],
        documents_rich: [],
        occupancy_status: "unknown",
      },
      documents: [],
      auctionCostAnalysis: costAnalysis({ withConsignation: false }),
      occupancyAnalysis: occupancyAnalysis("to_confirm"),
      renovationAnalysis: renovationAnalysis("unknown"),
      legalAttentionAnalysis: legalAttentionAnalysis("high"),
      bidCeilingAvailable: false,
      now,
    });

    expect(analysis).toMatchObject({
      status: "urgent",
      urgency: "week",
      daysUntilAudience: 3,
    });
    expect(analysis.highPriorityOpenCount).toBeGreaterThanOrEqual(4);
    expect(analysis.nextActions[0]).toContain("consignation");
  });

  it("keeps missing audience dates explicit", () => {
    const analysis = buildAudienceReadinessAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        sale_date: null,
      },
      documents: EXAMPLE_SALE.documents_rich ?? [],
      auctionCostAnalysis: costAnalysis({ withConsignation: true }),
      occupancyAnalysis: occupancyAnalysis("free"),
      renovationAnalysis: renovationAnalysis("good"),
      legalAttentionAnalysis: legalAttentionAnalysis("low"),
      bidCeilingAvailable: true,
      now,
    });

    expect(analysis).toMatchObject({
      status: "missing_date",
      urgency: "unknown",
      daysUntilAudience: null,
    });
    expect(analysis.decisionImpact).toContain("date stabilisée");
  });
});

function costAnalysis({ withConsignation }: { withConsignation: boolean }): AuctionCostAnalysis {
  return {
    available: true,
    status: withConsignation ? "costed_with_consignation" : "costed",
    confidence: withConsignation ? "high" : "medium",
    confidenceLabel: withConsignation
      ? "Simulation frais + consignation source"
      : "Simulation frais à la mise à prix",
    startingPriceEur: 92_000,
    estimatedFeesEur: 14_000,
    estimatedFeesPct: 15.2,
    totalCostAtStartingPriceEur: 106_000,
    totalCostAtSimulatedPriceEur: 106_000,
    emolumentsTtcEur: 3_500,
    registrationDutiesEur: 5_800,
    forfaitFraisPoursuiteEur: 3_000,
    consignation: withConsignation
      ? {
          amountEur: 9_200,
          label: "Consignation",
          source: "Données source",
        }
      : null,
    paymentTerms: [],
    sourceFeeSignals: [],
    summary: withConsignation
      ? "frais simulés 14 000 € · consignation repérée 9 200 €."
      : "frais simulés 14 000 €.",
    nextActions: [],
    limitations: [],
  };
}

function occupancyAnalysis(status: OccupancyAnalysis["status"]): OccupancyAnalysis {
  return {
    available: true,
    status,
    label: status,
    confidence: status === "to_confirm" ? "low" : "high",
    confidenceLabel: "Statut test",
    hasLeaseSignal: false,
    hasEvictionSignal: false,
    evidence: [],
    sources: [],
    summary: status === "free" ? "Libre." : "Occupation à confirmer.",
    decisionImpact: "",
    nextActions: ["Confirmer l'occupation exacte dans les pièces."],
    limitations: [],
  };
}

function renovationAnalysis(status: RenovationAnalysis["status"]): RenovationAnalysis {
  return {
    available: status !== "unknown",
    status,
    label: status,
    priority: status === "unknown" ? "unknown" : status === "heavy_works" ? "high" : "medium",
    priorityLabel: "Test",
    budgetLevel: status === "unknown" ? "unknown" : "light",
    confidence: status === "unknown" ? "low" : "medium",
    confidenceLabel: "Signal travaux test",
    budgetRange:
      status === "unknown"
        ? null
        : { lowEur: 6_000, highEur: 15_000, lowPerM2: 150, highPerM2: 350, surfaceM2: 42 },
    evidence: [],
    sources: [],
    summary: status === "unknown" ? "État à qualifier." : "Travaux qualifiés.",
    decisionImpact: "",
    nextActions: ["Reporter l'enveloppe travaux dans le calcul de mise maximale."],
    limitations: [],
  };
}

function legalAttentionAnalysis(
  priority: LegalAttentionAnalysis["priority"],
): LegalAttentionAnalysis {
  return {
    available: true,
    priority,
    confidenceLabel: "Revue test",
    items: [],
    missingDocuments: [],
    summary: priority === "low" ? "Points juridiques contrôlés." : "Points juridiques ouverts.",
    nextActions: ["Relire le cahier des conditions."],
    disclaimer: "Test.",
  };
}
