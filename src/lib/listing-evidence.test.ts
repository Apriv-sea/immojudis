import { describe, expect, it } from "vitest";
import {
  listingOccupation,
  listingContactEmail,
  listingValuationConflict,
  listingSaleStatus,
  publishedDay,
  saleTimeConflict,
  visitHasPassed,
} from "./listing-evidence";
import { listingVisits } from "./sale-listing";
import type { AuctionSale } from "./types";
const sale = (input: Partial<AuctionSale>) => input as AuctionSale;
const now = new Date("2026-09-09T12:00:00Z");

describe("listing evidence and chronology", () => {
  it("does not turn an unoccupied but cluttered shop into a free property", () => {
    expect(
      listingOccupation(
        sale({
          occupancy_status: "vacant",
          source_description: "MAGASIN 2P - inoccupé mais encombré de divers objets et deux roues",
        }),
      ),
    ).toBe("Inoccupé selon l’annonce");
  });
  it("blocks valuation of a parcel when the detailed source title describes an apartment", () => {
    expect(
      listingValuationConflict(
        sale({
          property_type: "land",
          source_blocks: { titre_detail: "Appartement T5 avec terrasse et garage" },
        }),
      ),
    ).toContain("Type de bien contradictoire");
    expect(
      listingValuationConflict(
        sale({
          property_type: "land",
          source_blocks: { titre_detail: "Terrain près d’une maison" },
        }),
      ),
    ).toBeNull();
  });
  it("uses the Paris calendar day for zoned timestamps near midnight", () => {
    expect(publishedDay("2026-09-09T23:30:00Z")).toBe("2026-09-10");
    expect(visitHasPassed("2026-09-09T23:30:00Z", new Date("2026-09-10T06:00:00Z"))).toBe(false);
  });
  it("suggests a unique contact without choosing between multiple source recipients", () => {
    expect(
      listingContactEmail(
        sale({
          lawyer_contact: "Cabinet <CONTACT@example.fr>",
          source_description: "autre@example.fr",
        }),
      ),
    ).toBe("contact@example.fr");
    expect(
      listingContactEmail(
        sale({ source_description: "Cabinet contact@example.fr. Email : contact@example.fr" }),
      ),
    ).toBe("contact@example.fr");
    expect(
      listingContactEmail(sale({ source_description: "contact@example.fr ou autre@example.fr" })),
    ).toBe("");
    expect(
      listingContactEmail(
        sale({ lawyer_contact: "a@example.fr b@example.fr", source_description: "c@example.fr" }),
      ),
    ).toBe("");
  });
  it("marks only complete valid past dates, keeping today's visit current", () => {
    expect(visitHasPassed("Jeudi 3 septembre 2026 à 11 h 00", now)).toBe(true);
    expect(visitHasPassed("9 septembre 2026 à 10h", now)).toBe(false);
    expect(visitHasPassed("Jeudi à 11h", now)).toBe(false);
    expect(publishedDay("31 février 2026")).toBeNull();
  });
  it("recovers the published visit when the visit field contains only an organizer", () => {
    const visits = listingVisits(
      sale({
        visit_dates: ["SAS MAS LABORIE"],
        source_description:
          "Visite le: Jeudi 3 septembre 2026 à 11 h 00. Renseignements au cabinet.",
      }),
    );
    expect(visits[0]).toContain("3 septembre 2026");
    expect(visits).toContain("SAS MAS LABORIE");
  });
  it("does not replace a dated structured visit with a potentially older source excerpt", () => {
    const visits = listingVisits(
      sale({
        visit_dates: ["2026-09-10 à 11:00"],
        source_description: "Visite le 3 septembre 2026 à 11h00.",
      }),
    );
    expect(visits).toEqual(["10 septembre 2026 · 11:00"]);
  });
  it("flags the observed two-hour discrepancy without rewriting a sale date", () => {
    const input = sale({
      sale_date: "2026-09-15T11:00:00+00:00",
      source_description: "Adjudication le 15 septembre 2026 à 11h00",
    });
    expect(saleTimeConflict(input)).toContain("horaire contradictoire");
    expect(saleTimeConflict({ ...input, sale_date: "2026-09-15T09:00:00Z" })).toBeNull();
    expect(input.sale_date).toBe("2026-09-15T11:00:00+00:00");
  });
  it("distinguishes a historical vacancy observation from current availability", () => {
    expect(
      listingOccupation(
        sale({
          occupancy_status: "vacant",
          source_description: "Inoccupé lors du PV descriptif bien que meublé.",
        }),
      ),
    ).toBe("Inoccupé au constat");
    expect(listingOccupation(sale({ occupancy_status: "vacant" }))).toBe("Libre selon l’annonce");
    expect(listingOccupation(sale({ occupancy_status: "unknown" }))).toBe("À confirmer");
  });
  it("does not infer an adjudication from an elapsed date, and respects cancellation", () => {
    expect(listingSaleStatus(sale({ sale_date: "2026-09-01", status: "upcoming" }), now)).toBe(
      "Date de vente passée · résultat à confirmer",
    );
    expect(listingSaleStatus(sale({ sale_date: "2026-09-01", status: "cancelled" }), now)).toBe(
      "Vente annulée",
    );
    expect(
      listingSaleStatus(sale({ sale_date: "2026-09-10", status: "upcoming" }), now),
    ).toBeNull();
  });
});
