import { safeExternalHttpUrl } from "@/lib/external-url";
import { formatDateTime } from "@/lib/format";
import { getDisplaySurface, getMarketValuationSurfaces } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";
import { publishedDay, sourceVisitExcerpt } from "./listing-evidence";

export function listingAddress(sale: AuctionSale): string {
  const address = sale.address?.trim() ?? "";
  const normalize = (value: string) =>
    value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const normalized = normalize(address);
  const missing = [sale.postal_code, sale.city].filter((value): value is string =>
    Boolean(value?.trim() && !normalized.includes(normalize(value))),
  );
  return [address, missing.join(" ")].filter(Boolean).join(", ");
}

export function positiveListingNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

export function listingSurface(sale: AuctionSale) {
  const display = getDisplaySurface(sale);
  const marketSurfaces = getMarketValuationSurfaces(sale);
  const surface =
    marketSurfaces.surfaceKind === "land"
      ? { ...display, value: marketSurfaces.landSurfaceM2, kind: "land" as const, estimated: false }
      : display;
  const price = positiveListingNumber(sale.starting_price_eur);
  const label = surface.estimated
    ? "Surface estimée"
    : surface.kind === "land"
      ? "Surface du terrain"
      : /carrez/i.test(sale.app_surface_kind ?? "") ||
          (sale.app_surface_m2 == null &&
            sale.habitable_surface_m2 == null &&
            sale.carrez_surface_m2 != null)
        ? "Surface Carrez"
        : "Surface";
  return {
    ...surface,
    label,
    formatted:
      surface.value == null
        ? "À confirmer"
        : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(surface.value)} m²`,
    // A provisional studio surface or a plot is not a measured living area.
    pricePerM2:
      price != null && surface.value != null && surface.kind === "recorded"
        ? price / surface.value
        : null,
  };
}

export function listingCoordinates(sale: AuctionSale): { lat: number; lng: number } | null {
  const { latitude: lat, longitude: lng } = sale;
  return lat != null &&
    lng != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
    ? { lat, lng }
    : null;
}

export function listingDate(value: string | null | undefined): string {
  if (!value?.trim()) return "À confirmer";
  const text = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const date = new Date(`${text}T12:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) return text;
    return new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Europe/Paris",
    }).format(date);
  }
  // Human-readable visit slots have no timezone. Keep their published local time.
  const visit = /^(\d{4}-\d{2}-\d{2})\s+(?:à\s+)?(\d{1,2})[:h](\d{2})(.*)$/.exec(text);
  if (visit && Number(visit[2]) < 24 && Number(visit[3]) < 60) {
    return `${listingDate(visit[1])} · ${visit[2].padStart(2, "0")}:${visit[3]}${visit[4]}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    // Unzoned times are local to the sale, not the browser or build server.
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text);
      return local ? listingDate(`${local[1]} à ${local[2]}`) : text;
    }
    const formatted = formatDateTime(text);
    return formatted === "—" ? text : formatted;
  }
  return text;
}

export function listingVisits(sale: AuctionSale): string[] {
  const values = Array.isArray(sale.visit_dates)
    ? sale.visit_dates.filter(
        (value): value is string => typeof value === "string" && !!value.trim(),
      )
    : typeof sale.visit_dates === "string" && sale.visit_dates.trim()
      ? [sale.visit_dates]
      : [];
  const fallback = ["visites", "visite", "date_de_visite", "detail_date_de_visite", "visit_dates"]
    .map((key) => sale.source_blocks?.[key])
    .filter((value): value is string => typeof value === "string" && !!value.trim());
  const retained = values.length ? values : fallback;
  const sourceVisit = retained.some((value) => publishedDay(value))
    ? null
    : sourceVisitExcerpt(sale);
  return [...new Set([...(sourceVisit ? [sourceVisit] : []), ...retained].map(listingDate))];
}

export type ListingContactLink = {
  label: string;
  href: string;
  kind: "email" | "phone" | "website";
};

export function listingContactLinks(value: string | null | undefined): ListingContactLink[] {
  if (!value) return [];
  const links: ListingContactLink[] = [];
  const withoutUrls = value.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    const url = safeExternalHttpUrl(raw.replace(/[.,;)]+$/, ""));
    if (url) links.push({ label: new URL(url).hostname, href: url, kind: "website" });
    return " ";
  });
  const withoutEmails = withoutUrls.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => {
    links.push({ label: email, href: `mailto:${email}`, kind: "email" });
    return " ";
  });
  for (const match of withoutEmails.matchAll(
    /(?<![\d+])(?:\+33\s?(?:\(0\)\s?)?|0)[1-9](?:[ .-]?\d{2}){4}(?!\d)/g,
  )) {
    const prefix = withoutEmails.slice(0, match.index);
    if (/(?:fax|télécopie|telecopie|télécopieur|telecopieur)\s*[.:]?\s*$/i.test(prefix)) continue;
    const phone = match[0];
    links.push({
      label: phone,
      href: `tel:${phone.replace(/\(0\)/, "").replace(/[^\d+]/g, "")}`,
      kind: "phone",
    });
  }
  return links.filter(
    (link, index) => links.findIndex((other) => other.href === link.href) === index,
  );
}

export function parseBudgetAmount(value: string): number | null {
  const normalized = value
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount <= 1_000_000_000 ? amount : null;
}
