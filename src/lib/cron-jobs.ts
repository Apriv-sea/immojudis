import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deliverOperationalAlertNotifications } from "@/lib/operational-alerts";
import { resolveRequestId } from "@/lib/request-id";

type CronRpcClient = {
  rpc(
    name: "begin_operational_job_run",
    args: { p_job_name: string },
  ): Promise<{ data: string | null; error: { message?: string } | null }>;
  rpc(
    name: "finish_operational_job_run",
    args: {
      p_error_message: string | null;
      p_run_id: string;
      p_status: "success" | "failed";
      p_summary: Record<string, unknown>;
    },
  ): Promise<{ data: null; error: { message?: string } | null }>;
  rpc(
    name: "run_data_retention",
    args: { p_now: string },
  ): Promise<{ data: Record<string, number> | null; error: { message?: string } | null }>;
  rpc(
    name: "evaluate_operational_health",
    args: { p_now: string },
  ): Promise<{ data: Record<string, unknown> | null; error: { message?: string } | null }>;
  rpc(
    name: "evaluate_market_valuation_health" | "observe_autonomous_pipeline",
    args: { p_now: string },
  ): Promise<{ data: Record<string, unknown> | null; error: { message?: string } | null }>;
};

export async function runMonitoredCron(
  request: Request,
  jobName: string,
  handler: () => Promise<Record<string, unknown>>,
) {
  const startedAt = Date.now();
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  if (!cronRequestAuthorized(request)) {
    logCron("warn", {
      requestId,
      jobName,
      durationMs: Date.now() - startedAt,
      status: 401,
      outcome: "unauthorized",
    });
    return NextResponse.json(
      { ok: false, error: "Unauthorized", code: "AUTH_REQUIRED", requestId },
      { status: 401, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }

  const runId = await beginRun(jobName);

  try {
    const result = await handler();
    const durationMs = Date.now() - startedAt;
    await finishRun(runId, "success", result, null);
    logCron("info", {
      requestId,
      runId,
      jobName,
      durationMs,
      status: 200,
      outcome: "success",
      summary: result,
    });
    return NextResponse.json(
      {
        ok: true,
        ...result,
        requestId,
        runId,
        schedule: request.headers.get("x-vercel-cron-schedule"),
      },
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch (error) {
    const message = operationalErrorMessage(error);
    const durationMs = Date.now() - startedAt;
    await finishRun(runId, "failed", {}, message);
    logCron("error", {
      requestId,
      runId,
      jobName,
      durationMs,
      status: 500,
      outcome: "failed",
      message,
    });
    return NextResponse.json(
      { ok: false, error: "Scheduled job failed", code: "JOB_FAILED", requestId, runId },
      { status: 500, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
}

export function operationalErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint, record.code]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    if (parts.length) return [...new Set(parts)].join(" · ");
  }
  return "Scheduled job failed";
}

export async function runDataRetention(now = new Date()): Promise<Record<string, unknown>> {
  const client = supabaseAdmin as unknown as CronRpcClient;
  const { data, error } = await client.rpc("run_data_retention", { p_now: now.toISOString() });
  if (error) throw new Error(error.message || "Data retention failed.");
  return { deleted: data ?? {} };
}

export async function evaluateOperationalHealth(
  now = new Date(),
): Promise<Record<string, unknown>> {
  const client = supabaseAdmin as unknown as CronRpcClient;
  const args = { p_now: now.toISOString() };
  const results = await Promise.allSettled([
    client.rpc("evaluate_operational_health", args),
    client.rpc("evaluate_market_valuation_health", args),
    client.rpc("observe_autonomous_pipeline", args),
  ]);
  // Deliver incidents even when an independent evaluator fails.
  const delivery = await deliverOperationalAlertNotifications();
  const failures = results.flatMap((result) =>
    result.status === "rejected"
      ? [operationalErrorMessage(result.reason)]
      : result.value.error
        ? [result.value.error.message ?? "Health evaluation failed"]
        : [],
  );
  if (failures.length) throw new Error(failures.join("; "));
  const data = results.map((result) =>
    result.status === "fulfilled" ? (result.value.data ?? {}) : {},
  );
  return { health: data[0], valuation: data[1], pipeline: data[2], externalAlerts: delivery };
}

export function positiveNumberFromEnv(name: string): number | undefined {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function cronRequestAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization) return false;
  return safeEqual(authorization, `Bearer ${secret}`);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function beginRun(jobName: string): Promise<string | null> {
  try {
    const client = supabaseAdmin as unknown as CronRpcClient;
    const { data, error } = await client.rpc("begin_operational_job_run", { p_job_name: jobName });
    if (error) throw new Error(error.message || "Unable to create job run.");
    return data;
  } catch (error) {
    logCron("error", {
      jobName,
      status: "monitoring_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function finishRun(
  runId: string | null,
  status: "success" | "failed",
  summary: Record<string, unknown>,
  errorMessage: string | null,
): Promise<void> {
  if (!runId) return;
  try {
    const client = supabaseAdmin as unknown as CronRpcClient;
    const { error } = await client.rpc("finish_operational_job_run", {
      p_error_message: errorMessage,
      p_run_id: runId,
      p_status: status,
      p_summary: summary,
    });
    if (error) throw new Error(error.message || "Unable to finish job run.");
  } catch (error) {
    logCron("error", {
      runId,
      status: "monitoring_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function logCron(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ scope: "cron", timestamp: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
