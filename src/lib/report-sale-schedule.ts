import { listingDate } from "./sale-listing";
import { parseSaleWindow } from "./sale-window";

/** Shared by PDF and public report; older snapshots retain their single date. */
export function reportSaleSchedule(
  sale: Record<string, unknown>,
): Array<{ label: string; value: string }> {
  const window = parseSaleWindow(sale.saleWindow);
  const schedule = window ?? parseSaleWindow(sale.saleSession);
  return schedule
    ? [
        { label: window ? "Ouverture" : "Début de séance", value: listingDate(schedule.opens_at) },
        {
          label: window ? "Clôture" : "Fin de séance annoncée",
          value: listingDate(schedule.closes_at),
        },
      ]
    : [
        {
          label: "Date de vente",
          value: listingDate(typeof sale.saleDate === "string" ? sale.saleDate : null),
        },
      ];
}
