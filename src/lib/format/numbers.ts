export function formatPrice(value: number | null | undefined): string {
  if (value == null) return "Prix non communiqué";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatCurrency(
  value: number | null | undefined,
  currency = "EUR",
  locale = "fr-FR",
): string {
  if (value == null || !Number.isFinite(value)) return "Prix non communiqué";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatNumber(value: number | null | undefined, locale = "fr-FR"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

export function formatPropertyArea(sqft: number | null | undefined, locale = "fr-FR"): string {
  if (sqft == null || !Number.isFinite(sqft)) return "Surface non communiquée";
  return `${formatNumber(sqft, locale)} ft²`;
}

export function formatPricePerM2(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: 0,
  }).format(value)} €/m²`;
}

export function formatSurface(m2: number | null | undefined): string {
  if (m2 == null) return "—";
  return `${Math.round(m2)} m²`;
}
