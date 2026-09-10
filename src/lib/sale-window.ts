import type { AuctionSale } from "./types";

/** Explicit source timestamps only; a court audience slot is not a bidding window. */
export function saleWindow(sale: AuctionSale): { opens_at: string; closes_at: string } | null {
  return parseSaleWindow(sale.sale_procedure?.sale_window);
}

export function saleSession(sale: AuctionSale): { opens_at: string; closes_at: string } | null {
  return parseSaleWindow(sale.sale_procedure?.sale_session);
}

export function parseSaleWindow(value: unknown): { opens_at: string; closes_at: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { opens_at, closes_at } = value as Record<string, unknown>;
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (typeof opens_at !== "string" || typeof closes_at !== "string") return null;
  if (!zoned.test(opens_at) || !zoned.test(closes_at)) return null;
  const start = Date.parse(opens_at);
  const end = Date.parse(closes_at);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { opens_at, closes_at }
    : null;
}

/** Eligibility for the active-offer comparison, independent of similarity. */
export function isActiveComparableSale(sale: AuctionSale, now = new Date()): boolean {
  if (
    ["cancelled", "canceled", "postponed", "withdrawn", "past", "adjudicated", "sold"].includes(
      (sale.status ?? "").toLowerCase(),
    )
  )
    return false;
  const schedule = saleWindow(sale) ?? saleSession(sale);
  if (schedule) return Date.parse(schedule.closes_at) > now.getTime();
  if (!sale.sale_date) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(sale.sale_date)) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(now);
    return Number.isFinite(Date.parse(sale.sale_date)) && sale.sale_date >= today;
  }
  return Number.isFinite(Date.parse(sale.sale_date)) && Date.parse(sale.sale_date) > now.getTime();
}
