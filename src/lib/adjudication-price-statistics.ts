import { z } from "zod";
import {
  adjudicationDistributionSchema,
  propertyTypeDistributionsSchema,
} from "@/lib/adjudication-distributions";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const probabilitySchema = z.number().min(0).max(1);

export const adjudicationPriceStatisticsReliabilitySchema = z.enum([
  "limited",
  "descriptive",
  "extended",
]);

export const adjudicationPriceStatisticsScopeSchema = z
  .object({
    scopeType: z.enum(["national", "tribunal"]),
    label: z.string().min(1),
    courtCode: z.string().min(1).nullable(),
    judicialRegion: z.string().min(1).nullable(),
    periodStart: isoDateSchema,
    periodEnd: isoDateSchema,
    sampleSize: z.number().int().min(10),
    reliability: adjudicationPriceStatisticsReliabilitySchema,
    distribution: adjudicationDistributionSchema.nullable().optional(),
    propertyTypes: propertyTypeDistributionsSchema.optional(),
    metrics: z
      .object({
        medianHammerToStartingRatio: z.number().positive(),
        aboveStartingRate: probabilitySchema,
        atLeastDoubleRate: probabilitySchema,
        medianHammerPriceEur: z.number().positive(),
        medianStartingPriceEur: z.number().positive(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (scope) => !scope.distribution || scope.distribution.sampleSize === scope.sampleSize,
    "La répartition doit correspondre au même échantillon",
  )
  .refine(
    (scope) =>
      (scope.propertyTypes ?? []).reduce((sum, item) => sum + item.distribution.sampleSize, 0) <=
      scope.sampleSize,
    "Les sous-échantillons dépassent le total",
  );

export const adjudicationPriceStatisticsResponseSchema = z
  .object({
    national: adjudicationPriceStatisticsScopeSchema,
    tribunal: adjudicationPriceStatisticsScopeSchema.nullable(),
    meta: z
      .object({
        sourceName: z.literal("licitor"),
        sourceLabel: z.literal("Résultats d’adjudication publiés par Licitor"),
        methodologyVersion: z.literal("licitor_canonical_price_statistics_v1"),
        builtAt: isoDateTimeSchema,
        reviewedAt: isoDateTimeSchema,
        experimental: z.literal(true),
        warning: z.literal(
          "Statistiques descriptives historiques sur trois ans, sans valeur prédictive ni estimation du bien.",
        ),
      })
      .strict(),
  })
  .strict();

export type AdjudicationPriceStatisticsScope = z.infer<
  typeof adjudicationPriceStatisticsScopeSchema
>;
export type AdjudicationPriceStatisticsResponse = z.infer<
  typeof adjudicationPriceStatisticsResponseSchema
>;

export function adjudicationPriceStatisticsReliability(
  sampleSize: number,
): AdjudicationPriceStatisticsScope["reliability"] {
  if (sampleSize >= 100) return "extended";
  if (sampleSize >= 30) return "descriptive";
  return "limited";
}
