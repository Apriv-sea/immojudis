import {
  tribunalJudicialActivityResponseSchema,
  TribunalCourtUnresolvedError,
  type TribunalJudicialActivityHistoryMonths,
  type TribunalJudicialActivityResponse,
} from "@/lib/tribunal-judicial-activity";

type TribunalJudicialActivityClientQuery =
  | { courtCode: string; saleId?: never }
  | { courtCode?: never; saleId: string };

export async function fetchTribunalJudicialActivity(
  args: TribunalJudicialActivityClientQuery & {
    historyMonths?: TribunalJudicialActivityHistoryMonths;
  },
): Promise<TribunalJudicialActivityResponse> {
  const params = new URLSearchParams({
    historyMonths: String(args.historyMonths ?? 36),
  });
  if (typeof args.saleId === "string") params.set("saleId", args.saleId);
  else params.set("courtCode", args.courtCode.trim());
  const response = await fetch(`/api/v1/tribunals/judicial-activity?${params.toString()}`);
  const payload = (await response.json().catch(() => null)) as
    | (unknown & { error?: string; code?: string })
    | null;
  if (!response.ok) {
    if (response.status === 422 && payload?.code === "COURT_UNRESOLVED") {
      throw new TribunalCourtUnresolvedError();
    }
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }
  return tribunalJudicialActivityResponseSchema.parse(payload);
}
