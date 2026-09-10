import { z } from "zod";

export class TribunalCourtUnresolvedError extends Error {
  constructor(message = "Le rattachement exact au tribunal reste à confirmer.") {
    super(message);
    this.name = "TribunalCourtUnresolvedError";
  }
}

export const TRIBUNAL_JUDICIAL_ACTIVITY_BUILDER_VERSION = "tribunal_judicial_activity_v1" as const;
export const TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE = 5;

const isoDateTimeSchema = z.string().datetime({ offset: true });

export const tribunalJudicialActivityHistoryMonthsSchema = z.union([
  z.literal(12),
  z.literal(24),
  z.literal(36),
]);

export const tribunalJudicialActivityQuerySchema = z
  .object({
    courtCode: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .transform((value) => value.toLocaleLowerCase("fr-FR"))
      .refine((value) => /^[a-z0-9][a-z0-9:._-]*$/.test(value), {
        message: "Code tribunal invalide.",
      })
      .optional(),
    saleId: z.string().uuid().optional(),
    historyMonths: z.preprocess(
      (value) => (value === undefined ? 36 : Number(value)),
      tribunalJudicialActivityHistoryMonthsSchema,
    ),
  })
  .strict()
  .refine((value) => Boolean(value.courtCode) !== Boolean(value.saleId), {
    message: "Fournissez exactement courtCode ou saleId.",
  });

const publishedMetricSchema = z
  .object({
    status: z.literal("published"),
    value: z.number().nonnegative(),
    sampleSize: z.number().int().nonnegative(),
  })
  .strict();

const suppressedMetricSchema = z
  .object({
    status: z.literal("insufficient_data"),
    value: z.null(),
    sampleSize: z.number().int().nonnegative(),
  })
  .strict();

export const tribunalJudicialActivityMetricSchema = z.discriminatedUnion("status", [
  publishedMetricSchema,
  suppressedMetricSchema,
]);

const publishedRangeMetricSchema = z
  .object({
    status: z.literal("published"),
    p25: z.number().nonnegative(),
    p50: z.number().nonnegative(),
    p75: z.number().nonnegative(),
    sampleSize: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.p25 > metric.p50 || metric.p50 > metric.p75) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Les quantiles doivent être monotones (P25 ≤ P50 ≤ P75).",
      });
    }
  });

const suppressedRangeMetricSchema = z
  .object({
    status: z.literal("insufficient_data"),
    p25: z.null(),
    p50: z.null(),
    p75: z.null(),
    sampleSize: z.number().int().nonnegative(),
  })
  .strict();

export const tribunalJudicialActivityRangeMetricSchema = z.union([
  publishedRangeMetricSchema,
  suppressedRangeMetricSchema,
]);

const propertyTypeShareSchema = z
  .object({
    propertyType: z.string().min(1),
    count: z.number().int().positive(),
    share: z.number().min(0).max(1),
  })
  .strict();

const propertyTypeBenchmarkSchema = z
  .object({
    propertyType: z.string().min(1),
    observedSales: z.number().int().positive(),
    startingPriceRangeEur: tribunalJudicialActivityRangeMetricSchema,
    discoveryLeadRangeDays: tribunalJudicialActivityRangeMetricSchema,
  })
  .strict();

