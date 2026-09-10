import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildTribunalJudicialActivity,
  judicialActivityPeriod,
  TribunalCourtUnresolvedError,
  type TribunalJudicialActivityHistoryMonths,
  type TribunalJudicialActivityQuery,
  type TribunalJudicialActivityResponse,
  type TribunalJudicialActivitySale,
} from "@/lib/tribunal-judicial-activity";
import {
  buildTribunalJudicialActivityDirectory,
  type TribunalJudicialActivityDirectoryQuery,
  type TribunalJudicialActivityDirectoryResponse,
  type TribunalJudicialActivityDirectorySale,
} from "@/lib/tribunal-judicial-activity-directory";

const PAGE_SIZE = 1_000;
const MAX_SALES_PER_COURT = 5_000;
// Keep a fail-closed bound while covering the current verified national corpus.
const MAX_DIRECTORY_SALES = 25_000;
const MAX_DIRECTORY_COURTS = 250;
const SALE_COLUMNS = [
  "id",
  "sale_date",
  "status",
  "starting_price_eur",
  "property_type",
  "visit_dates",
  "first_seen_at",
].join(",");
const DIRECTORY_SALE_COLUMNS = `tribunal_code,${SALE_COLUMNS}`;

const storedCourtSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    judicial_region: z.string().min(1).nullable(),
  })
  .strict();

const storedSaleCourtSchema = z
  .object({
    tribunal_code: z.string().min(1).nullable(),
    tribunal: z.string().min(1).nullable(),
    sale_venue_type: z.string().min(1),
    sale_verification_status: z.string().min(1),
  })
  .strict();

const storedCompetentCourtAssignmentSchema = z
  .object({
    court_code: z.string().min(1),
  })
  .strict();

const storedTribunalReferenceSchema = z
  .object({
    code: z.string().min(1),
    canonical_name: z.string().min(1),
  })
  .strict();

