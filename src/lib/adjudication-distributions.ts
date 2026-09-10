import { z } from "zod";

export const bidBands = [
  "below_starting",
  "at_starting",
  "above_1_below_1_5",
  "from_1_5_below_2",
  "at_least_2",
] as const;

const range = z
  .object({ p25: z.number().positive(), p75: z.number().positive() })
  .strict()
  .refine((value) => value.p25 <= value.p75, "Quartiles inversés");

export const adjudicationDistributionSchema = z
  .object({
    sampleSize: z.number().int().min(10),
    hammerPriceMiddle50Eur: range,
    ratioMiddle50: range,
    bidDistribution: z
      .array(
        z
          .object({
            band: z.enum(bidBands),
            count: z.number().int().nonnegative(),
            share: z.number().min(0).max(1),
          })
          .strict(),
      )
      .length(5),
  })
  .strict()
  .superRefine((value, context) => {
    const bins = value.bidDistribution;
    if (
      new Set(bins.map((bin) => bin.band)).size !== 5 ||
      bins.reduce((sum, bin) => sum + bin.count, 0) !== value.sampleSize ||
      bins.some((bin) => Math.abs(bin.share - bin.count / value.sampleSize) > 0.000001)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Répartition incohérente" });
    }
  });

export type AdjudicationDistribution = z.infer<typeof adjudicationDistributionSchema>;

export const propertyTypeDistributionsSchema = z
  .array(
    z
      .object({
        propertyType: z.enum([
          "apartment",
          "house",
          "commercial",
          "building",
          "land",
          "parking",
          "mixed",
        ]),
        distribution: adjudicationDistributionSchema,
      })
      .strict(),
  )
  .max(7)
  .refine(
    (items) => new Set(items.map((item) => item.propertyType)).size === items.length,
    "Types de biens dupliqués",
  );

export const adjudicationEnrichmentSchema = z
  .object({
    distribution: adjudicationDistributionSchema,
    propertyTypes: propertyTypeDistributionsSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.propertyTypes.reduce((sum, item) => sum + item.distribution.sampleSize, 0) <=
      value.distribution.sampleSize,
    "Les sous-échantillons dépassent le total",
  );

export const bidBandLabels: Record<(typeof bidBands)[number], string> = {
  below_starting: "Sous la mise à prix",
  at_starting: "À la mise à prix",
  above_1_below_1_5: "Au-dessus de la mise, moins de × 1,5",
  from_1_5_below_2: "De × 1,5 à moins de × 2",
  at_least_2: "Au moins × 2",
};