export const tribunalJudicialActivityResponseSchema = z
  .object({
    court: z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        judicialRegion: z.string().min(1).nullable(),
      })
      .strict(),
    period: z
      .object({
        historyMonths: tribunalJudicialActivityHistoryMonthsSchema,
        historyStart: isoDateTimeSchema,
        asOf: isoDateTimeSchema,
        upcomingEnd: isoDateTimeSchema,
      })
      .strict(),
    activity: z
      .object({
        observedPastSales: z.number().int().nonnegative(),
        upcomingSales: z.number().int().nonnegative(),
        upcomingSales90Days: z.number().int().nonnegative(),
        upcomingHearingDays: z.number().int().nonnegative(),
        nextSaleAt: isoDateTimeSchema.nullable(),
        medianStartingPriceEur: tribunalJudicialActivityMetricSchema,
        startingPriceRangeEur: tribunalJudicialActivityRangeMetricSchema,
        visitCoverage: tribunalJudicialActivityMetricSchema,
        medianDiscoveryLeadDays: tribunalJudicialActivityMetricSchema,
        discoveryLeadRangeDays: tribunalJudicialActivityRangeMetricSchema,
        medianLotsPerHearingDay: tribunalJudicialActivityMetricSchema,
        medianDaysBetweenHearingDays: tribunalJudicialActivityMetricSchema,
        topPropertyTypes: z.array(propertyTypeShareSchema).max(3),
        propertyTypeBenchmarks: z.array(propertyTypeBenchmarkSchema).max(12),
      })
      .strict(),
    reliability: z
      .object({
        level: z.enum(["insufficient_data", "indicative", "descriptive", "strong"]),
        label: z.string().min(1),
        currentSampleSize: z.number().int().nonnegative(),
        exactCourtMatch: z.literal(true),
        limitations: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    provenance: z
      .object({
        builderVersion: z.literal(TRIBUNAL_JUDICIAL_ACTIVITY_BUILDER_VERSION),
        generatedAt: isoDateTimeSchema,
        courtReferenceSource: z.literal("justice_open_data"),
        includedVerificationStatuses: z.tuple([z.literal("verified"), z.literal("cross_checked")]),
        excludedPendingOrConflictingSales: z.literal(true),
      })
      .strict(),
  })
  .strict();

export type TribunalJudicialActivityHistoryMonths = z.infer<
  typeof tribunalJudicialActivityHistoryMonthsSchema
>;
export type TribunalJudicialActivityQuery = z.infer<typeof tribunalJudicialActivityQuerySchema>;
export type TribunalJudicialActivityMetric = z.infer<typeof tribunalJudicialActivityMetricSchema>;
export type TribunalJudicialActivityRangeMetric = z.infer<
  typeof tribunalJudicialActivityRangeMetricSchema
>;
export type TribunalJudicialActivityResponse = z.infer<
  typeof tribunalJudicialActivityResponseSchema
>;

export type TribunalJudicialActivityCourt = {
  code: string;
  name: string;
  judicialRegion: string | null;
};

export type TribunalJudicialActivitySale = {
  id: string;
  saleDate: string;
  status: string;
  startingPriceEur: number | null;
  propertyType: string | null;
  visitDates: unknown;
  firstSeenAt: string | null;
};

export function judicialActivityPeriod(
  asOf: Date,
  historyMonths: TribunalJudicialActivityHistoryMonths,
): { historyStart: Date; upcomingEnd: Date } {
  assertValidDate(asOf, "asOf");
  return {
    historyStart: new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - historyMonths, 1)),
    upcomingEnd: addUtcCalendarMonths(asOf, 12),
  };
}

