import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeEmail } from "@/lib/account";

const SCROLL_SOURCES = [
  "all",
  "avoventes",
  "licitor",
  "vench",
  "info_encheres",
  "encheres_publiques",
  "petites_affiches",
  "cessions_etat",
  "agrasc",
  "encheres_immobilieres",
  "notaires",
] as const;

const startScrollSchema = z.object({
  source: z.enum(SCROLL_SOURCES).default("all"),
  mode: z.enum(["collect", "llm_backfill"]).default("collect"),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const AUTOMATIC_LLM_ENRICHMENT = true;
const LLM_BACKFILL_SOURCE = "llm-description-backfill";
const EXPECTED_LLM_PROMPT_VERSION = "auction_llm_v9_qwen2_7b_scan_display";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type RunnerMode = "github_actions" | "webhook" | "queue_worker";

export type AdminScrollSource = (typeof SCROLL_SOURCES)[number];
export type AdminScrollMode = "collect" | "llm_backfill";

export type AuctionRun = {
  id: string;
  status: string;
  source: string | null;
  useLlm: boolean | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  summary: JsonObject;
  errors: JsonObject;
};

export type AiDescriptionDashboardStats = {
  expectedPromptVersion: string;
  total: number;
  activeOrUpcoming: number;
  ready: number;
  missing: number;
  promptVersionMismatch: number;
  backfillRemaining: number;
};

export type AdminDashboardData = {
  checkedAt: string;
  adminEmail: string;
  runner: {
    instantDispatchConfigured: boolean;
    mode: RunnerMode;
  };
  stats: {
    sales: number;
    documents: number;
    extractions: number;
    riskOccurrences: number;
    scoreFactors: number;
    runs: number;
    queuedRuns: number;
    runningRuns: number;
    failedRuns: number;
    aiDescriptions: AiDescriptionDashboardStats;
  };
  runs: AuctionRun[];
};

export type StartScrollResult = {
  ok: boolean;
  message: string;
  dispatched: boolean;
  dispatchMode: RunnerMode;
  run: AuctionRun;
};

type QueryError = {
  message?: string;
};

type QueryResult<T> = {
  data: T[] | null;
  error: QueryError | null;
  count?: number | null;
};

type QueryBuilder<T> = PromiseLike<QueryResult<T>> & {
  order: (
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ) => QueryBuilder<T>;
  limit: (count: number) => QueryBuilder<T>;
  range: (from: number, to: number) => QueryBuilder<T>;
  eq: (column: string, value: unknown) => QueryBuilder<T>;
};

type TableClient<T> = {
  select: (columns?: string, options?: { count?: "exact"; head?: boolean }) => QueryBuilder<T>;
  insert: (payload: unknown) => {
    select: (columns?: string) => QueryBuilder<T>;
  };
  update: (payload: unknown) => {
    eq: (column: string, value: unknown) => PromiseLike<{ error: QueryError | null }>;
  };
};

type AdminClient = {
  from: <T>(table: string) => TableClient<T>;
  auth: {
    admin: {
      getUserById: (userId: string) => Promise<{
        data: { user: { email?: string | null } | null };
        error: QueryError | null;
      }>;
    };
  };
};

type AdminContext = {
  userId: string;
  claims?: JsonObject;
  isAdmin: boolean;
};

type AuctionRunRow = {
  id?: string | null;
  status?: string | null;
  source?: string | null;
  use_llm?: boolean | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  summary?: unknown;
  errors?: unknown;
};

type AuctionSaleAiDescriptionRow = {
  status?: string | null;
  raw_payload?: unknown;
};

const RUN_COLUMNS =
  "id,status,source,use_llm,started_at,finished_at,summary,errors,created_at,updated_at";
const AI_DESCRIPTION_COLUMNS = "status,raw_payload";
const AI_DESCRIPTION_PAGE_SIZE = 1000;

function getAdminClient(): AdminClient {
  return supabaseAdmin as unknown as AdminClient;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value);
}

function asObject(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (toJsonValue(value) as JsonObject)
    : {};
}

function normalizeRun(row: AuctionRunRow): AuctionRun {
  return {
    id: String(row.id ?? ""),
    status: String(row.status ?? "unknown"),
    source: row.source ?? null,
    useLlm: typeof row.use_llm === "boolean" ? row.use_llm : null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    summary: asObject(row.summary),
    errors: asObject(row.errors),
  };
}

function claimEmail(context: AdminContext): string | null {
  const value = context.claims?.email;
  return typeof value === "string" ? value : null;
}

async function assertAdminContext(context: AdminContext): Promise<{ email: string }> {
  const email = claimEmail(context);

  if (context.isAdmin) {
    return { email: normalizeEmail(email) || "admin" };
  }

  throw new Error("Forbidden: ce compte n'a pas les droits administrateur Immojudis.");
}

async function countRows(table: string): Promise<number> {
  const admin = getAdminClient();
  const { count, error } = await admin
    .from<Record<string, never>>(table)
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message ?? `Erreur de lecture ${table}`);
  return count ?? 0;
}

