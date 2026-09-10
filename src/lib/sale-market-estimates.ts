import { createHash } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  getMarketEstimate,
  marketEstimateErrorCode,
  type MarketContext,
  type MarketEstimate,
  type MarketEstimateErrorCode,
} from "@/lib/market.functions";
import { getMarketValuationSurfaces } from "@/lib/surface";

type StoredEstimateRow = Database["public"]["Tables"]["auction_sale_market_estimates"]["Row"];
type StoredEstimateUpdate = Database["public"]["Tables"]["auction_sale_market_estimates"]["Update"];
type AuctionSaleRow = Database["public"]["Tables"]["auction_sales"]["Row"];

const SALE_INPUT_COLUMNS = [
  "id",
  "title",
  "address",
  "city",
  "postal_code",
  "property_type",
  "latitude",
  "longitude",
  "app_surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "app_surface_kind",
  "surface_scope",
  "rooms_count",
  "bedrooms_count",
  "updated_at",
] as const;

type SaleValuationSource = Pick<AuctionSaleRow, (typeof SALE_INPUT_COLUMNS)[number]>;

export type SaleValuationInput = {
  saleId: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  propertyType: string | null;
  surfaceKind: string | null;
  surfaceScope: string | null;
  surfaceM2: number | null;
  landSurfaceM2: number | null;
  roomsCount: number | null;
  surfaceEstimated: boolean;
  surfaceAssumption: string | null;
  surfaceUncertaintyPct: number | null;
};

export type SaleValuationPrecomputeResult = {
  scanned: number;
  claimed: number;
  ready: number;
  insufficientData: number;
  failed: number;
  errors: Array<{ saleId: string; error: string }>;
};

const storedEstimateSchema = z
  .object({
    source: z.string(),
    sampleSize: z.number().int().nonnegative(),
    qualityScore: z.number().min(0).max(100),
    estimatedValueEur: z.number().positive().nullable().optional(),
    medianPricePerM2: z.number().positive().nullable().optional(),
    actionable: z.boolean().optional(),
  })
  .passthrough();

const VALUATION_CONCURRENCY = 4;

export function buildSaleValuationInput(sale: SaleValuationSource): SaleValuationInput {
  const surfaces = getMarketValuationSurfaces(sale);
  return {
    saleId: sale.id,
    lat: sale.latitude,
    lng: sale.longitude,
    address: sale.address,
    city: sale.city,
    postalCode: sale.postal_code,
    propertyType: sale.property_type,
    surfaceKind: surfaces.surfaceKind,
    surfaceScope: surfaces.surfaceScope,
    surfaceM2: surfaces.builtSurfaceM2,
    landSurfaceM2: surfaces.landSurfaceM2,
    roomsCount: sale.rooms_count,
    surfaceEstimated: surfaces.builtSurfaceEstimated,
    surfaceAssumption: surfaces.builtSurfaceAssumption,
    surfaceUncertaintyPct: surfaces.builtSurfaceUncertaintyPct,
  };
}

