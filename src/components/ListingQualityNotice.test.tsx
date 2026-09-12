// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ListingQualityNotice } from "./ListingQualityNotice";
import type { AuctionSale } from "@/lib/types";
afterEach(cleanup);
it("shows pending analysis and uncertainty without inventing a source check", () => {
  render(
    <ListingQualityNotice
      sale={
        {
          documents: [],
          analysis_status: "pending",
          source_conflicts: [
            {
              field: "carrez_surface_m2",
              selected: "40",
              alternative: "60",
              alternative_source: "https://example.test/document.pdf",
            },
          ],
        } as unknown as AuctionSale
      }
    />,
  );
  expect(screen.getByText(/Dernière vérification.*non établie/)).toBeTruthy();
  expect(screen.getByText(/Analyse en cours/)).toBeTruthy();
  expect(screen.getByText(/surface Carrez : 40 \/ 60/)).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.test/document.pdf");
});
it("shows the actual verification timestamp and rejects unsafe provenance links", () => {
  render(
    <ListingQualityNotice
      sale={
        {
          documents: [],
          analysis_status: "complete",
          source_checks: { source: { checked_at: "2026-09-12T10:00:00Z" } },
          source_conflicts: [{ field: "sale_date", alternative_source: "javascript:alert(1)" }],
        } as unknown as AuctionSale
      }
    />,
  );
  expect(screen.getByText(/12\/09\/2026/)).toBeTruthy();
  expect(screen.queryByText(/Analyse en cours/)).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
