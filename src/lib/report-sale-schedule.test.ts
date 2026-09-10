import { describe, expect, it } from "vitest";
import { reportSaleSchedule } from "./report-sale-schedule";

describe("report schedule shared by PDF and web", () => {
  it("identifies an audience slot without calling it a bidding window", () => {
    const rows = reportSaleSchedule({
      saleSession: {
        opens_at: "2026-09-16T13:00:00Z",
        closes_at: "2026-09-16T17:00:00Z",
      },
    });
    expect(rows.map((row) => row.label)).toEqual(["Début de séance", "Fin de séance annoncée"]);
  });
  it("keeps both boundaries with their French hours", () => {
    const rows = reportSaleSchedule({
      saleWindow: {
        opens_at: "2026-09-16T13:00:00Z",
        closes_at: "2026-09-17T13:00:00Z",
      },
    });
    expect(rows.map((row) => row.label)).toEqual(["Ouverture", "Clôture"]);
    expect(rows[0].value).toContain("16 septembre 2026");
    expect(rows[1].value).toContain("17 septembre 2026");
    expect(rows.every((row) => row.value.includes("15:00"))).toBe(true);
  });
  it("does not invent an hour for an older date-only snapshot", () => {
    expect(reportSaleSchedule({ saleDate: "2026-09-16" })).toEqual([
      { label: "Date de vente", value: "16 septembre 2026" },
    ]);
  });
});
