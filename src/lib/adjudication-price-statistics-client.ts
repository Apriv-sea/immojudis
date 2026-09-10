import { supabase } from "@/integrations/supabase/client";
import {
  adjudicationPriceStatisticsResponseSchema,
  type AdjudicationPriceStatisticsResponse,
} from "@/lib/adjudication-price-statistics";

export async function fetchAdjudicationPriceStatistics(
  saleId: string,
): Promise<AdjudicationPriceStatisticsResponse> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Connexion requise.");

  const response = await fetch(
    `/api/v1/sales/${encodeURIComponent(saleId)}/adjudication-statistics`,
    {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | (unknown & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }
  return adjudicationPriceStatisticsResponseSchema.parse(payload);
}
