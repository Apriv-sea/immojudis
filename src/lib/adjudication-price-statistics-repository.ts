import { z } from "zod";
import { adjudicationEnrichmentSchema } from "@/lib/adjudication-distributions";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  adjudicationPriceStatisticsReliability,
  adjudicationPriceStatisticsResponseSchema,
  type AdjudicationPriceStatisticsResponse,
  type AdjudicationPriceStatisticsScope,
} from "@/lib/adjudication-price-statistics";
import {
  resolveCourtCodeFromSale,
  TribunalJudicialActivityUnavailableError,
} from "@/lib/tribunal-judicial-activity-repository";
import { TribunalCourtUnresolvedError } from "@/lib/tribunal-judicial-activity";

const STORED_COLUMNS = [
  "build_id",
  "scope_type",
  "court_code",
  "scope_label",
  "judicial_region",
  "period_start",
  "period_end",
  "sample_size",
  "median_hammer_to_starting_ratio",
  "above_starting_rate",
  "at_least_double_rate",
  "median_hammer_price_eur",
  "median_starting_price_eur",
  "methodology_version",
  "source_name",
  "built_at",
  "reviewed_at",
  "extra_statistics",
].join(",");

const numericSchema = z.union([
  z.number(),
  z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .transform(Number),
]);
const storedRowSchema = z
  .object({
    build_id: z.string().uuid(),
    scope_type: z.enum(["national", "tribunal"]),
    court_code: z.string().min(1).nullable(),
    scope_label: z.string().min(1),
    judicial_region: z.string().min(1).nullable(),
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sample_size: z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]),
    median_hammer_to_starting_ratio: numericSchema,
    above_starting_rate: numericSchema,
    at_least_double_rate: numericSchema,
    median_hammer_price_eur: numericSchema,
    median_starting_price_eur: numericSchema,
    methodology_version: z.literal("licitor_canonical_price_statistics_v1"),
    source_name: z.literal("licitor"),
    built_at: z.string().datetime({ offset: true }),
    reviewed_at: z.string().datetime({ offset: true }),
    extra_statistics: adjudicationEnrichmentSchema.nullable().optional(),
  })
  .strict();

const storedSaleSchema = z
  .object({
    tribunal_code: z.string().min(1).nullable(),
    sale_venue_type: z.string().min(1),
  })
  .strict();

type DatabaseResult = { data: unknown; error: { message: string } | null };
type StatisticsQuery = PromiseLike<DatabaseResult> & {
  select(columns: string): StatisticsQuery;
  eq(column: string, value: unknown): StatisticsQuery;
  ilike(column: string, pattern: string): StatisticsQuery;
  order(column: string, options?: { ascending?: boolean }): StatisticsQuery;
  limit(count: number): StatisticsQuery;
  maybeSingle(): PromiseLike<DatabaseResult>;
};

const statisticsAdmin = supabaseAdmin as unknown as { from(table: string): StatisticsQuery };

export class AdjudicationPriceStatisticsUnavailableError extends Error {
  constructor(message = "Adjudication price statistics are temporarily unavailable.") {
    super(message);
    this.name = "AdjudicationPriceStatisticsUnavailableError";
  }
}

export function adjudicationPriceStatisticsEnabled(
  value = process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED,
): boolean {
  return value === "true";
}

