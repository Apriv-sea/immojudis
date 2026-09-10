import { z } from "zod";
import { computeMarketCeiling } from "./profitability";
import { getMarketValuationSurfaces } from "./surface";
import { listingValuationConflict } from "./listing-evidence";
import type { AuctionSale } from "./types";
import type { MarketEstimate } from "./market.functions";

const amount = z.number().finite().min(0).max(1_000_000_000);
export const reportSimulationSchema = z.object({
  price: amount,
  works: amount,
  fpt: amount,
  scenario: z.enum(["prudent", "offensif", "custom"]),
  customSafetyDiscountPct: z.number().finite().min(0).max(100).optional(),
  manualMarketPricePerM2: amount.nullable(),
  expectedMaxBid: amount,
});
export type ReportSimulation = z.infer<typeof reportSimulationSchema>;

/** Recompute user hypotheses against the server's current property and market data. */
export function computeReportSimulation(
  sale: AuctionSale,
  market: MarketEstimate | null,
  input: ReportSimulation,
) {
  const conflict = listingValuationConflict(sale);
  if (conflict) throw new Error(conflict);
  const result = computeMarketCeiling({
    ...input,
    surface: getMarketValuationSurfaces(sale).builtSurfaceM2,
    medianPricePerM2: market?.actionable ? market.medianPricePerM2 : null,
    p25PricePerM2: market?.actionable ? market.p25PricePerM2 : null,
    p75PricePerM2: market?.actionable ? market.p75PricePerM2 : null,
  });
  if (!result.available || Math.abs(result.maxBid - input.expectedMaxBid) > 0.01) {
    throw new Error(
      "Les données du scénario ont changé. Actualisez la fiche avant de sauvegarder le rapport.",
    );
  }
  return result;
}