const storedSaleSchema = z
  .object({
    id: z.string().uuid(),
    sale_date: z.string().datetime({ offset: true }),
    status: z.string().min(1),
    starting_price_eur: z
      .union([
        z.number(),
        z
          .string()
          .regex(/^\d+(?:\.\d+)?$/)
          .transform(Number),
      ])
      .nullable(),
    property_type: z.string().nullable(),
    visit_dates: z.unknown(),
    first_seen_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

const storedDirectorySaleSchema = storedSaleSchema.extend({
  tribunal_code: z.string().min(1),
});

type DatabaseResult = {
  data: unknown;
  error: { message: string } | null;
};

type ActivityQuery = PromiseLike<DatabaseResult> & {
  select(columns: string): ActivityQuery;
  eq(column: string, value: unknown): ActivityQuery;
  not(column: string, operator: string, value: unknown): ActivityQuery;
  in(column: string, values: unknown[]): ActivityQuery;
  gte(column: string, value: unknown): ActivityQuery;
  lt(column: string, value: unknown): ActivityQuery;
  order(column: string, options?: { ascending?: boolean }): ActivityQuery;
  limit(count: number): ActivityQuery;
  range(from: number, to: number): PromiseLike<DatabaseResult>;
  maybeSingle(): PromiseLike<DatabaseResult>;
};

const activityAdmin = supabaseAdmin as unknown as {
  from(table: string): ActivityQuery;
};

export class TribunalJudicialActivityUnavailableError extends Error {
  constructor(message = "Tribunal judicial activity is temporarily unavailable.") {
    super(message);
    this.name = "TribunalJudicialActivityUnavailableError";
  }
}

export async function getTribunalJudicialActivity(
  input: TribunalJudicialActivityQuery,
  options: { asOf?: Date } = {},
): Promise<TribunalJudicialActivityResponse> {
  const asOf = options.asOf ?? new Date();
  const courtCode = input.courtCode ?? (await resolveCourtCodeFromSale(input.saleId!));
  const { historyStart, upcomingEnd } = judicialActivityPeriod(asOf, input.historyMonths);
  const courtResult = await activityAdmin
    .from("outcome_courts")
    .select("code,name,judicial_region")
    .eq("code", courtCode)
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (courtResult.error) {
    throw new TribunalJudicialActivityUnavailableError(
      `Court reference lookup failed: ${courtResult.error.message}`,
    );
  }
  if (!courtResult.data) {
    throw new TribunalCourtUnresolvedError(
      "No active exact official court reference is available.",
    );
  }

  const court = storedCourtSchema.parse(courtResult.data);
  const saleRows = await loadEligibleSales({
    courtCode,
    historyStart,
    upcomingEnd,
  });
  return buildTribunalJudicialActivity({
    court: {
      code: court.code,
      name: court.name,
      judicialRegion: court.judicial_region,
    },
    sales: saleRows,
    asOf,
    historyMonths: input.historyMonths,
  });
}

export async function getTribunalJudicialActivityDirectory(
  input: TribunalJudicialActivityDirectoryQuery,
  options: { asOf?: Date } = {},
): Promise<TribunalJudicialActivityDirectoryResponse> {
  const asOf = options.asOf ?? new Date();
  const { historyStart, upcomingEnd } = judicialActivityPeriod(asOf, input.historyMonths);
  const [courts, sales] = await Promise.all([
    loadActiveCourts(),
    loadEligibleDirectorySales({ historyStart, upcomingEnd }),
  ]);
  return buildTribunalJudicialActivityDirectory({
    courts,
    sales,
    asOf,
    historyMonths: input.historyMonths,
  });
}

export async function resolveCourtCodeFromSale(saleId: string): Promise<string> {
  const result = await activityAdmin
    .from("auction_sales")
    .select("tribunal_code,tribunal,sale_venue_type,sale_verification_status")
    .eq("id", saleId)
    .limit(1)
    .maybeSingle();
  if (result.error) {
    throw new TribunalJudicialActivityUnavailableError(
      `Judicial sale lookup failed: ${result.error.message}`,
    );
  }
  if (!result.data) {
    throw new TribunalJudicialActivityUnavailableError("No judicial sale is available.");
  }
  const sale = storedSaleCourtSchema.parse(result.data);
  if (sale.sale_venue_type !== "tribunal") {
    throw new TribunalJudicialActivityUnavailableError(
      "The sale is not identified as a judicial tribunal sale.",
    );
  }

  if (sale.tribunal_code) return normalizeCourtCode(sale.tribunal_code);

  const assignmentResult = await activityAdmin
    .from("auction_sale_competent_court_assignments")
    .select("court_code")
    .eq("auction_sale_id", saleId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (assignmentResult.error) {
    throw new TribunalJudicialActivityUnavailableError(
      `Verified competent-court lookup failed: ${assignmentResult.error.message}`,
    );
  }
  if (assignmentResult.data) {
    const assignment = storedCompetentCourtAssignmentSchema.parse(assignmentResult.data);
    return normalizeCourtCode(assignment.court_code);
  }

  if (sale.tribunal && ["verified", "cross_checked"].includes(sale.sale_verification_status)) {
    const tribunalResult = await activityAdmin
      .from("tribunals")
      .select("code,canonical_name")
      .eq("canonical_name", sale.tribunal)
      .limit(1)
      .maybeSingle();
    if (tribunalResult.error) {
      throw new TribunalJudicialActivityUnavailableError(
        `Canonical court reference lookup failed: ${tribunalResult.error.message}`,
      );
    }
    if (tribunalResult.data) {
      const tribunal = storedTribunalReferenceSchema.parse(tribunalResult.data);
      return normalizeCourtCode(tribunal.code);
    }

    const referenceResult = await activityAdmin
      .from("tribunals")
      .select("code,canonical_name")
      .order("code", { ascending: true })
      .range(0, MAX_DIRECTORY_COURTS);
    if (referenceResult.error) {
      throw new TribunalJudicialActivityUnavailableError(
        `Bounded canonical court reference lookup failed: ${referenceResult.error.message}`,
      );
    }
    const references = z.array(storedTribunalReferenceSchema).parse(referenceResult.data ?? []);
    if (references.length > MAX_DIRECTORY_COURTS) {
      throw new TribunalJudicialActivityUnavailableError(
        "The bounded canonical court reference exceeded 250 rows.",
      );
    }
    const saleCourtFingerprint = courtNameFingerprint(sale.tribunal);
    const normalizedMatches = references.filter(
      (reference) => courtNameFingerprint(reference.canonical_name) === saleCourtFingerprint,
    );
    if (normalizedMatches.length === 1) {
      return normalizeCourtCode(normalizedMatches[0].code);
    }
  }

  throw new TribunalCourtUnresolvedError(
    "The sale has no verified exact judicial court assignment.",
  );
}

function normalizeCourtCode(value: string): string {
  return value.trim().toLocaleLowerCase("fr-FR");
}

function courtNameFingerprint(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function loadEligibleSales(input: {
  courtCode: string;
  historyStart: Date;
  upcomingEnd: Date;
}): Promise<TribunalJudicialActivitySale[]> {
  const rows: TribunalJudicialActivitySale[] = [];
  for (let offset = 0; offset < MAX_SALES_PER_COURT; offset += PAGE_SIZE) {
    const result = await activityAdmin
      .from("auction_sales")
      .select(SALE_COLUMNS)
      .eq("tribunal_code", input.courtCode)
      .eq("sale_venue_type", "tribunal")
      .in("sale_verification_status", ["verified", "cross_checked"])
      .in("status", ["upcoming", "past", "adjudicated"])
      .gte("sale_date", input.historyStart.toISOString())
      .lt("sale_date", input.upcomingEnd.toISOString())
      .order("sale_date", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (result.error) {
      throw new TribunalJudicialActivityUnavailableError(
        `Judicial sale activity lookup failed: ${result.error.message}`,
      );
    }
    const page = z.array(storedSaleSchema).parse(result.data ?? []);
    for (const row of page) {
      rows.push({
        id: row.id,
        saleDate: row.sale_date,
        status: row.status,
        startingPriceEur: row.starting_price_eur,
        propertyType: row.property_type,
        visitDates: row.visit_dates,
        firstSeenAt: row.first_seen_at,
      });
    }
    if (page.length < PAGE_SIZE) return rows;
  }

  throw new TribunalJudicialActivityUnavailableError(
    "The bounded court activity scan exceeded 5,000 sales.",
  );
}

async function loadActiveCourts() {
  const result = await activityAdmin
    .from("outcome_courts")
    .select("code,name,judicial_region")
    .eq("active", true)
    .order("code", { ascending: true })
    .range(0, MAX_DIRECTORY_COURTS);
  if (result.error) {
    throw new TribunalJudicialActivityUnavailableError(
      `Court directory lookup failed: ${result.error.message}`,
    );
  }
  const rows = z.array(storedCourtSchema).parse(result.data ?? []);
  if (rows.length > MAX_DIRECTORY_COURTS) {
    throw new TribunalJudicialActivityUnavailableError(
      "The bounded official court directory exceeded 250 rows.",
    );
  }
  return rows.map((court) => ({
    code: court.code,
    name: court.name,
    judicialRegion: court.judicial_region,
  }));
}

async function loadEligibleDirectorySales(input: {
  historyStart: Date;
  upcomingEnd: Date;
}): Promise<TribunalJudicialActivityDirectorySale[]> {
  const rows: TribunalJudicialActivityDirectorySale[] = [];
  for (let offset = 0; offset < MAX_DIRECTORY_SALES; offset += PAGE_SIZE) {
    const result = await activityAdmin
      .from("auction_sales")
      .select(DIRECTORY_SALE_COLUMNS)
      .eq("sale_venue_type", "tribunal")
      .not("tribunal_code", "is", null)
      .in("sale_verification_status", ["verified", "cross_checked"])
      .in("status", ["upcoming", "past", "adjudicated"])
      .gte("sale_date", input.historyStart.toISOString())
      .lt("sale_date", input.upcomingEnd.toISOString())
      .order("sale_date", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (result.error) {
      throw new TribunalJudicialActivityUnavailableError(
        `Judicial sale directory lookup failed: ${result.error.message}`,
      );
    }
    const page = z.array(storedDirectorySaleSchema).parse(result.data ?? []);
    for (const row of page) {
      rows.push({
        tribunalCode: row.tribunal_code,
        ...mapStoredSale(row),
      });
    }
    if (page.length < PAGE_SIZE) return rows;
  }
  throw new TribunalJudicialActivityUnavailableError(
    "The bounded judicial activity directory scan exceeded 25,000 sales.",
  );
}

function mapStoredSale(row: z.infer<typeof storedSaleSchema>): TribunalJudicialActivitySale {
  return {
    id: row.id,
    saleDate: row.sale_date,
    status: row.status,
    startingPriceEur: row.starting_price_eur,
    propertyType: row.property_type,
    visitDates: row.visit_dates,
    firstSeenAt: row.first_seen_at,
  };
}

export function activityQueryPeriod(
  asOf: Date,
  historyMonths: TribunalJudicialActivityHistoryMonths,
): { historyStart: string; upcomingEnd: string } {
  const period = judicialActivityPeriod(asOf, historyMonths);
  return {
    historyStart: period.historyStart.toISOString(),
    upcomingEnd: period.upcomingEnd.toISOString(),
  };
}