export async function getAdjudicationPriceStatisticsForSale(
  saleId: string,
): Promise<AdjudicationPriceStatisticsResponse> {
  if (!adjudicationPriceStatisticsEnabled()) {
    throw new AdjudicationPriceStatisticsUnavailableError(
      "Configuration: adjudication price statistics are disabled.",
    );
  }
  const pinnedBuildId = process.env.ADJUDICATION_PRICE_STATISTICS_BUILD_ID?.trim() || null;
  if (pinnedBuildId && !z.string().uuid().safeParse(pinnedBuildId).success) {
    throw unavailable("Configuration: the pinned adjudication-price build ID is invalid.");
  }

  const [saleResult, nationalResult] = await Promise.all([
    statisticsAdmin
      .from("auction_sales")
      .select("tribunal_code,sale_venue_type")
      .eq("id", saleId)
      .limit(1)
      .maybeSingle(),
    fetchNationalRow(pinnedBuildId),
  ]);

  if (saleResult.error) {
    throw unavailable(`Judicial sale lookup failed: ${saleResult.error.message}`);
  }
  if (!saleResult.data) throw unavailable("No judicial sale is available.");
  const sale = parseStoredSale(saleResult.data);
  if (sale.sale_venue_type !== "tribunal") {
    throw unavailable("The sale is not identified as a tribunal sale.");
  }

  if (nationalResult.error) {
    throw unavailable(`National statistics lookup failed: ${nationalResult.error.message}`);
  }
  if (!nationalResult.data) {
    throw unavailable("No reviewed national adjudication-price build is available.");
  }
  const national = parseStoredRow(nationalResult.data, "national");
  if (
    national.scope_type !== "national" ||
    (pinnedBuildId && national.build_id !== pinnedBuildId)
  ) {
    throw unavailable("The reviewed national statistics row has an invalid scope.");
  }

  const courtCode = sale.tribunal_code ?? (await resolveOptionalCourtCodeFromSale(saleId));
  const tribunal = courtCode ? await fetchTribunalRow(national.build_id, courtCode) : null;
  try {
    return adjudicationPriceStatisticsResponseSchema.parse({
      national: toPublicScope(national),
      tribunal: tribunal ? toPublicScope(tribunal) : null,
      meta: {
        sourceName: "licitor",
        sourceLabel: "Résultats d’adjudication publiés par Licitor",
        methodologyVersion: national.methodology_version,
        builtAt: national.built_at,
        reviewedAt: national.reviewed_at,
        experimental: true,
        warning:
          "Statistiques descriptives historiques sur trois ans, sans valeur prédictive ni estimation du bien.",
      },
    });
  } catch {
    throw unavailable("The reviewed adjudication-price response failed publication validation.");
  }
}

function fetchNationalRow(pinnedBuildId: string | null) {
  let query = statisticsAdmin
    .from("published_adjudication_price_statistics")
    .select(STORED_COLUMNS)
    .eq("scope_type", "national");
  if (pinnedBuildId) query = query.eq("build_id", pinnedBuildId);
  return query
    .order("reviewed_at", { ascending: false })
    .order("built_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

async function fetchTribunalRow(buildId: string, courtCode: string) {
  const result = await statisticsAdmin
    .from("published_adjudication_price_statistics")
    .select(STORED_COLUMNS)
    .eq("build_id", buildId)
    .eq("scope_type", "tribunal")
    .ilike("court_code", escapeIlikeLiteral(courtCode.trim()))
    .limit(1)
    .maybeSingle();
  if (result.error) {
    throw unavailable(`Tribunal statistics lookup failed: ${result.error.message}`);
  }
  if (!result.data) return null;
  const row = parseStoredRow(result.data, "tribunal");
  if (row.scope_type !== "tribunal" || row.build_id !== buildId) {
    throw unavailable("The reviewed tribunal statistics row has an invalid scope.");
  }
  return row;
}

async function resolveOptionalCourtCodeFromSale(saleId: string): Promise<string | null> {
  try {
    return await resolveCourtCodeFromSale(saleId);
  } catch (error) {
    if (
      error instanceof TribunalJudicialActivityUnavailableError ||
      error instanceof TribunalCourtUnresolvedError
    )
      return null;
    throw unavailable("The exact tribunal assignment could not be resolved safely.");
  }
}

function toPublicScope(row: z.output<typeof storedRowSchema>): AdjudicationPriceStatisticsScope {
  return {
    scopeType: row.scope_type,
    label: row.scope_label,
    courtCode: row.court_code,
    judicialRegion: row.judicial_region,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    sampleSize: row.sample_size,
    reliability: adjudicationPriceStatisticsReliability(row.sample_size),
    ...(row.extra_statistics ?? {}),
    metrics: {
      medianHammerToStartingRatio: row.median_hammer_to_starting_ratio,
      aboveStartingRate: row.above_starting_rate,
      atLeastDoubleRate: row.at_least_double_rate,
      medianHammerPriceEur: row.median_hammer_price_eur,
      medianStartingPriceEur: row.median_starting_price_eur,
    },
  };
}

function unavailable(message: string) {
  return new AdjudicationPriceStatisticsUnavailableError(message);
}

function parseStoredSale(value: unknown): z.output<typeof storedSaleSchema> {
  try {
    return storedSaleSchema.parse(value);
  } catch {
    throw unavailable("The judicial sale row failed publication validation.");
  }
}

function parseStoredRow(
  value: unknown,
  scope: "national" | "tribunal",
): z.output<typeof storedRowSchema> {
  try {
    return storedRowSchema.parse(value);
  } catch {
    throw unavailable(`The reviewed ${scope} statistics row failed publication validation.`);
  }
}

function escapeIlikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
