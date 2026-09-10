import { useQuery } from "@tanstack/react-query";
import { fetchOutcomeGraphForecast } from "@/lib/client-api";

export function useOutcomeGraphForecast(saleId: string, enabled = true) {
  return useQuery({
    queryKey: ["outcome-graph", saleId],
    queryFn: () => fetchOutcomeGraphForecast({ saleId }),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export type OutcomeGraphForecastQuery = ReturnType<typeof useOutcomeGraphForecast>;
