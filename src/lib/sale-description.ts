import type { AuctionSale } from "@/lib/types";
import { getSaleProcedure, saleVenueLabel } from "./sale-procedure";
import { formatDate, formatPrice, formatSurface, propertyTypeLabel } from "./format";
import { listingOccupation, listingValuationConflict, listingSaleStatus } from "./listing-evidence";
import { saleSession, saleWindow } from "./sale-window";
import { listingDate } from "./sale-listing";

function clean(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function getSaleAiDescription(sale: AuctionSale): string | null {
  return clean(sale.llm_display_description);
}

function getSaleFallbackDescription(sale: AuctionSale): string | null {
  return clean(sale.about_description) ?? clean(sale.source_description) ?? clean(sale.description);
}

export function getSaleDisplayDescription(sale: AuctionSale): string {
  return (
    getSaleAiDescription(sale) ??
    getSaleFallbackDescription(sale) ??
    buildStructuredDescription(sale)
  );
}

export function hasSaleAiDescription(sale: AuctionSale): boolean {
  return getSaleAiDescription(sale) !== null;
}

export function buildStructuredDescription(sale: AuctionSale, now = new Date()): string {
  const location = [sale.city, sale.department].filter(Boolean).join(", ");
  const procedure = getSaleProcedure(sale);
  const venue = procedure.venueName;
  const price =
    sale.starting_price_eur != null &&
    Number.isFinite(sale.starting_price_eur) &&
    sale.starting_price_eur > 0
      ? ` avec une mise à prix de ${formatPrice(sale.starting_price_eur)}`
      : ", avec une mise à prix à confirmer";
  const saleDate = formatDate(sale.sale_date);
  const window = saleWindow(sale);
  const session = saleSession(sale);
  const valuationConflict = listingValuationConflict(sale);
  const status = listingSaleStatus(sale, now);
  const withdrawn = ["cancelled", "canceled", "postponed"].includes(sale.status ?? "");
  const past = status?.startsWith("Date de vente passée") ?? false;
  const facts = [
    valuationConflict ? "type de bien à confirmer" : propertyTypeLabel(sale.property_type),
    valuationConflict ? "surface à vérifier" : saleSurfaceLabel(sale),
    sale.rooms_count ? `${sale.rooms_count} pièce${sale.rooms_count > 1 ? "s" : ""}` : null,
    listingOccupation(sale),
  ].filter((fact): fact is string => Boolean(fact && fact !== "Non renseigné"));

  return [
    `Ce bien${location ? ` situé à ${location}` : ""}${withdrawn || past ? " figure dans un dossier de vente" : " est proposé à la vente"}${price}.`,
    `${saleVenueLabel(procedure.venueType)}.`,
    status ? `${status}.` : "",
    withdrawn
      ? "La date précédemment annoncée ne vaut pas rendez-vous confirmé."
      : past
        ? saleDate !== "Date à confirmer"
          ? `Date annoncée dans le dossier : ${saleDate}.`
          : "La date exacte reste à confirmer."
        : window
          ? `Les enchères ouvrent le ${listingDate(window.opens_at)} et clôturent le ${listingDate(window.closes_at)}.`
          : session
            ? `La séance est annoncée du ${listingDate(session.opens_at)} au ${listingDate(session.closes_at)}. L’heure de passage du lot reste à confirmer.`
            : saleDate !== "Date à confirmer"
              ? `La vente est prévue le ${saleDate}${venue ? ` auprès de ${venue}` : ""}.`
              : "La date de vente reste à confirmer.",
    facts.length
      ? `Les informations disponibles indiquent : ${facts.join(", ")}.`
      : "Les caractéristiques détaillées restent à vérifier dans les pièces du dossier.",
  ]
    .filter(Boolean)
    .join(" ");
}

function saleSurfaceLabel(sale: AuctionSale): string | null {
  if (sale.app_surface_m2 != null) return `surface retenue ${formatSurface(sale.app_surface_m2)}`;
  if (sale.habitable_surface_m2 != null) {
    const label = ["apartment", "house"].includes(sale.property_type ?? "")
      ? "surface habitable"
      : "surface renseignée";
    return `${label} ${formatSurface(sale.habitable_surface_m2)}`;
  }
  if (sale.carrez_surface_m2 != null)
    return `surface Carrez ${formatSurface(sale.carrez_surface_m2)}`;
  if (sale.land_surface_m2 != null) return `terrain ${formatSurface(sale.land_surface_m2)}`;
  return null;
}
