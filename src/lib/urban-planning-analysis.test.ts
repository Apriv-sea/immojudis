import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildUrbanPlanningAnalysis } from "@/lib/urban-planning-analysis";
import type { SaleDocumentRich, SaleRisk } from "@/lib/types";

describe("urban planning analysis", () => {
  it("does not treat generated instructions or unrelated page content as planning evidence", () => {
    const result = buildUrbanPlanningAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        source_description: "Appartement avec balcon.",
        llm_display_description: "Servitudes et permis à vérifier.",
        about_description: "Zonage PLU à vérifier.",
        investment_summary: "Urbanisme à vérifier.",
        source_blocks: {
          page_text: "Autre annonce : servitude de passage",
          sale_procedure: { note: "Vérifier les permis" },
        },
        source_blocks_by_source: null,
      },
      documents: [],
      risks: [],
    });
    expect(result.status).toBe("missing");
    expect(result.items).toEqual([]);
    expect(result.confidence).toBe("low");
  });

  it("detects zoning and permit signals from source data and dossier documents", () => {
    const documents: SaleDocumentRich[] = [
      {
        url: "/permis.pdf",
        label: "Permis de construire et conformité des travaux",
        type: "permis_construire",
        document_type: "permis_construire",
        extraction_status: "downloaded",
      },
    ];

    const analysis = buildUrbanPlanningAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        source_blocks: {
          plu: "Zone urbaine constructible avec droit de préemption à vérifier.",
          usage: "Habitation",
        },
        source_blocks_by_source: null,
      },
      documents,
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "source_signals",
      confidence: "low",
    });
    expect(analysis.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "zoning", label: "Urbanisme / PLU" }),
        expect.objectContaining({
          kind: "permit",
          status: "to_verify",
          source: "Pièces du dossier",
        }),
      ]),
    );
    expect(analysis.summary).toContain("Urbanisme / PLU");
  });

  it("raises servitude risks as high-priority checks", () => {
    const risks: SaleRisk[] = [
      {
        risk_type: "servitude_access",
        risk_label: "Servitude de passage à qualifier",
        severity: 3,
        evidence: "Le cahier des conditions mentionne une servitude de passage.",
        occurrences: [
          {
            document_url: "/cahier.pdf",
            document_label: "Cahier des conditions",
            document_type: "cahier_conditions_vente",
            page_number: 11,
            excerpt: "Droit de passage et servitude d'accès à confirmer.",
            confidence: 0.86,
          },
        ],
      },
    ];

    const analysis = buildUrbanPlanningAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        description: "Maison avec cour.",
        source_blocks: null,
        source_blocks_by_source: null,
      },
      documents: [],
      risks,
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "source_signals",
      confidenceLabel: "Signaux urbanisme à confirmer",
    });
    expect(analysis.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "servitude",
          priority: "high",
          source: "Preuves de risques",
        }),
      ]),
    );
    expect(analysis.nextActions[0]).toBe(
      "Qualifier l'impact sur l'accès, l'usage, les travaux et la revente.",
    );
  });

  it("prioritizes structured urban planning signals when available", () => {
    const analysis = buildUrbanPlanningAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        description: "Maison avec cour.",
        source_blocks: null,
        source_blocks_by_source: null,
      },
      documents: [],
      risks: [],
      structuredSignals: [
        {
          signalKey: "permit_123",
          signalKind: "permit",
          label: "Permis et autorisations",
          status: "documented",
          priority: "medium",
          sourceName: "Cahier des conditions",
          sourceKind: "pdf",
          documentUrl: "/cahier.pdf",
          documentLabel: "Cahier des conditions",
          documentType: "cahier_conditions_vente",
          pageNumber: 14,
          excerpt: "Autorisation de travaux et conformité à vérifier avant enchère.",
          action: "Vérifier les autorisations, déclarations préalables et conformité des travaux.",
          confidence: 0.88,
        },
      ],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "documented",
    });
    expect(analysis.items[0]).toMatchObject({
      key: "structured_permit_123",
      kind: "permit",
      status: "documented",
      source: "Cahier des conditions · page 14",
    });
  });

  it("keeps missing planning data explicit when no signal is present", () => {
    const analysis = buildUrbanPlanningAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        description: "Appartement T2 avec balcon.",
        source_description: null,
        llm_display_description: null,
        about_description: null,
        investment_summary: null,
        risk_notes: null,
        score_factors: [],
        source_blocks: null,
        source_blocks_by_source: null,
      },
      documents: [],
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: false,
      status: "missing",
      confidence: "low",
      items: [],
    });
    expect(analysis.missingChecks).toEqual(
      expect.arrayContaining([
        "Zonage PLU ou règles locales",
        "Permis, autorisations ou conformité des travaux",
        "Servitudes, accès et droits de passage",
        "Règlement de copropriété, charges et travaux votés",
      ]),
    );
    expect(analysis.summary).toBe(
      "Urbanisme, permis, servitudes et copropriété à vérifier dans les pièces.",
    );
  });
});
