import { occupancyLabel } from "./format";
import type { AuctionSale } from "./types";
import { saleSession, saleWindow } from "./sale-window";

export function listingValuationConflict(sale: AuctionSale): string | null {
  const blocks =
    sale.source_blocks &&
    typeof sale.source_blocks === "object" &&
    !Array.isArray(sale.source_blocks)
      ? (sale.source_blocks as Record<string, unknown>)
      : {};
  const detailedTitle = typeof blocks.titre_detail === "string" ? blocks.titre_detail.trim() : "";
  if (
    sale.property_type === "land" &&
    /^(?:un[e]?\s+)?(?:appartement|studio|maison|villa)\b/i.test(detailedTitle)
  ) {
    return `Type de bien contradictoire : la catégorie indique un terrain, mais le titre de la source indique « ${detailedTitle} ». La surface et les références de marché doivent être vérifiées avant tout calcul.`;
  }
  return null;
}

const months = [
  "janvier",
  "fevrier",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "aout",
  "septembre",
  "octobre",
  "novembre",
  "decembre",
];
const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Calendar dates only: a visit remains current for its whole published day. */
export function publishedDay(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    const instant = new Date(value);
    return Number.isFinite(instant.getTime()) ? parisDay(instant) : null;
  }
  const text = normalize(value);
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  const french =
    /\b(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})\b/.exec(
      text,
    );
  const day = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : french
      ? `${french[3]}-${String(months.indexOf(french[2]) + 1).padStart(2, "0")}-${french[1].padStart(2, "0")}`
      : null;
  if (!day) return null;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

/** Never choose arbitrarily between multiple recipients. The user can edit the suggestion. */
export function listingContactEmail(sale: AuctionSale): string {
  const emails = (value: string) => [
    ...new Set(
      (value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((email) =>
        email.toLowerCase(),
      ),
    ),
  ];
  const explicit = emails(sale.lawyer_contact ?? "");
  if (explicit.length) return explicit.length === 1 ? explicit[0] : "";
  const source = emails(sale.source_description ?? sale.description ?? "");
  return source.length === 1 ? source[0] : "";
}

function parisDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function visitHasPassed(value: string, now = new Date()): boolean {
  const day = publishedDay(value);
  return day != null && day < parisDay(now);
}

export function sourceVisitExcerpt(sale: AuctionSale): string | null {
  const source = sale.source_description ?? sale.description ?? "";
  const match =
    /\bvisite(?:s)?\s+(?:(?:sur place|pr[ée]vue)\s+)?(?:sur place\s+)?(?:le\s*)?:?\s*((?:(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+)?\d{1,2}\s+[a-zà-ÿ]+\s+\d{4}[^.\n]{0,60})/i.exec(
      source,
    );
  return match && publishedDay(match[1]) ? match[1].trim() : null;
}

export function listingOccupation(sale: AuctionSale): string {
  if (sale.occupancy_status === "vacant") {
    const text = normalize(sale.source_description ?? sale.description ?? "");
    if (/inoccupe[^.]{0,80}(?:lors|constat|pv|proces.verbal)/.test(text))
      return "Inoccupé au constat";
    if (/\binoccupe(?:e|s|es)?\b/.test(text) && !/\b(?:pas|non)\s+inoccupe/.test(text)) {
      return "Inoccupé selon l’annonce";
    }
    return "Libre selon l’annonce";
  }
  const label = occupancyLabel(sale.occupancy_status);
  return label === "Non renseigné" ? "À confirmer" : label;
}

export function listingSaleStatus(sale: AuctionSale, now = new Date()): string | null {
  if (["cancelled", "canceled"].includes(sale.status ?? "")) return "Vente annulée";
  if (sale.status === "postponed") return "Vente reportée · nouvelle date à confirmer";
  const window = saleWindow(sale);
  const schedule = window ?? saleSession(sale);
  const elapsed = schedule
    ? now.getTime() >= Date.parse(schedule.closes_at)
    : sale.sale_date && visitHasPassed(sale.sale_date, now);
  if (sale.status === "past" || elapsed)
    return sale.adjudication_price_eur != null
      ? "Date de vente passée · résultat renseigné"
      : "Date de vente passée · résultat à confirmer";
  if (window && now.getTime() >= Date.parse(window.opens_at)) return "Enchères en cours";
  return null;
}

export function saleTimeConflict(sale: AuctionSale): string | null {
  const source = sale.source_description ?? sale.description ?? "";
  const match =
    /adjudication\s+le\s+(\d{1,2}\s+[a-zà-ÿ]+\s+\d{4})\s+[àa]\s+(\d{1,2})\s*[:h]\s*(\d{2})?/i.exec(
      source,
    );
  if (!match || !sale.sale_date || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(sale.sale_date)) return null;
  const date = new Date(sale.sale_date);
  if (!Number.isFinite(date.getTime())) return null;
  const sourceDay = publishedDay(match[1]);
  const sourceTime = `${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
  if (Number(match[2]) > 23 || Number(match[3] ?? "0") > 59 || !sourceDay) return null;
  const actualTime = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  return sourceDay !== parisDay(date) || sourceTime !== actualTime
    ? `Date ou horaire contradictoire : le texte source indique le ${match[1]} à ${sourceTime}. Faites confirmer le rendez-vous par l’organisateur.`
    : null;
}
