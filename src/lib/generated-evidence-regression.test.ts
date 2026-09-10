import { expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildRenovationAnalysis } from "@/lib/renovation-analysis";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";
import { buildNeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import { buildNearbyServicesAnalysis } from "@/lib/nearby-services";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";

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
