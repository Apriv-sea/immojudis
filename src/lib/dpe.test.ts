import { describe, expect, it } from "vitest";
import { dpeClassFromText, dpeMatches, extractDpe, normalizeDpeClass } from "@/lib/dpe";

describe("DPE helpers", () => {
  it.each([
    "Appartement à Toulouse, bâtiment A. Diagnostics techniques disponibles.",
    "DPE à confirmer",
    "DPE a confirmer",
    "DPE A CONFIRMER",
    "Diagnostic électrique : anomalie B.",
  ])("does not invent a rating from %s", (text) => {
    expect(normalizeDpeClass(text)).toBeNull();
    expect(dpeClassFromText(text)).toBeNull();
  });
  it("extracts explicit prose ratings and refuses conflicting ratings", () => {
    expect(dpeClassFromText("Appartement : DPE F, GES C.")).toBe("F");
    expect(dpeClassFromText("Classe énergétique : E. Diagnostic disponible.")).toBe("E");
    expect(dpeClassFromText("DPE F. Autre diagnostic : DPE C.")).toBeNull();
  });
  it("normalizes valid energy classes", () => {
    expect(normalizeDpeClass("a")).toBe("A");
    expect(normalizeDpeClass("DPE C")).toBe("C");
    expect(normalizeDpeClass("Z")).toBeNull();
  });

  it("extracts DPE class from source blocks first", () => {
    expect(
      extractDpe({
        source_blocks: { dpe_classe: "e" },
        documents_rich: [],
      }).class,
    ).toBe("E");
  });

  it("uses structured ADEME diagnostics before source blocks", () => {
    const dpe = extractDpe(
      {
        source_blocks: { dpe_classe: "E" },
        documents_rich: [],
      },
      [
        {
          diagnosticNumber: "2133E0178774F",
          dpeClass: "C",
          gesClass: "B",
          establishedAt: "2025-05-10",
          validUntil: "2035-05-09",
          propertyType: "maison",
          address: "10 Rue Exemple 33000 Bordeaux",
          city: "Bordeaux",
          postalCode: "33000",
          inseeCode: "33063",
          department: "33",
          surfaceM2: 82.4,
          energyConsumptionKwhM2Year: 142,
          emissionsKgCo2M2Year: 18,
          latitude: 44.8378,
          longitude: -0.5792,
          matchKind: "geo_distance",
          confidence: 0.91,
          sourceApi: "ADEME DPE Open Data",
        },
      ],
    );

    expect(dpe).toMatchObject({
      class: "C",
      source: "ademe",
      diagnostic: {
        diagnosticNumber: "2133E0178774F",
        gesClass: "B",
      },
    });
  });

  it("supports class filters", () => {
    expect(dpeMatches("B", ["A", "B"])).toBe(true);
    expect(dpeMatches("F", ["A", "B"])).toBe(false);
    expect(dpeMatches(null, ["A"])).toBe(false);
    expect(dpeMatches(null, [])).toBe(true);
  });
});
