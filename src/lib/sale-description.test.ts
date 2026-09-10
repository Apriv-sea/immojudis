import { describe, expect, it } from "vitest";
import {
  buildStructuredDescription,
  getSaleAiDescription,
  getSaleDisplayDescription,
  hasSaleAiDescription,
} from "./sale-description";
import type { AuctionSale } from "./types";

function sale(overrides: Partial<AuctionSale>): AuctionSale {
  return overrides as AuctionSale;
}

describe("sale AI display description", () => {
  it("uses the LLM display description when available", () => {
    const item = sale({
      llm_display_description: "Synthèse IA prête.",
      about_description: "Description brute héritée.",
      source_description: "Texte source brut.",
      description: "Description collectée brute.",
    });

    expect(getSaleAiDescription(item)).toBe("Synthèse IA prête.");
    expect(getSaleDisplayDescription(item)).toBe("Synthèse IA prête.");
    expect(hasSaleAiDescription(item)).toBe(true);
  });

  it("falls back to the about description when the LLM display description is missing", () => {
    const item = sale({
      llm_display_description: null,
      about_description: "Description synthétique disponible.",
      source_description: "Texte source brut.",
      description: "Description collectée brute.",
    });

    expect(getSaleAiDescription(item)).toBeNull();
    expect(getSaleDisplayDescription(item)).toBe("Description synthétique disponible.");
    expect(hasSaleAiDescription(item)).toBe(false);
  });

  it("uses source descriptions before generating a structured fallback", () => {
    const item = sale({
      llm_display_description: null,
      about_description: null,
      source_description: "Texte source exploitable.",
      description: "Description collectée brute.",
    });

    expect(getSaleDisplayDescription(item)).toBe("Texte source exploitable.");
  });

  it("generates a factual fallback instead of showing a pending message", () => {
    const item = sale({
      llm_display_description: null,
      about_description: null,
      source_description: null,
      description: null,
      city: "Bordeaux",
      department: "33",
      tribunal_name: "TJ Bordeaux",
      property_type: "apartment",
      starting_price_eur: 92_000,
      sale_date: "2026-10-15T09:30:00+02:00",
      app_surface_m2: 42.6,
      rooms_count: 2,
      occupancy_status: "unknown",
    });

    expect(getSaleDisplayDescription(item)).toContain("Ce bien situé à Bordeaux, 33");
    expect(getSaleDisplayDescription(item)).toContain("92");
    expect(getSaleDisplayDescription(item)).not.toContain("Synthèse IA en cours");
  });

  it("does not invent a judicial hearing for notarial or unknown sales", () => {
    const result = getSaleDisplayDescription(
      sale({ sale_venue_type: "notary", sale_date: null, starting_price_eur: null }),
    );
    expect(result).toContain("Vente notariale");
    expect(result).toContain("La date de vente reste à confirmer");
    expect(result).not.toContain("audience");
    expect(result).not.toContain("vente judiciaire");
    expect(result).not.toContain("le Date à confirmer");
  });
});

describe("structured sale status", () => {
  it.each(["cancelled", "canceled", "postponed"])(
    "does not confirm a stored appointment for %s",
    (status) => {
      const text = buildStructuredDescription(
        sale({ status, sale_date: "2026-10-15T09:30:00+02:00" }),
        new Date("2026-09-10T10:00:00Z"),
      );
      expect(text).not.toContain("La vente est prévue");
      expect(text).not.toContain("est proposé à la vente");
      expect(text).toContain(status === "postponed" ? "Vente reportée" : "Vente annulée");
      expect(text).toContain("ne vaut pas rendez-vous confirmé");
    },
  );
  it("identifies a past date without inferring an adjudication", () => {
    const text = buildStructuredDescription(
      sale({ sale_date: "2026-09-07T12:00:00Z" }),
      new Date("2026-09-10T10:00:00Z"),
    );
    expect(text).toContain("Date de vente passée · résultat à confirmer");
    expect(text).toContain("Date annoncée dans le dossier");
    expect(text).not.toContain("La vente est prévue");
  });
  it("preserves the upcoming date for an active sale", () => {
    const text = buildStructuredDescription(
      sale({ sale_date: "2026-10-15T09:30:00+02:00" }),
      new Date("2026-09-10T10:00:00Z"),
    );
    expect(text).toContain("La vente est prévue le 15 octobre 2026");
  });
});

it("does not call the inherited surface of a commercial building habitable", () => {
  const text = buildStructuredDescription(
    sale({
      property_type: "commercial",
      habitable_surface_m2: 1335,
      source_description: "Bâtiment d’une surface totale de 1 335 m².",
    }),
  );
  expect(text).toContain("surface renseignée");
  expect(text).not.toContain("surface habitable");
});