export function buildTribunalJudicialActivity(input: {
  court: TribunalJudicialActivityCourt;
  sales: TribunalJudicialActivitySale[];
  asOf: Date;
  historyMonths: TribunalJudicialActivityHistoryMonths;
}): TribunalJudicialActivityResponse {
  const { court, asOf, historyMonths } = input;
  const { historyStart, upcomingEnd } = judicialActivityPeriod(asOf, historyMonths);
  const upcoming90End = new Date(asOf.getTime() + 90 * 24 * 60 * 60 * 1_000);
  const seenIds = new Set<string>();
  const past: Array<TribunalJudicialActivitySale & { parsedSaleDate: Date }> = [];
  const upcoming: Array<TribunalJudicialActivitySale & { parsedSaleDate: Date }> = [];

  for (const sale of input.sales) {
    if (seenIds.has(sale.id)) throw new Error("Duplicate sale in judicial activity input.");
    seenIds.add(sale.id);
    const parsedSaleDate = new Date(sale.saleDate);
    if (!Number.isFinite(parsedSaleDate.getTime())) continue;
    if (
      parsedSaleDate >= historyStart &&
      parsedSaleDate < asOf &&
      (sale.status === "past" || sale.status === "adjudicated")
    ) {
      past.push({ ...sale, parsedSaleDate });
      continue;
    }
    if (parsedSaleDate >= asOf && parsedSaleDate < upcomingEnd && sale.status === "upcoming") {
      upcoming.push({ ...sale, parsedSaleDate });
    }
  }

  upcoming.sort(
    (left, right) =>
      left.parsedSaleDate.getTime() - right.parsedSaleDate.getTime() ||
      left.id.localeCompare(right.id),
  );
  const benchmarkSales = [...past, ...upcoming];
  const prices = benchmarkSales
    .map((sale) => sale.startingPriceEur)
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  const leadDays = benchmarkSales.flatMap((sale) => {
    if (!sale.firstSeenAt) return [];
    const firstSeen = new Date(sale.firstSeenAt);
    if (!Number.isFinite(firstSeen.getTime())) return [];
    const days = (sale.parsedSaleDate.getTime() - firstSeen.getTime()) / (24 * 60 * 60 * 1_000);
    return days >= 0 && days <= 365 ? [days] : [];
  });
  const visits = upcoming.filter((sale) => hasVisitDate(sale.visitDates)).length;
  const hearingDayCounts = new Map<string, number>();
  const propertyCounts = new Map<string, number>();
  const propertySales = new Map<string, typeof benchmarkSales>();
  for (const sale of upcoming) {
    const day = parisDateKey(sale.parsedSaleDate);
    hearingDayCounts.set(day, (hearingDayCounts.get(day) ?? 0) + 1);
  }
  for (const sale of benchmarkSales) {
    const propertyType = sale.propertyType?.trim() || "other";
    propertyCounts.set(propertyType, (propertyCounts.get(propertyType) ?? 0) + 1);
    const existing = propertySales.get(propertyType);
    if (existing) existing.push(sale);
    else propertySales.set(propertyType, [sale]);
  }
  const hearingDays = [...hearingDayCounts.keys()].sort();
  const hearingDayIntervals = hearingDays.slice(1).map((day, index) => {
    const previous = hearingDays[index]!;
    return (
      (Date.parse(`${day}T12:00:00.000Z`) - Date.parse(`${previous}T12:00:00.000Z`)) /
      (24 * 60 * 60 * 1_000)
    );
  });

  const response: TribunalJudicialActivityResponse = {
    court,
    period: {
      historyMonths,
      historyStart: historyStart.toISOString(),
      asOf: asOf.toISOString(),
      upcomingEnd: upcomingEnd.toISOString(),
    },
    activity: {
      observedPastSales: past.length,
      upcomingSales: upcoming.length,
      upcomingSales90Days: upcoming.filter((sale) => sale.parsedSaleDate < upcoming90End).length,
      upcomingHearingDays: hearingDayCounts.size,
      nextSaleAt: upcoming[0]?.parsedSaleDate.toISOString() ?? null,
      medianStartingPriceEur: sampleMetric(prices, median(prices)),
      startingPriceRangeEur: rangeMetric(prices),
      visitCoverage: sampleMetric(upcoming, upcoming.length > 0 ? visits / upcoming.length : null),
      medianDiscoveryLeadDays: sampleMetric(leadDays, median(leadDays)),
      discoveryLeadRangeDays: rangeMetric(leadDays),
      medianLotsPerHearingDay: sampleMetric(
        [...hearingDayCounts.values()],
        median([...hearingDayCounts.values()]),
        3,
      ),
      medianDaysBetweenHearingDays: sampleMetric(
        hearingDayIntervals,
        median(hearingDayIntervals),
        3,
      ),
      topPropertyTypes:
        benchmarkSales.length >= TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE
          ? [...propertyCounts.entries()]
              .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
              .slice(0, 3)
              .map(([propertyType, count]) => ({
                propertyType,
                count,
                share: round(count / benchmarkSales.length, 6),
              }))
          : [],
      propertyTypeBenchmarks: [...propertySales.entries()]
        .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
        .slice(0, 12)
        .map(([propertyType, sales]) => {
          const typePrices = sales
            .map((sale) => sale.startingPriceEur)
            .filter(
              (value): value is number => value != null && Number.isFinite(value) && value > 0,
            );
          const typeLeadDays = sales.flatMap((sale) => {
            if (!sale.firstSeenAt) return [];
            const firstSeen = new Date(sale.firstSeenAt);
            if (!Number.isFinite(firstSeen.getTime())) return [];
            const days =
              (sale.parsedSaleDate.getTime() - firstSeen.getTime()) / (24 * 60 * 60 * 1_000);
            return days >= 0 && days <= 365 ? [days] : [];
          });
          return {
            propertyType,
            observedSales: sales.length,
            startingPriceRangeEur: rangeMetric(typePrices),
            discoveryLeadRangeDays: rangeMetric(typeLeadDays),
          };
        }),
    },
    reliability: {
      ...reliability(benchmarkSales.length),
      currentSampleSize: benchmarkSales.length,
      exactCourtMatch: true,
      limitations: [
        "Comptage des annonces judiciaires suivies par Immojudis, sans garantie d’exhaustivité nationale.",
        "Les annonces en attente, conflictuelles, sans date plausible ou sans tribunal exactement rattaché sont exclues.",
        "Les taux d’adjudication, de surenchère et les prix finaux restent masqués sans résultats contrôlés suffisants.",
      ],
    },
    provenance: {
      builderVersion: TRIBUNAL_JUDICIAL_ACTIVITY_BUILDER_VERSION,
      generatedAt: asOf.toISOString(),
      courtReferenceSource: "justice_open_data",
      includedVerificationStatuses: ["verified", "cross_checked"],
      excludedPendingOrConflictingSales: true,
    },
  };
  return tribunalJudicialActivityResponseSchema.parse(response);
}

