import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Dispatch = { id: string; source: string; mode: "collect" | "enrichment" };
type Rpc = {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ data: Dispatch | null; error: { message?: string } | null }>;
};

/** Called by the existing authenticated 15-minute health tick. SQL owns due times. */
export async function dispatchDuePipeline(): Promise<Record<string, unknown>> {
  const token =
    process.env.GITHUB_SCROLL_TOKEN ??
    process.env.IMMOJUDIS_GITHUB_ACTIONS_TOKEN ??
    process.env.GITHUB_ACTIONS_DISPATCH_TOKEN;
  if (!token) throw new Error("Pipeline dispatch token missing; scheduled collection unavailable");
  const client = supabaseAdmin as unknown as Rpc;
  const { data, error } = await client.rpc("claim_autonomous_pipeline_run");
  if (error) throw new Error(error.message ?? "Unable to claim scheduled pipeline work");
  if (!data) return { dispatched: false, reason: "disabled_busy_or_not_due" };
  const repository = process.env.GITHUB_SCROLL_REPOSITORY ?? "Aprivi-dev/immojudis";
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
  if (!response.ok)
    throw new Error(
      `Pipeline dispatch failed: HTTP ${response.status}; lease retained for safe retry`,
    );
  return { dispatched: true, runId: data.id, source: data.source, mode: data.mode };
}
