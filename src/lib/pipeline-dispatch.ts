import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Dispatch = {
  id: string;
  source: string;
  mode: "collect" | "enrichment";
  attempt: number;
  max_attempts: number;
};
type DispatchResult = {
  updated?: boolean;
  state?: string;
  next_attempt_at?: string | null;
  reason?: string;
  status?: string;
};
type Rpc = {
  rpc(
    name: "claim_autonomous_pipeline_run",
    args?: Record<string, unknown>,
  ): Promise<{ data: Dispatch | null; error: { message?: string } | null }>;
  rpc(
    name: "record_autonomous_pipeline_dispatch",
    args?: Record<string, unknown>,
  ): Promise<{ data: DispatchResult | null; error: { message?: string } | null }>;
};

const DISPATCH_INTERVAL_MS = 15 * 60 * 1000;

/** Parse both forms allowed by RFC 9110 Retry-After. */
export function retryAfterAt(value: string | null, now = new Date()): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    const result = new Date(now.getTime() + seconds * 1000);
    return Number.isNaN(result.getTime()) ? null : result;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

export function retryableDispatchStatus(status: number): boolean {
  // Invalid credentials/permissions and a missing workflow are operator
  // errors. Retrying them every 15 minutes only hides the useful failure.
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function nextRetryAt(retryAfter: Date | null, now: Date): Date {
  return new Date(Math.max(now.getTime() + DISPATCH_INTERVAL_MS, retryAfter?.getTime() ?? 0));
}

function dispatchErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "GitHub Actions dispatch failed";
}

async function recordDispatchResult(
  client: Rpc,
  dispatch: Dispatch,
  result: {
    outcome: "accepted" | "rejected" | "unknown";
    status?: number;
    retryAfterAt?: Date | null;
    retryable?: boolean;
    error?: string;
  },
): Promise<DispatchResult | null> {
  const { data, error } = await client.rpc("record_autonomous_pipeline_dispatch", {
    p_run_id: dispatch.id,
    p_attempt: dispatch.attempt,
    p_outcome: result.outcome,
    p_status: result.status ?? null,
    p_retry_after_at: result.retryAfterAt?.toISOString() ?? null,
    p_retryable: result.retryable ?? true,
    p_error: result.error ?? null,
  });
  if (error) throw new Error(error.message ?? "Unable to record pipeline dispatch result");
  return data;
}

/** Called by the existing authenticated 15-minute health tick. SQL owns due times. */
export async function dispatchDuePipeline(): Promise<Record<string, unknown>> {
  const token =
    process.env.GITHUB_SCROLL_TOKEN ??
    process.env.IMMOJUDIS_GITHUB_ACTIONS_TOKEN ??
    process.env.GITHUB_ACTIONS_DISPATCH_TOKEN;
  // Do this before claiming a row: a missing token must not consume a retry or
  // create a lease that the scheduler cannot deliver.
  if (!token) throw new Error("Pipeline dispatch token missing; scheduled collection unavailable");

  const client = supabaseAdmin as unknown as Rpc;
  const { data, error } = await client.rpc("claim_autonomous_pipeline_run");
  if (error) throw new Error(error.message ?? "Unable to claim scheduled pipeline work");
  if (!data) return { dispatched: false, reason: "disabled_busy_or_not_due" };

  const repository = process.env.GITHUB_SCROLL_REPOSITORY ?? "Aprivi-dev/immojudis";
  let observedResult: {
    outcome: "accepted" | "rejected";
    status: number;
    retryAfterAt: Date | null;
    retryable: boolean;
    error?: string;
  } | null = null;
  let resultRecorded = false;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/workflows/data-pipeline.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: process.env.GITHUB_SCROLL_REF ?? "main",
          inputs: {
            run_id: data.id,
            source: data.mode === "collect" ? data.source : "all",
            automatic: "true",
          },
        }),
        signal: AbortSignal.timeout(12_000),
      },
    );
    const now = new Date();
    if (response.ok) {
      observedResult = {
        outcome: "accepted",
        status: response.status,
        retryAfterAt: null,
        retryable: false,
      };
      await recordDispatchResult(client, data, observedResult);
      resultRecorded = true;
      return {
        dispatched: true,
        runId: data.id,
        source: data.source,
        mode: data.mode,
        attempt: data.attempt,
      };
    }

    const retryAfter = retryAfterAt(response.headers.get("retry-after"), now);
    const retryAt = nextRetryAt(retryAfter, now);
    const message = `Pipeline dispatch failed: HTTP ${response.status}`;
    const retryable = retryableDispatchStatus(response.status);
    const outcomeMessage = `${message}; ${retryable ? `retry scheduled for ${retryAt.toISOString()}` : "operator action required"}`;
    observedResult = {
      outcome: "rejected",
      status: response.status,
      retryAfterAt: retryAfter,
      retryable,
      error: outcomeMessage,
    };
    await recordDispatchResult(client, data, observedResult);
    resultRecorded = true;
    throw new Error(outcomeMessage);
  } catch (error) {
    if (observedResult) {
      // The HTTP result is known. A failed response from the result RPC is
      // itself uncertain, so repeat the exact same CAS payload; never replace
      // a known Retry-After/status with an unknown outcome.
      if (!resultRecorded) {
        try {
          await recordDispatchResult(client, data, observedResult);
          resultRecorded = true;
        } catch (recordError) {
          throw new Error(
            `${dispatchErrorMessage(error)}; unable to persist observed outcome: ${dispatchErrorMessage(recordError)}`,
            { cause: recordError },
          );
        }
      }
      if (observedResult.outcome === "accepted") {
        return {
          dispatched: true,
          runId: data.id,
          source: data.source,
          mode: data.mode,
          attempt: data.attempt,
        };
      }
      throw new Error(observedResult.error ?? dispatchErrorMessage(error), { cause: error });
    }
    if (!resultRecorded) {
      // A timeout or connection failure has an unknown outcome: GitHub may
      // have accepted the request. The next tick retries the same run id, and
      // the worker's queued-to-running CAS prevents duplicate execution.
      try {
        await recordDispatchResult(client, data, {
          outcome: "unknown",
          retryAfterAt: null,
          retryable: true,
          error: `Dispatch outcome uncertain: ${dispatchErrorMessage(error)}`,
        });
      } catch (recordError) {
        throw new Error(
          `${dispatchErrorMessage(error)}; unable to persist uncertain outcome: ${dispatchErrorMessage(recordError)}`,
          { cause: recordError },
        );
      }
    }
    throw error instanceof Error ? error : new Error(dispatchErrorMessage(error));
  }
}
