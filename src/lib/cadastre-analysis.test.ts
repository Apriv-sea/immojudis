import { describe, expect, it } from "vitest";
import { buildCadastralAnalysis, formatCadastralReference } from "@/lib/cadastre-analysis";
import { EXAMPLE_SALE } from "@/lib/example-sale";

describe("cadastral analysis", () => {
  it("preserves the prefixed cadastral reference in the real Toulouse source wording", () => {
    const analysis = buildCadastralAnalysis({
      ...EXAMPLE_SALE,
      source_description:
        "Résidence cadastrée Section 844 AN n°112, pour une contenance de 44a 34ca. Tél 05.61.52.36.83.",
      description: null,
      source_blocks: null,
      source_blocks_by_source: null,
      risks: [],
    });
    expect(analysis.references).toEqual([
      expect.objectContaining({
        prefix: "844",
        section: "AN",
        number: "112",
        confidence: "inferred",
      }),
    ]);
    expect(formatCadastralReference(analysis.references[0])).toBe("Section 844 AN n° 112");
  });

  it("does not turn phone numbers, dates or apartment types into parcel references", () => {
    const analysis = buildCadastralAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: {
        page_text:
          "Plan cadastral disponible. Tél 05.61.52.36.83. Audience le 10 septembre. Appartement T5. Les 216 lots.",
      },
      source_blocks_by_source: null,
      description: null,
      source_description: null,
      risks: [],
      documents_rich: [],
      land_surface_m2: null,
    });
    expect(analysis.references).toEqual([]);
    expect(analysis.status).toBe("missing");
  });

  it("keeps a real explicit section without collecting unrelated numbers from the same page", () => {
    const analysis = buildCadastralAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: {
        page_text:
          "Tél 05.61.52.36.83, vente le 10. Parcelle cadastrée section AN n° 112. Appartement T5, 216 lots.",
      },
      source_blocks_by_source: null,
      description: null,
      source_description: null,
      risks: [],
    });
    expect(analysis.references).toEqual([
      expect.objectContaining({ section: "AN", number: "112", confidence: "inferred" }),
    ]);
    expect(analysis.confidence).toBe("medium");
  });

  it("does not combine section and number from separate source records", () => {
    const analysis = buildCadastralAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: { first: { cadastral_section: "AB" }, second: { numero_parcelle: "42" } },
      source_blocks_by_source: null,
      description: null,
      source_description: null,
      risks: [],
    });
    expect(analysis.references).toEqual([]);
  });

  it("accepts a compact reference only in a dedicated cadastral field", () => {
    const analysis = buildCadastralAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: { cadastre: "AB 42", terrain: "T5" },
      source_blocks_by_source: null,
      description: null,
      source_description: null,
      risks: [],
    });
    expect(analysis.references).toEqual([
      expect.objectContaining({ section: "AB", number: "42", confidence: "direct" }),
    ]);
  });

  it("does not use generated descriptions as cadastral evidence", () => {
    const analysis = buildCadastralAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: null,
      source_blocks_by_source: null,
      description: null,
      source_description: null,
      llm_display_description: "Section ZZ n° 999",
      about_description: "Section ZZ n° 999",
      risks: [],
    });
    expect(analysis.references).toEqual([]);
  });

  it("uses API Carto structured parcels before text-only cadastral signals", () => {
    const analysis = buildCadastralAnalysis(
      {
        ...EXAMPLE_SALE,
        description: "Maison vendue avec références cadastrales à confirmer.",
        source_blocks: null,
        land_surface_m2: null,
      },
      [
        {
          parcelKey: "33063-AB-0123",
          parcelId: "33063000AB0123",
          codeInsee: "33063",
          department: "33",
          city: "Bordeaux",
          section: "AB",
          parcelNumber: "0123",
          surfaceM2: 480,
          centroidLat: 44.8378,
          centroidLng: -0.5792,
          matchKind: "point_intersection",
          confidence: 0.88,
          sourceApi: "API Carto Cadastre",
        },
      ],
    );

    expect(analysis).toMatchObject({
      available: true,
      status: "identified",
      confidence: "high",
      confidenceLabel: "Parcelle API Carto rattachée",
      landSurfaceM2: 480,
      structuredParcels: [
        {
          parcelKey: "33063-AB-0123",
          section: "AB",
          parcelNumber: "0123",
          surfaceM2: 480,
        },
      ],
      references: [
        {
          section: "AB",
          number: "0123",
          confidence: "structured",
        },
      ],
    });
    expect(analysis.sources).toContain("API Carto Cadastre");
    expect(analysis.limitations.join(" ")).toContain("API Carto");
  });

  it("uses structured source blocks as high-confidence cadastral references", () => {
    const analysis = buildCadastralAnalysis({
      ...EXAMPLE_SALE,
      land_surface_m2: 480,
      source_blocks: {
        cadastral_section: "AB",
        numero_parcelle: "123",
      },
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "identified",
      confidence: "high",
      landSurfaceM2: 480,
      references: [
        {
          section: "AB",
          number: "123",
          confidence: "direct",
        },
      ],
    });
    expect(analysis.summary).toContain("Section AB");
    expect(analysis.nextActions).toEqual(
      expect.arrayContaining([
        "Vérifier la concordance section/numéro avec le plan cadastral et le cahier des conditions de vente.",
      ]),
    );
  });

  it("extracts cadastral references from source text when the wording is explicit", () => {
    const analysis = buildCadastralAnalysis({
      ...EXAMPLE_SALE,
      source_description:
        "Maison édifiée sur une parcelle cadastrée section ZK n° 42, avec cour et dépendance.",
      source_blocks: null,
    });

    expect(analysis.status).toBe("identified");
    expect(analysis.confidence).toBe("medium");
    expect(analysis.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          section: "ZK",
          number: "42",
          confidence: "inferred",
        }),
      ]),
    );
  });

  it("marks cadastral documents as available even before a section number is extracted", () => {
    const analysis = buildCadastralAnalysis({
      ...EXAMPLE_SALE,
      source_blocks: null,
      documents_rich: [
        {
          url: "/plan-cadastre.pdf",
          label: "Plan cadastral annexé",
          type: "cadastre",
          document_type: "cadastre",
          extraction_status: "downloaded",
        },
      ],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "document_referenced",
      confidenceLabel: "Pièce cadastrale repérée",
      documents: [{ label: "Plan cadastral annexé", type: "cadastre", url: "/plan-cadastre.pdf" }],
    });
    expect(analysis.nextActions[0]).toBe(
      "Extraire la section et le numéro de parcelle depuis la pièce cadastrale repérée.",
    );
  });

  it("keeps the analysis explicit when no cadastral signal is present", () => {
    const analysis = buildCadastralAnalysis({
      ...EXAMPLE_SALE,
      description: "Appartement T2 avec balcon.",
      source_blocks: null,
      documents_rich: [],
      land_surface_m2: null,
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: false,
      status: "missing",
      confidence: "low",
      references: [],
      documents: [],
    });
    expect(analysis.summary).toBe("Parcelle cadastrale à connecter ou à confirmer.");
  });
});
