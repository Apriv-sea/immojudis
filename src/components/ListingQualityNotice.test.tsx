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
it("exposes legacy critical reservations even without structured conflicts", () => {
  render(
    <ListingQualityNotice
      sale={
        {
          quality_flags: ["ambiguous_surface", "occupation_conflict", "tribunal_inconsistent"],
          documents: [],
        } as unknown as AuctionSale
      }
    />,
  );
  expect(screen.getByText(/Surfaces à confirmer/)).toBeTruthy();
  expect(screen.getByText(/Occupation à confirmer/)).toBeTruthy();
  expect(screen.getByText(/Tribunal à confirmer/)).toBeTruthy();
});
it("shows the source detail verification reservation when flagged", () => {
  render(
    <ListingQualityNotice
      sale={
        {
          documents: [],
          quality_flags: ["source_detail_unverified"],
        } as unknown as AuctionSale
      }
    />,
  );
  expect(
    screen.getByText(
      "La dernière fiche source n’a pas pu être vérifiée. Les informations sont à confirmer.",
    ),
  ).toBeTruthy();
});
it("does not show the source detail verification reservation without its flag", () => {
  render(
    <ListingQualityNotice
      sale={
        {
          documents: [],
          quality_flags: [],
        } as unknown as AuctionSale
      }
    />,
  );
  expect(screen.queryByText(/dernière fiche source n’a pas pu être vérifiée/)).toBeNull();
});
