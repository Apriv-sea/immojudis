export function validSaleDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

// Auction calendar days are interpreted in metropolitan France, including DST.
export function saleDateBoundary(value: string, end = false): string {
  const date = validSaleDate(value);
  if (!date) throw new Error("Date de vente invalide");
  const day = new Date(date + "T00:00:00Z");
  if (end) day.setUTCDate(day.getUTCDate() + 1);
  const hourInParis = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(day),
  );
  return new Date(day.getTime() - hourInParis * 3600000 - (end ? 1 : 0)).toISOString();
}
