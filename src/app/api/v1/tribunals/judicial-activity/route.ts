import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  tribunalJudicialActivityQuerySchema,
  tribunalJudicialActivityResponseSchema,
  TribunalCourtUnresolvedError,
} from "@/lib/tribunal-judicial-activity";
import { getTribunalJudicialActivity } from "@/lib/tribunal-judicial-activity-repository";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "tribunal.judicial_activity");
  try {
    const url = new URL(request.url);
    const input = tribunalJudicialActivityQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const activity = tribunalJudicialActivityResponseSchema.parse(
      await getTribunalJudicialActivity(input),
    );
    return apiJson(activity, context, {
      headers: {
        "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    if (error instanceof TribunalCourtUnresolvedError) {
      return apiJson(
        {
          ok: false,
          code: "COURT_UNRESOLVED",
          error: "Le rattachement exact au tribunal reste à confirmer.",
          requestId: context.requestId,
        },
        context,
        { status: 422 },
      );
    }
    const response = apiError(error, context, {
      fallbackMessage: "Activité judiciaire du tribunal temporairement indisponible.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "public, max-age=0, no-cache");
    return response;
  }
}
