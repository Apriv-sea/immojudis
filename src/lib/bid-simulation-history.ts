import {
  WORKS_SCENARIOS,
  type MarketCeilingResult,
  type MarketCeilingScenarioKey,
  type WorksScenarioKey,
} from "@/lib/profitability";

export type BidAssistantState = {
  price: number;
  works: number;
  worksScenario: WorksScenarioKey | null;
  fpt: number;
  scenario: MarketCeilingScenarioKey | "custom";
  customSafetyDiscountPct?: number;
  manualMarketPricePerM2: number;
  marketEdited: boolean;
};

export type BidSimulationSnapshot = {
  id: string;
  label: string;
  savedAt: string;
  inputs: BidAssistantState;
  result: Pick<
    MarketCeilingResult,
    "maxBid" | "surface" | "marketReferencePricePerM2" | "safetyDiscountPct"
  >;
};

export const MAX_SAVED_SIMULATIONS = 20;

export function bidStorageKey(kind: "draft" | "history", ownerId: string, saleId: string): string {
  // Do not import the old unscoped draft: it may belong to another account on this device.
  return `immojudis:bid-${kind}:v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(saleId)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function amount(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
  );
}

export function isBidAssistantState(value: unknown): value is BidAssistantState {
  return (
    record(value) &&
    amount(value.price) &&
    amount(value.works) &&
    amount(value.fpt) &&
    amount(value.manualMarketPricePerM2) &&
    typeof value.marketEdited === "boolean" &&
    (value.scenario === "prudent" ||
      value.scenario === "offensif" ||
      value.scenario === "custom") &&
    (value.scenario !== "custom" || value.customSafetyDiscountPct !== undefined) &&
    (value.customSafetyDiscountPct === undefined ||
      (amount(value.customSafetyDiscountPct) && value.customSafetyDiscountPct <= 40)) &&
    (value.worksScenario === null ||
      WORKS_SCENARIOS.some((scenario) => scenario.key === value.worksScenario))
  );
}

export function parseBidDraft(raw: string | null): BidAssistantState | null {
  if (!raw || raw.length > 10_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isBidAssistantState(value) ? value : null;
  } catch {
    return null;
  }
}

export function canSaveBidSimulation(inputs: unknown, result: MarketCeilingResult): boolean {
  return (
    isBidAssistantState(inputs) &&
    result.available &&
    amount(result.maxBid) &&
    amount(result.surface) &&
    result.surface > 0 &&
    amount(result.marketReferencePricePerM2) &&
    result.marketReferencePricePerM2 > 0 &&
    amount(result.safetyDiscountPct) &&
    result.safetyDiscountPct <= 100
  );
}

function isSnapshot(value: unknown): value is BidSimulationSnapshot {
  return (
    record(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 100 &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= 60 &&
    typeof value.savedAt === "string" &&
    Number.isFinite(Date.parse(value.savedAt)) &&
    isBidAssistantState(value.inputs) &&
    record(value.result) &&
    amount(value.result.maxBid) &&
    amount(value.result.surface) &&
    value.result.surface > 0 &&
    amount(value.result.marketReferencePricePerM2) &&
    value.result.marketReferencePricePerM2 > 0 &&
    amount(value.result.safetyDiscountPct) &&
    value.result.safetyDiscountPct <= 100
  );
}

export function parseBidHistory(raw: string | null): BidSimulationSnapshot[] {
  if (!raw || raw.length > 200_000) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || !Array.isArray(value.entries)) return [];
    const seen = new Set<string>();
    return value.entries
      .filter(isSnapshot)
      .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))
      .filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      })
      .slice(0, MAX_SAVED_SIMULATIONS);
  } catch {
    return [];
  }
}

export function serializeBidHistory(entries: BidSimulationSnapshot[]): string {
  return JSON.stringify({ version: 1, entries: entries.slice(0, MAX_SAVED_SIMULATIONS) });
}
