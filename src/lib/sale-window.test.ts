import { describe, expect, it } from "vitest";
import { isActiveComparableSale, saleWindow } from "./sale-window";
import { listingSaleStatus } from "./listing-evidence";
import type { AuctionSale } from "./types";
import { EXAMPLE_SALE } from "./example-sale";

const window = { opens_at: "2026-09-16T13:00:00Z", closes_at: "2026-09-17T13:00:00Z" };
const sale = (value: unknown = window, status = "upcoming"): AuctionSale => ({
  ...EXAMPLE_SALE,
  sale_date: window.opens_at,
  sale_procedure: { sale_window: value },
  status,
});

describe("source bidding window", () => {
  it("does not describe an audience slot as ongoing online bidding", () => {
    const session: AuctionSale = {
      ...EXAMPLE_SALE,
      sale_date: window.opens_at,
      sale_procedure: { sale_session: window },
    };
    expect(listingSaleStatus(session, new Date("2026-09-17T08:00:00Z"))).toBeNull();
    expect(listingSaleStatus(session, new Date(window.closes_at))).toContain(
      "résultat à confirmer",
    );
  });
  it("stays ongoing after midnight and ends at the published closing instant", () => {
    expect(listingSaleStatus(sale(), new Date("2026-09-17T08:00:00Z"))).toBe("Enchères en cours");
    expect(listingSaleStatus(sale(), new Date(window.closes_at))).toBe(
      "Date de vente passée · résultat à confirmer",
    );
    expect(listingSaleStatus(sale(), new Date("2026-09-16T12:59:00Z"))).toBeNull();
  });
  it("preserves cancellation and postponement over the calendar", () => {
    expect(listingSaleStatus(sale(window, "cancelled"), new Date(window.opens_at))).toBe(
      "Vente annulée",
    );
    expect(listingSaleStatus(sale(window, "postponed"), new Date(window.opens_at))).toContain(
      "Vente reportée",
    );
  });
  it("rejects missing zones, missing boundaries and reversed intervals", () => {
    for (const value of [
      null,
      {},
      { ...window, opens_at: "2026-09-16T13:00:00" },
      { ...window, closes_at: window.opens_at },
      { ...window, closes_at: "2026-09-15T13:00:00Z" },
    ]) {
      expect(saleWindow(sale(value))).toBeNull();
    }
  });
});

describe("active comparable eligibility", () => {
  it("keeps a bidding window active after opening and excludes it at closing", () => {
    expect(isActiveComparableSale(sale(), new Date("2026-09-17T08:00:00Z"))).toBe(true);
    expect(isActiveComparableSale(sale(), new Date(window.closes_at))).toBe(false);
  });
  it("excludes cancelled, postponed, withdrawn and completed sales despite future dates", () => {
    for (const status of [
      "cancelled",
      "canceled",
      "postponed",
      "withdrawn",
      "past",
      "adjudicated",
      "sold",
    ]) {
      expect(isActiveComparableSale(sale(window, status), new Date("2026-09-15T08:00:00Z"))).toBe(
        false,
      );
    }
  });
  it("keeps a date-only sale through its Paris calendar day, with no invented hour", () => {
    const candidate = {
      ...EXAMPLE_SALE,
      status: "upcoming",
      sale_procedure: null,
      sale_date: "2026-09-17",
    };
    expect(isActiveComparableSale(candidate, new Date("2026-09-17T21:59:00Z"))).toBe(true);
    expect(isActiveComparableSale(candidate, new Date("2026-09-17T22:00:00Z"))).toBe(false);
    expect(isActiveComparableSale({ ...candidate, sale_date: null })).toBe(false);
  });
});
