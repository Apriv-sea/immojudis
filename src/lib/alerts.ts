import { saleDateBoundary, validSaleDate } from "./search/sale-date-range";
import { dpeMatches, extractDpe } from "@/lib/dpe";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { parseSaleType, saleVenueMatchesType } from "@/lib/sale-types";
import { estimateGrossYieldPct, pricePerM2 } from "@/lib/geo";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale, UserAlert, UserWatchedZone } from "@/lib/types";
import { watchedZoneMatchesSale, watchedZoneSummary } from "@/lib/watched-zones-shared";

export type AlertMatchContext = {
  marketDiscountPct?: number | null;
  watchedZone?: UserWatchedZone | null;
};

export type AlertMatchResult = {
  matches: boolean;
  reasons: string[];
};

export function alertMatchesSale(
  alert: Pick<
    UserAlert,
    | "city"
    | "department"
    | "property_type"
    | "max_price_eur"
    | "min_surface_m2"
    | "occupancy_status"
    | "min_investment_score"
    | "max_price_per_m2"
    | "min_yield_pct"
    | "min_market_discount_pct"
    | "dpe_classes"
    | "require_house_with_land"
  > &
    Partial<Pick<UserAlert, "advanced_criteria">>,
  sale: AuctionSale,
  context: AlertMatchContext = {},
): AlertMatchResult {
  const reasons: string[] = [];
  const minSaleDate = validSaleDate(alert.advanced_criteria?.min_sale_date);
  const maxSaleDate = validSaleDate(alert.advanced_criteria?.max_sale_date);
  if (minSaleDate || maxSaleDate) {
    const saleTime = sale.sale_date ? Date.parse(sale.sale_date) : NaN;
    if (
      !Number.isFinite(saleTime) ||
      (minSaleDate && saleTime < Date.parse(saleDateBoundary(minSaleDate))) ||
      (maxSaleDate && saleTime > Date.parse(saleDateBoundary(maxSaleDate, true)))
    )
      return noMatch("vente hors période");
  }
  const saleType = parseSaleType(alert.advanced_criteria?.sale_type);
  if (saleType && !saleVenueMatchesType(getSaleProcedure(sale).venueType, saleType)) {
    return noMatch("type de vente différent");
  }
  const surface = getSaleSurface(sale).value;
  const ppm2 = pricePerM2(sale.starting_price_eur, surface);
  const yieldPct = estimateGrossYieldPct(sale.starting_price_eur, surface, sale.department);
  const dpe = extractDpe(sale).class;
  const acceptedDpeClasses = alert.dpe_classes ?? [];

  if (context.watchedZone && !watchedZoneMatchesSale(context.watchedZone, sale)) {
    return noMatch("hors zone surveillée");
  }
  if (alert.city && !sameText(sale.city, alert.city)) return noMatch("ville différente");
  if (alert.department && sale.department !== alert.department) {
    return noMatch("département différent");
  }
  if (alert.property_type && !matchesText(sale.property_type, alert.property_type)) {
    return noMatch("type de bien différent");
  }
  if (alert.max_price_eur != null && (sale.starting_price_eur ?? Infinity) > alert.max_price_eur) {
    return noMatch("budget dépassé");
  }
  if (alert.min_surface_m2 != null && (surface == null || surface < alert.min_surface_m2)) {
    return noMatch("surface insuffisante");
  }
  if (alert.occupancy_status && !sameText(sale.occupancy_status, alert.occupancy_status)) {
    return noMatch("occupation différente");
  }
  if (
    alert.min_investment_score != null &&
    (sale.investment_score == null || sale.investment_score < alert.min_investment_score)
  ) {
    return noMatch("score insuffisant");
  }
  if (alert.max_price_per_m2 != null && (ppm2 == null || ppm2 > alert.max_price_per_m2)) {
    return noMatch("prix au m² trop élevé");
  }
  if (alert.min_yield_pct != null && (yieldPct == null || yieldPct < alert.min_yield_pct)) {
    return noMatch("rendement estimé insuffisant");
  }
  if (!dpeMatches(dpe, acceptedDpeClasses)) return noMatch("classe DPE différente");
  if (alert.require_house_with_land && !isHouseWithLand(sale)) {
    return noMatch("maison avec terrain absente");
  }
  if (
    alert.min_market_discount_pct != null &&
    (context.marketDiscountPct == null || context.marketDiscountPct < alert.min_market_discount_pct)
  ) {
    return noMatch("décote marché insuffisante");
  }

  if (alert.max_price_per_m2 != null && ppm2 != null) reasons.push("prix au m²");
  if (alert.min_yield_pct != null && yieldPct != null) reasons.push("rendement");
  if (acceptedDpeClasses.length && dpe) reasons.push(`DPE ${dpe}`);
  if (alert.require_house_with_land) reasons.push("terrain");
  if (alert.min_market_discount_pct != null) reasons.push("décote");
  if (context.watchedZone) reasons.push(watchedZoneSummary(context.watchedZone));

  return { matches: true, reasons };
}

export function isHouseWithLand(sale: AuctionSale): boolean {
  const type = `${sale.property_type ?? ""} ${sale.title ?? ""}`.toLowerCase();
  const houseLike = /house|maison|villa|immeuble|building/.test(type);
  return houseLike && (Boolean(sale.has_garden) || (sale.land_surface_m2 ?? 0) > 0);
}

function noMatch(reason: string): AlertMatchResult {
  return { matches: false, reasons: [reason] };
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalize(a) === normalize(b);
}

function matchesText(value: string | null | undefined, expected: string): boolean {
  return normalize(value).includes(normalize(expected));
}

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}
