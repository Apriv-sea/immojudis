import { expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildRenovationAnalysis } from "@/lib/renovation-analysis";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";
import { buildNeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import { buildNearbyServicesAnalysis } from "@/lib/nearby-services";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";
import {
  isPrimaryUrbanPlanningSignal,
  type StructuredUrbanPlanningSignal,
} from "@/lib/urban-planning-analysis";

it("rejects stored generated urban-planning evidence while retaining primary excerpts", () => {
  const base = {
    sourceKind: "source_payload",
    excerpt: "Servitude de passage à confirmer dans le cahier.",
  } as StructuredUrbanPlanningSignal;
  expect(isPrimaryUrbanPlanningSignal(base)).toBe(true);
  expect(isPrimaryUrbanPlanningSignal({ ...base, sourceKind: "pdf" })).toBe(true);
  for (const sourceKind of ["llm", "score_factor"]) {
    expect(isPrimaryUrbanPlanningSignal({ ...base, sourceKind })).toBe(false);
  }
  for (const excerpt of [
    "asset_normalization.score_factors[0].normalized_value.question: Les servitudes sont-elles maîtrisées ?",
    "observations[0].raw_payload.asset_normalization.score_factors[0].normalized_value.question: copropriété",
    "investment_summary: Usage commercial favorable",
  ])
    expect(isPrimaryUrbanPlanningSignal({ ...base, excerpt })).toBe(false);
});

it("does not turn generated summaries or scores into independent property evidence", () => {
  const generated = "Studio loué en bon état général d'entretien au cœur du centre-ville à ANGLET.";
  const sale = {
    ...EXAMPLE_SALE,
    occupancy_status: "unknown" as const,
    description: null,
    source_description: null,
    risk_notes: null,
    llm_display_description: generated,
    about_description: generated,
    investment_summary: generated,
    source_blocks: {},
    source_blocks_by_source: {},
    risks: [],
    documents_rich: [],
    score_factors: [
      {
        factor_key: "asset_quality",
        delta: 4,
        label: generated,
        reason: generated,
        evidence: generated,
      },
    ],
  };
  expect(buildRenovationAnalysis({ sale, surfaceM2: 21 }).status).toBe("unknown");
  expect(buildOccupancyAnalysis(sale).status).toBe("to_confirm");
  const neighborhood = buildNeighborhoodAnalysis({
    sale,
    marketEstimate: null,
    nearbyServices: buildNearbyServicesAnalysis(sale),
    streetFacade: buildStreetFacadeAnalysis(sale),
    environmentalContext: null,
  });
  expect(neighborhood.signals.filter((signal) => signal.kind === "source")).toEqual([]);
  const sourced = { ...sale, source_description: "Studio en bon état général à Biarritz." };
  expect(buildRenovationAnalysis({ sale: sourced, surfaceM2: 21 }).status).toBe("good");
});
