"use client";

import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { SaleDetailSkeleton } from "@/components/SaleDetailView";
import type { MarketEstimate } from "@/lib/market.functions";
import type { AuctionSale } from "@/lib/types";

const AnalysisSaleDetailView = dynamic(
  () =>
    import("@/components/SimplifiedSaleDetailView").then((module) => module.AnalysisSaleDetailView),
  { loading: () => <SaleDetailSkeleton /> },
);

export function ExampleSalePage({
  examples,
}: {
  examples: Record<
    "bordeaux" | "nantes" | "toulouse",
    { sale: AuctionSale; marketEstimate: MarketEstimate }
  >;
}) {
  const requestedKey = useSearchParams().get("bien");
  const exampleKey =
    requestedKey === "nantes" || requestedKey === "toulouse" ? requestedKey : "bordeaux";
  const example = examples[exampleKey];

  return (
    <AnalysisSaleDetailView
      sale={example.sale}
      marketEstimateOverride={example.marketEstimate}
      returnTo="/#exemples"
      backLabel="Retour aux exemples"
      publicDemo
    />
  );
}