export function saleValuationFingerprint(input: SaleValuationInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function marketContextFromStoredRow(
  row: StoredEstimateRow | null,
  expectedFingerprint?: string,
): MarketContext {
  const estimate = storedEstimate(row?.estimate ?? null);
  const computedAt = Date.parse(row?.computed_at ?? "");
  const sourceUpdatedAt = Date.parse(row?.source_updated_at ?? "");
  if (
    estimate &&
    (!Number.isFinite(computedAt) ||
      sourceUpdatedAt > computedAt ||
      (expectedFingerprint != null && row?.input_fingerprint !== expectedFingerprint))
  ) {
    return {
      ok: false,
      error:
        "Les caractéristiques ou hypothèses du bien ont changé, ou la date du calcul manque. Estimation à recalculer.",
      estimate: null,
      status: "queued",
      code: null,
      retryAfterSeconds: row ? retryAfterSeconds(row.next_refresh_at) : null,
      computedAt: row?.computed_at ?? null,
    };
  }
  if (estimate) {
    const refreshing = row?.status === "pending" || row?.status === "processing";
    return {
      ok: true,
      error: null,
      estimate,
      status: refreshing ? "refreshing" : "ready",
      code: null,
      retryAfterSeconds: refreshing ? retryAfterSeconds(row.next_refresh_at) : null,
      computedAt: row?.computed_at ?? null,
    };
  }

  if (!row) {
    return {
      ok: false,
      error: "Estimation pré-calculée en attente de préparation.",
      estimate: null,
      status: "queued",
      code: null,
      retryAfterSeconds: 60,
      computedAt: null,
    };
  }

  const preparing = row.status === "pending" || row.status === "processing";
  return {
    ok: false,
    error: preparing
      ? "Estimation en cours de préparation."
      : row.error_message || "Estimation pré-calculée indisponible.",
    estimate: null,
    status: preparing
      ? "queued"
      : row.status === "insufficient_data"
        ? "insufficient_data"
        : "failed",
    code: storedErrorCode(row.last_error_code),
    retryAfterSeconds: retryAfterSeconds(row.next_refresh_at),
    computedAt: row.computed_at,
  };
}

export async function getStoredSaleMarketContext(saleId: string): Promise<MarketContext> {
  const { data, error } = await supabaseAdmin
    .from("auction_sale_market_estimates")
    .select("*")
    .eq("auction_sale_id", saleId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.estimate) return marketContextFromStoredRow(data);

  const { data: sale, error: saleError } = await supabaseAdmin
    .from("auction_sales")
    .select(SALE_INPUT_COLUMNS.join(","))
    .eq("id", saleId)
    .maybeSingle();
  if (saleError) throw saleError;
  if (!sale) throw new Error("Vente source introuvable.");
  const fingerprint = saleValuationFingerprint(
    buildSaleValuationInput(sale as unknown as SaleValuationSource),
  );
  return marketContextFromStoredRow(data, fingerprint);
}

export async function getPrecomputedMarketEstimate(saleId: string): Promise<MarketEstimate | null> {
  return (await getStoredSaleMarketContext(saleId)).estimate;
}

export async function enqueueSaleValuation(
  saleId: string,
  {
    priority = 100,
    reason = "user_requested",
    now = new Date(),
  }: { priority?: number; reason?: string; now?: Date } = {},
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("enqueue_auction_sale_market_estimate", {
    p_auction_sale_id: saleId,
    p_priority: priority,
    p_reason: reason,
    p_now: now.toISOString(),
  });
  if (error) throw error;
}

export async function refreshSaleValuationOnDemand(
  saleId: string,
  now = new Date(),
): Promise<MarketContext> {
  const existing = await getStoredSaleMarketContext(saleId);
  if (existing.estimate) return existing;

  await enqueueSaleValuation(saleId, { now });
  await runSaleValuationPrecomputeForSale(saleId, now);
  return getStoredSaleMarketContext(saleId);
}

export async function runSaleValuationPrecomputeBatch({
  limit = 50,
  now = new Date(),
}: {
  limit?: number;
  now?: Date;
} = {}): Promise<SaleValuationPrecomputeResult> {
  const batchLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const { data: claimedRows, error: claimError } = await supabaseAdmin.rpc(
    "claim_auction_sale_market_estimates",
    {
      p_limit: batchLimit,
      p_now: now.toISOString(),
      p_lease_seconds: 300,
    },
  );
  if (claimError) throw claimError;
  return processClaimedValuations((claimedRows ?? []) as unknown as StoredEstimateRow[], now);
}

export async function runSaleValuationPrecomputeForSale(
  saleId: string,
  now = new Date(),
): Promise<SaleValuationPrecomputeResult> {
  const { data: claimedRows, error: claimError } = await supabaseAdmin.rpc(
    "claim_auction_sale_market_estimate",
    {
      p_auction_sale_id: saleId,
      p_now: now.toISOString(),
      p_lease_seconds: 90,
    },
  );
  if (claimError) throw claimError;
  return processClaimedValuations((claimedRows ?? []) as unknown as StoredEstimateRow[], now);
}

async function processClaimedValuations(
  claimedRows: StoredEstimateRow[],
  now: Date,
): Promise<SaleValuationPrecomputeResult> {
  if (!claimedRows.length) return emptyBatchResult();

  const saleIds = claimedRows.map((row) => row.auction_sale_id);
  const { data: sales, error: salesError } = await supabaseAdmin
    .from("auction_sales")
    .select(SALE_INPUT_COLUMNS.join(","))
    .in("id", saleIds);
  if (salesError) throw salesError;

  const salesById = new Map(
    ((sales ?? []) as unknown as SaleValuationSource[]).map((sale) => [sale.id, sale]),
  );
  const result = emptyBatchResult();
  result.scanned = claimedRows.length;
  result.claimed = claimedRows.length;

  await mapWithConcurrency(claimedRows, VALUATION_CONCURRENCY, async (row) => {
    const sale = salesById.get(row.auction_sale_id);
    if (!sale) {
      result.failed += 1;
      result.errors.push({ saleId: row.auction_sale_id, error: "Vente source introuvable." });
      return;
    }

    const attemptStartedAt = Date.now();
    const input = buildSaleValuationInput(sale);
    const fingerprint = saleValuationFingerprint(input);
    const { data: prepared, error: prepareError } = await supabaseAdmin
      .from("auction_sale_market_estimates")
      .update({
        input_fingerprint: fingerprint,
        source_updated_at: sale.updated_at,
        // Never attach the new input fingerprint to an estimate computed from old inputs.
        ...(row.input_fingerprint !== fingerprint ? { estimate: null, computed_at: null } : {}),
      })
      .eq("auction_sale_id", sale.id)
      .eq("status", "processing")
      .eq("input_fingerprint", row.input_fingerprint)
      .eq("attempt_count", row.attempt_count)
      .eq("last_started_at", row.last_started_at!)
      .select("auction_sale_id")
      .maybeSingle();

    if (prepareError) {
      result.failed += 1;
      result.errors.push({ saleId: sale.id, error: prepareError.message });
      return;
    }
    if (!prepared) {
      await recordValuationAttempt(row, {
        fingerprint,
        outcome: "superseded",
        latencyMs: Date.now() - attemptStartedAt,
        code: null,
        message: "Les caractéristiques du bien ont changé pendant la réservation.",
      });
      return;
    }

    try {
      const context = await getMarketEstimate(input, {
        userId: null,
        auctionSaleId: sale.id,
      });
      if (!context.estimate) {
        const code = context.code ?? "INTERNAL_ERROR";
        const transientFailure = code === "UPSTREAM_UNAVAILABLE" || code === "INTERNAL_ERROR";
        const outcome = transientFailure ? "failed" : "insufficient_data";
        const published = await publishStoredEstimateForClaim(sale.id, fingerprint, row, {
          status: outcome,
          input_fingerprint: fingerprint,
          source_updated_at: sale.updated_at,
          estimate: null,
          error_message: context.error || "Données insuffisantes pour produire une estimation.",
          last_error_code: code,
          last_finished_at: new Date().toISOString(),
          priority: retryPriority(code),
          refresh_reason: "automatic_retry",
          value_p10_eur: null,
          value_p50_eur: null,
          value_p90_eur: null,
          confidence_score: null,
          comparable_count: 0,
          actionable: false,
          next_refresh_at: retryAt(now, code).toISOString(),
        });
        if (published) {
          if (transientFailure) result.failed += 1;
          else result.insufficientData += 1;
          await recordValuationAttempt(row, {
            fingerprint,
            outcome,
            latencyMs: Date.now() - attemptStartedAt,
            code,
            message: context.error,
          });
        }
        return;
      }

      const estimate = context.estimate;
      if (!estimate.estimatedValueEur || estimate.estimatedValueEur <= 0) {
        const code: MarketEstimateErrorCode = "NO_COMPARABLES";
        const published = await publishStoredEstimateForClaim(sale.id, fingerprint, row, {
          status: "insufficient_data",
          input_fingerprint: fingerprint,
          source_updated_at: sale.updated_at,
          estimate: null,
          error_message:
            estimate.qualityWarnings[0] ||
            "Les données disponibles ne permettent pas encore de calculer une valeur.",
          last_error_code: code,
          last_finished_at: new Date().toISOString(),
          priority: retryPriority(code),
          refresh_reason: "automatic_retry",
          value_p10_eur: null,
          value_p50_eur: null,
          value_p90_eur: null,
          confidence_score: estimate.qualityScore,
          comparable_count: estimate.sampleSize,
          actionable: false,
          next_refresh_at: retryAt(now, code).toISOString(),
        });
        if (published) {
          result.insufficientData += 1;
          await recordValuationAttempt(row, {
            fingerprint,
            outcome: "insufficient_data",
            latencyMs: Date.now() - attemptStartedAt,
            code,
            message: estimate.qualityWarnings[0] ?? null,
            estimate,
          });
        }
        return;
      }

      const published = await publishStoredEstimateForClaim(sale.id, fingerprint, row, {
        status: "ready",
        input_fingerprint: fingerprint,
        source_updated_at: sale.updated_at,
        estimate: estimate as unknown as Json,
        error_message: null,
        last_error_code: null,
        last_finished_at: new Date().toISOString(),
        priority: 0,
        refresh_reason: "scheduled_refresh",
        engine_version: estimate.engineVersion ?? "v3",
        engine_kind: estimate.engineKind ?? "comparable_ensemble",
        model_version_id: estimate.modelVersionId ?? null,
        model_version: estimate.modelVersion ?? null,
        segment: estimate.segment ?? null,
        value_p10_eur: estimate.estimatedValueLowEur ?? null,
        value_p50_eur: estimate.estimatedValueEur ?? null,
        value_p90_eur: estimate.estimatedValueHighEur ?? null,
        confidence_score: estimate.qualityScore,
        comparable_count: estimate.sampleSize,
        actionable: estimate.actionable === true,
        computed_at: new Date().toISOString(),
        next_refresh_at: addMilliseconds(now, 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      if (published) {
        result.ready += 1;
        await recordValuationAttempt(row, {
          fingerprint,
          outcome: "ready",
          latencyMs: Date.now() - attemptStartedAt,
          code: null,
          message: null,
          estimate,
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      const code = marketEstimateErrorCode(error);
      try {
        const published = await publishStoredEstimateForClaim(sale.id, fingerprint, row, {
          status: "failed",
          input_fingerprint: fingerprint,
          source_updated_at: sale.updated_at,
          error_message: message,
          last_error_code: code,
          last_finished_at: new Date().toISOString(),
          priority: retryPriority(code),
          refresh_reason: "automatic_retry",
          next_refresh_at: retryAt(now, code).toISOString(),
        });
        if (published) {
          await recordValuationAttempt(row, {
            fingerprint,
            outcome: "failed",
            latencyMs: Date.now() - attemptStartedAt,
            code,
            message,
          });
        }
        result.failed += 1;
        result.errors.push({ saleId: sale.id, error: message });
      } catch (publishError) {
        result.failed += 1;
        result.errors.push({ saleId: sale.id, error: errorMessage(publishError) });
      }
    }
  });

  return result;
}

export async function publishStoredEstimateForClaim(
  saleId: string,
  claimedFingerprint: string,
  claim: Pick<StoredEstimateRow, "attempt_count" | "last_started_at">,
  update: StoredEstimateUpdate,
): Promise<boolean> {
  if (!claim.last_started_at) return false;
  const { data, error } = await supabaseAdmin
    .from("auction_sale_market_estimates")
    .update(update)
    .eq("auction_sale_id", saleId)
    .eq("input_fingerprint", claimedFingerprint)
    .eq("status", "processing")
    .eq("attempt_count", claim.attempt_count)
    .eq("last_started_at", claim.last_started_at)
    .select("auction_sale_id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

function storedEstimate(value: Json | null): MarketEstimate | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const parsed = storedEstimateSchema.safeParse(value);
  return parsed.success ? (parsed.data as unknown as MarketEstimate) : null;
}

function emptyBatchResult(): SaleValuationPrecomputeResult {
  return { scanned: 0, claimed: 0, ready: 0, insufficientData: 0, failed: 0, errors: [] };
}

function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Échec du calcul de l'estimation.";
  return message.slice(0, 500);
}

function storedErrorCode(value: string | null): MarketEstimateErrorCode | null {
  const supported: MarketEstimateErrorCode[] = [
    "INVALID_INPUT",
    "MISSING_LOCATION",
    "MISSING_SURFACE",
    "UNSUPPORTED_SEGMENT",
    "NO_COMPARABLES",
    "UPSTREAM_UNAVAILABLE",
    "INTERNAL_ERROR",
  ];
  return supported.includes(value as MarketEstimateErrorCode)
    ? (value as MarketEstimateErrorCode)
    : null;
}

function retryAfterSeconds(nextRefreshAt: string): number {
  const remaining = Math.ceil((new Date(nextRefreshAt).getTime() - Date.now()) / 1_000);
  return Math.max(15, Math.min(86_400, Number.isFinite(remaining) ? remaining : 60));
}

function retryAt(now: Date, code: MarketEstimateErrorCode): Date {
  const delay =
    code === "UPSTREAM_UNAVAILABLE" || code === "INTERNAL_ERROR"
      ? 60 * 60 * 1_000
      : code === "INVALID_INPUT"
        ? 24 * 60 * 60 * 1_000
        : 7 * 24 * 60 * 60 * 1_000;
  return addMilliseconds(now, delay);
}

function retryPriority(code: MarketEstimateErrorCode): number {
  if (code === "UPSTREAM_UNAVAILABLE" || code === "INTERNAL_ERROR") return 50;
  if (code === "NO_COMPARABLES") return 20;
  return 10;
}

async function recordValuationAttempt(
  row: StoredEstimateRow,
  input: {
    fingerprint: string;
    outcome: "ready" | "insufficient_data" | "failed" | "superseded";
    latencyMs: number;
    code: MarketEstimateErrorCode | null;
    message: string | null;
    estimate?: MarketEstimate;
  },
): Promise<void> {
  const estimate = input.estimate;
  const { error } = await supabaseAdmin.from("valuation_estimate_attempts").insert({
    auction_sale_id: row.auction_sale_id,
    attempt_number: row.attempt_count,
    request_source: row.refresh_reason,
    input_fingerprint: input.fingerprint,
    outcome: input.outcome,
    error_code: input.code,
    error_message: input.message?.slice(0, 500) ?? null,
    engine_kind: estimate?.engineKind ?? null,
    segment: estimate?.segment ?? null,
    comparable_count: estimate?.sampleSize ?? null,
    confidence_score: estimate?.qualityScore ?? null,
    actionable: estimate?.actionable ?? null,
    latency_ms: Math.max(0, input.latencyMs),
    details: {
      estimationLevel: estimate?.estimationLevel ?? null,
      source: estimate?.source ?? null,
      warnings: estimate?.qualityWarnings.slice(0, 8) ?? [],
    },
  });
  if (error) console.warn(`[valuation] tentative non journalisée: ${error.message}`);
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await worker(values[index]);
    }
  });
  await Promise.all(runners);
}
