export function formatDate(value: string | null | undefined): string {
  if (!value) return "Date à confirmer";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "Date à confirmer";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    timeZone: "Europe/Paris",
    year: "numeric",
  }).format(d);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    timeZone: "Europe/Paris",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
