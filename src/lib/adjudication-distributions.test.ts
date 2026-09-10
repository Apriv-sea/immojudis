import { describe, expect, it } from "vitest";
import {
  adjudicationDistributionSchema,
  adjudicationEnrichmentSchema,
  bidBands,
} from "./adjudication-distributions";

const fixture = () => ({
  sampleSize: 10,
  hammerPriceMiddle50Eur: { p25: 50000, p75: 150000 },
  ratioMiddle50: { p25: 1, p75: 2 },
  bidDistribution: bidBands.map((band) => ({ band, count: 2, share: 0.2 })),
});

describe("adjudication distributions", () => {
  it("validates disjoint property samples and rejects duplicated types", () => {
    const item = { propertyType: "house", distribution: fixture() };
    expect(
      adjudicationEnrichmentSchema.safeParse({ distribution: fixture(), propertyTypes: [item] })
        .success,
    ).toBe(true);
    expect(
      adjudicationEnrichmentSchema.safeParse({
        distribution: fixture(),
        propertyTypes: [item, item],
      }).success,
    ).toBe(false);
    expect(
      adjudicationEnrichmentSchema.safeParse({
        distribution: fixture(),
        propertyTypes: [item, { ...item, propertyType: "apartment" }],
      }).success,
    ).toBe(false);
  });
  it("accepts a complete partition including results below and at the starting price", () => {
    expect(adjudicationDistributionSchema.parse(fixture()).sampleSize).toBe(10);
  });
  it("rejects a duplicated band or inconsistent denominator", () => {
    const value = fixture();
    value.bidDistribution[0] = value.bidDistribution[1];
    expect(adjudicationDistributionSchema.safeParse(value).success).toBe(false);
    expect(adjudicationDistributionSchema.safeParse({ ...fixture(), sampleSize: 11 }).success).toBe(
      false,
    );
  });
  it("rejects reversed quartiles and samples below the threshold", () => {
    expect(adjudicationDistributionSchema.safeParse({ ...fixture(), sampleSize: 9 }).success).toBe(
      false,
    );
    expect(
      adjudicationDistributionSchema.safeParse({ ...fixture(), ratioMiddle50: { p25: 2, p75: 1 } })
        .success,
    ).toBe(false);
  });
});
