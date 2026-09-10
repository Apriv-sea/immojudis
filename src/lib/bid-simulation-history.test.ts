import { describe, expect, it } from "vitest";
import {
  bidStorageKey,
  canSaveBidSimulation,
  parseBidDraft,
  parseBidHistory,
  serializeBidHistory,
  type BidAssistantState,
  type BidSimulationSnapshot,
} from "./bid-simulation-history";
import { computeMarketCeiling } from "./profitability";

const inputs: BidAssistantState = {
  price: 100000,
  works: 20000,
  worksScenario: null,
  fpt: 3000,
  scenario: "prudent",
  manualMarketPricePerM2: 3000,
  marketEdited: true,
};
const result = computeMarketCeiling({ ...inputs, surface: 75 });
const snapshot: BidSimulationSnapshot = {
  id: "snapshot-1",
  label: "Travaux limités",
  savedAt: "2026-08-28T10:00:00.000Z",
  inputs,
  result,
};

describe("local bid simulation storage", () => {
  it("round-trips a complete dated snapshot and a draft", () => {
    expect(parseBidDraft(JSON.stringify(inputs))).toEqual(inputs);
    expect(parseBidHistory(serializeBidHistory([snapshot]))).toEqual([snapshot]);
    expect(canSaveBidSimulation(inputs, result)).toBe(true);
  });
  it("bounds the custom margin and requires it for a custom profile", () => {
    for (const margin of [-1, 41, null, "19"]) {
      expect(
        parseBidDraft(
          JSON.stringify({ ...inputs, scenario: "custom", customSafetyDiscountPct: margin }),
        ),
      ).toBeNull();
    }
    expect(
      parseBidDraft(JSON.stringify({ ...inputs, scenario: "custom", customSafetyDiscountPct: 19 }))
        ?.customSafetyDiscountPct,
    ).toBe(19);
  });
  it("separates users, properties, drafts and histories", () => {
    expect(
      new Set([
        bidStorageKey("draft", "a", "one"),
        bidStorageKey("history", "a", "one"),
        bidStorageKey("history", "b", "one"),
        bidStorageKey("history", "a", "two"),
        bidStorageKey("history", "a:b", "one"),
        bidStorageKey("history", "a", "b:one"),
      ]).size,
    ).toBe(6);
  });
  it.each([null, "", "not-json", "[]", '{"version":2,"entries":[]}', "x".repeat(200001)])(
    "rejects malformed history",
    (raw) => {
      expect(parseBidHistory(raw)).toEqual([]);
    },
  );
  it.each([-1, null, "1200", Infinity, NaN, 1e12])("rejects unsafe numeric inputs: %s", (price) => {
    const invalid = { ...inputs, price };
    expect(parseBidDraft(JSON.stringify(invalid))).toBeNull();
    expect(canSaveBidSimulation(invalid, result)).toBe(false);
    expect(
      parseBidHistory(JSON.stringify({ version: 1, entries: [{ ...snapshot, inputs: invalid }] })),
    ).toEqual([]);
  });
  it("rejects unknown profiles, invalid dates and uncomputable results", () => {
    expect(parseBidDraft(JSON.stringify({ ...inputs, scenario: "custom" }))).toBeNull();
    expect(parseBidDraft(JSON.stringify({ ...inputs, worksScenario: "unknown" }))).toBeNull();
    expect(canSaveBidSimulation(inputs, { ...result, available: false })).toBe(false);
    expect(canSaveBidSimulation(inputs, { ...result, maxBid: Infinity })).toBe(false);
    expect(
      parseBidHistory(
        JSON.stringify({ version: 1, entries: [{ ...snapshot, savedAt: "invalid" }, snapshot] }),
      ),
    ).toEqual([snapshot]);
  });
  it("keeps the 20 latest valid entries and deduplicates ids", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      ...snapshot,
      id: `snapshot-${i}`,
      savedAt: new Date(Date.UTC(2026, 7, i + 1)).toISOString(),
    }));
    const loaded = parseBidHistory(
      JSON.stringify({ version: 1, entries: [...entries, entries[24]] }),
    );
    expect(loaded).toHaveLength(20);
    expect(loaded[0].id).toBe("snapshot-24");
    expect(loaded[19].id).toBe("snapshot-5");
  });
});