function sampleMetric(
  sample: unknown[],
  value: number | null,
  minimum = TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE,
): TribunalJudicialActivityMetric {
  if (sample.length < minimum || value == null || !Number.isFinite(value)) {
    return { status: "insufficient_data", value: null, sampleSize: sample.length };
  }
  return { status: "published", value: round(value, 2), sampleSize: sample.length };
}

function rangeMetric(
  values: number[],
  minimum = TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE,
): TribunalJudicialActivityRangeMetric {
  const sample = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (sample.length < minimum) {
    return {
      status: "insufficient_data",
      p25: null,
      p50: null,
      p75: null,
      sampleSize: sample.length,
    };
  }
  return {
    status: "published",
    p25: round(quantile(sample, 0.25)!, 2),
    p50: round(quantile(sample, 0.5)!, 2),
    p75: round(quantile(sample, 0.75)!, 2),
    sampleSize: sample.length,
  };
}

function median(values: number[]): number | null {
  return quantile(values, 0.5);
}

function quantile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = ordered[lowerIndex]!;
  const upper = ordered[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

function hasVisitDate(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function reliability(sampleSize: number): {
  level: TribunalJudicialActivityResponse["reliability"]["level"];
  label: string;
} {
  if (sampleSize < 5) return { level: "insufficient_data", label: "Données insuffisantes" };
  if (sampleSize < 20) return { level: "indicative", label: "Activité indicative" };
  if (sampleSize < 50) return { level: "descriptive", label: "Activité descriptive" };
  return { level: "strong", label: "Échantillon étendu" };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid date.`);
}

function addUtcCalendarMonths(value: Date, months: number): Date {
  const targetMonthStart = new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth() + months,
      1,
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      value.getUTCMilliseconds(),
    ),
  );
  const lastTargetDay = new Date(
    Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0),
  ).getUTCDate();
  targetMonthStart.setUTCDate(Math.min(value.getUTCDate(), lastTargetDay));
  return targetMonthStart;
}

function parisDateKey(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}