function statusCount(runs: AuctionRun[], status: string): number {
  return runs.filter((run) => run.status === status).length;
}

function cleanPayloadText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rawPayloadObject(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function isActiveOrUpcomingStatus(status: unknown): boolean {
  return status === "active" || status === "upcoming";
}

export function buildAiDescriptionDashboardStats(
  rows: AuctionSaleAiDescriptionRow[],
  expectedPromptVersion = EXPECTED_LLM_PROMPT_VERSION,
): AiDescriptionDashboardStats {
  let activeOrUpcoming = 0;
  let ready = 0;
  let missing = 0;
  let promptVersionMismatch = 0;

  for (const row of rows) {
    if (!isActiveOrUpcomingStatus(row.status)) continue;
    activeOrUpcoming += 1;
    const payload = rawPayloadObject(row.raw_payload);
    const displayDescription = cleanPayloadText(payload.llm_display_description);
    const promptVersion = cleanPayloadText(payload.llm_prompt_version);
    if (!displayDescription) {
      missing += 1;
    }
    if (promptVersion !== expectedPromptVersion) {
      promptVersionMismatch += 1;
    }
    if (
      displayDescription &&
      displayDescription.length >= 80 &&
      promptVersion === expectedPromptVersion &&
      payload.llm_display_quality_version === "display_quality_20260911_v3" &&
      ["accepted", "fallback"].includes(String(payload.llm_display_status))
    ) {
      ready += 1;
    }
  }

  return {
    expectedPromptVersion,
    total: rows.length,
    activeOrUpcoming,
    ready,
    missing,
    promptVersionMismatch,
    backfillRemaining: activeOrUpcoming - ready,
  };
}

export async function readAiDescriptionStats(
  admin: AdminClient,
): Promise<AiDescriptionDashboardStats> {
  const rows: AuctionSaleAiDescriptionRow[] = [];

  for (let from = 0; ; from += AI_DESCRIPTION_PAGE_SIZE) {
    const to = from + AI_DESCRIPTION_PAGE_SIZE - 1;
    const result = await admin
      .from<AuctionSaleAiDescriptionRow>("auction_sales")
      .select(AI_DESCRIPTION_COLUMNS)
      .range(from, to);

    if (result.error) {
      throw new Error(result.error.message ?? "Impossible de lire les synthèses IA.");
    }

    const page = result.data ?? [];
    rows.push(...page);

    if (page.length < AI_DESCRIPTION_PAGE_SIZE) {
      return buildAiDescriptionDashboardStats(rows);
    }
  }
}

function scrollWebhookUrl(): string | null {
  return process.env.SCROLL_WEBHOOK_URL ?? process.env.IMMOJUDIS_SCROLL_WEBHOOK_URL ?? null;
}

function scrollWebhookSecret(): string | null {
  return process.env.SCROLL_WEBHOOK_SECRET ?? process.env.IMMOJUDIS_SCROLL_WEBHOOK_SECRET ?? null;
}

function githubActionsToken(): string | null {
  return (
    process.env.GITHUB_SCROLL_TOKEN ??
    process.env.IMMOJUDIS_GITHUB_ACTIONS_TOKEN ??
    process.env.GITHUB_ACTIONS_DISPATCH_TOKEN ??
    null
  );
}

function githubActionsRepository(): string {
  return process.env.GITHUB_SCROLL_REPOSITORY ?? "Aprivi-dev/immojudis";
}

function githubActionsWorkflow(): string {
  return process.env.GITHUB_SCROLL_WORKFLOW ?? "data-pipeline.yml";
}

function githubActionsRef(): string {
  return process.env.GITHUB_SCROLL_REF ?? "main";
}

function runnerMode(): RunnerMode {
  if (githubActionsToken()) return "github_actions";
  if (scrollWebhookUrl()) return "webhook";
  return "queue_worker";
}

async function updateRunSummary(runId: string, summary: JsonObject, errors: JsonObject) {
  const admin = getAdminClient();
  const { error } = await admin
    .from<AuctionRunRow>("auction_runs")
    .update({ summary, errors })
    .eq("id", runId);
  if (error) throw new Error(error.message ?? "Impossible de mettre à jour le run.");
}

async function dispatchGitHubActionsRun(
  run: AuctionRun,
  input: { source: AdminScrollSource; mode: AdminScrollMode; limit?: number },
): Promise<Response> {
  const token = githubActionsToken();
  if (!token) throw new Error("GitHub Actions token missing.");

  const repository = githubActionsRepository();
  const workflow = githubActionsWorkflow();
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`;

  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: githubActionsRef(),
      inputs: {
        run_id: run.id,
        source: input.source,
        llm_backfill: String(input.mode === "llm_backfill"),
        ...(input.limit ? { limit: String(input.limit) } : {}),
      },
    }),
    signal: AbortSignal.timeout(12_000),
  });
}

export async function getAdminDashboard(authToken: string): Promise<AdminDashboardData> {
  const context = await requireSupabaseAuthContext(authToken);
  const adminUser = await assertAdminContext(context as AdminContext);
  const admin = getAdminClient();

  const runsQuery = admin
    .from<AuctionRunRow>("auction_runs")
    .select(RUN_COLUMNS)
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(25);

  const [
    runsResult,
    sales,
    documents,
    extractions,
    riskOccurrences,
    scoreFactors,
    runsCount,
    aiDescriptions,
  ] = await Promise.all([
    runsQuery,
    countRows("auction_sales"),
    countRows("auction_documents"),
    countRows("auction_extractions"),
    countRows("auction_risk_occurrences"),
    countRows("auction_score_factors"),
    countRows("auction_runs"),
    readAiDescriptionStats(admin),
  ]);

  if (runsResult.error) {
    throw new Error(runsResult.error.message ?? "Impossible de lire les runs.");
  }

  const runs = (runsResult.data ?? []).map(normalizeRun);

  return {
    checkedAt: new Date().toISOString(),
    adminEmail: adminUser.email,
    runner: {
      instantDispatchConfigured: runnerMode() !== "queue_worker",
      mode: runnerMode(),
    },
    stats: {
      sales,
      documents,
      extractions,
      riskOccurrences,
      scoreFactors,
      runs: runsCount,
      queuedRuns: statusCount(runs, "queued"),
      runningRuns: statusCount(runs, "running"),
      failedRuns: statusCount(runs, "failed"),
      aiDescriptions,
    },
    runs,
  };
}

export async function startAdminScroll(
  authToken: string,
  input: unknown,
): Promise<StartScrollResult> {
  const context = await requireSupabaseAuthContext(authToken);
  const data = startScrollSchema.parse(input ?? {});
  const adminUser = await assertAdminContext(context as AdminContext);
  const admin = getAdminClient();
  const requestedAt = new Date().toISOString();
  const mode = runnerMode();
  const webhookUrl = scrollWebhookUrl();
  const initialSummary = {
    requested_by: adminUser.email,
    requested_at: requestedAt,
    trigger: "admin_dashboard",
    mode: data.mode,
    ...(data.limit ? { limit: data.limit } : {}),
    runner_mode: mode,
    runner_expectation:
      mode === "github_actions"
        ? "dispatch_immediate"
        : mode === "webhook"
          ? "webhook_immediate"
          : "scheduled_github_actions_queue",
  };

  const inserted = await admin
    .from<AuctionRunRow>("auction_runs")
    .insert({
      status: "queued",
      source: data.mode === "llm_backfill" ? LLM_BACKFILL_SOURCE : data.source,
      use_llm: AUTOMATIC_LLM_ENRICHMENT,
      summary: initialSummary,
      errors: {},
    })
    .select(RUN_COLUMNS)
    .limit(1);

  if (inserted.error) {
    throw new Error(inserted.error.message ?? "Impossible de créer la demande de collecte.");
  }

  const run = normalizeRun((inserted.data ?? [])[0] ?? {});
  if (!run.id) throw new Error("Demande créée sans identifiant de run.");

  if (mode === "github_actions") {
    try {
      const response = await dispatchGitHubActionsRun(run, {
        source: data.source,
        mode: data.mode,
        limit: data.limit,
      });
      const githubSummary = {
        ...run.summary,
        github_actions: {
          dispatched_at: new Date().toISOString(),
          repository: githubActionsRepository(),
          workflow: githubActionsWorkflow(),
          ref: githubActionsRef(),
          status: response.status,
          ok: response.ok,
        },
      };
      const githubErrors = response.ok
        ? run.errors
        : {
            ...run.errors,
            github_actions: `HTTP ${response.status}`,
          };
      await updateRunSummary(run.id, githubSummary, githubErrors);

      return {
        ok: true,
        dispatched: response.ok,
        dispatchMode: "github_actions",
        run: {
          ...run,
          summary: githubSummary,
          errors: githubErrors,
        },
        message: response.ok
          ? "Demande envoyée au worker GitHub Actions."
          : `Demande enregistrée, mais GitHub Actions a répondu HTTP ${response.status}. Le worker planifié prendra le relais.`,
      };
    } catch (error) {
      const githubErrors = {
        ...run.errors,
        github_actions: error instanceof Error ? error.message : "GitHub Actions indisponible",
      };
      await updateRunSummary(run.id, run.summary, githubErrors);

      return {
        ok: true,
        dispatched: false,
        dispatchMode: "github_actions",
        run: {
          ...run,
          errors: githubErrors,
        },
        message:
          "Demande enregistrée, mais GitHub Actions n'a pas répondu. Le worker planifié prendra le relais.",
      };
    }
  }

  if (!webhookUrl) {
    return {
      ok: true,
      dispatched: false,
      dispatchMode: "queue_worker",
      run,
      message:
        "Demande enregistrée. Le worker GitHub Actions planifié la prendra automatiquement dans la file.",
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret = scrollWebhookSecret();
  if (secret) headers["X-Immojudis-Secret"] = secret;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        runId: run.id,
        source: data.source,
        mode: data.mode,
        limit: data.limit,
        useLlm: AUTOMATIC_LLM_ENRICHMENT,
        requestedBy: adminUser.email,
        requestedAt,
      }),
      signal: AbortSignal.timeout(12_000),
    });

    const webhookSummary = {
      ...run.summary,
      webhook: {
        dispatched_at: new Date().toISOString(),
        status: response.status,
        ok: response.ok,
      },
    };
    const webhookErrors = response.ok
      ? run.errors
      : {
          ...run.errors,
          webhook: `HTTP ${response.status}`,
        };
    await updateRunSummary(run.id, webhookSummary, webhookErrors);

    return {
      ok: true,
      dispatched: response.ok,
      dispatchMode: "webhook",
      run: {
        ...run,
        summary: webhookSummary,
        errors: webhookErrors,
      },
      message: response.ok
        ? "Demande envoyée au runner de collecte."
        : `Demande enregistrée, mais le webhook a répondu HTTP ${response.status}.`,
    };
  } catch (error) {
    const webhookErrors = {
      ...run.errors,
      webhook: error instanceof Error ? error.message : "Webhook indisponible",
    };
    await updateRunSummary(run.id, run.summary, webhookErrors);

    return {
      ok: true,
      dispatched: false,
      dispatchMode: "webhook",
      run: {
        ...run,
        errors: webhookErrors,
      },
      message: "Demande enregistrée, mais le webhook de lancement n'a pas répondu.",
    };
  }
}
