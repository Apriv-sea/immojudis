import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { getAdjudicationPriceStatisticsForSale } from "@/lib/adjudication-price-statistics-repository";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { recordFeatureUsageEvent } from "@/lib/usage";

const paramsSchema = z.object({ id: z.string().uuid() });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = createApiRequestContext(request, "adjudication-price-statistics.sale");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Statistiques d’adjudication réservées au plan Analyse.",
    );
    const { id: saleId } = paramsSchema.parse(await params);
    const statistics = await getAdjudicationPriceStatisticsForSale(saleId);

    recordUsageSafely({
      auth,
      eventKey: "tribunal.statistics_viewed",
      subjectType: "auction_sale",
      subjectId: saleId,
      metadata: {
        window_months: 36,
        national_sample_size: statistics.national.sampleSize,
        tribunal_available: statistics.tribunal !== null,
        experimental: true,
      },
    });

    return apiJson(statistics, context, {
      headers: {
        "cache-control": "private, no-store",
        vary: "authorization",
      },
    });
  } catch (error) {
    const response = apiError(error, context, {
      fallbackMessage: "Statistiques d’adjudication temporairement indisponibles.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("vary", "authorization");
    return response;
  }
}

function recordUsageSafely(input: Parameters<typeof recordFeatureUsageEvent>[0]): void {
  try {
    void recordFeatureUsageEvent(input).catch(() => undefined);
  } catch {
    // Telemetry must never delay or fail a Premium statistics read.
  }
}
