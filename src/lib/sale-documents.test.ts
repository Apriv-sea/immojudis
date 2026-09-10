import { describe, expect, it, vi } from "vitest";
import { collectSaleDocuments } from "./sale-documents";
import { EXAMPLE_SALE } from "./example-sale";
const mocks = vi.hoisted(() => ({ sources: [] as Array<Record<string, unknown>> }));
vi.mock("./sale-procedure", () => ({ getSaleProcedure: () => ({ sources: mocks.sources }) }));

describe("case document inventory", () => {
  it("merges linked case documents and excludes regulatory or unusable references", () => {
    mocks.sources = [
      {
        kind: "document",
        url: "https://example.test/ccv.pdf",
        label: "CCV du 19.11.2025.pdf",
        document_type: "pdf",
      },
      { kind: "document", url: "https://example.test/pv.pdf", label: "PV descriptif.pdf" },
      { kind: "legal_basis", url: "https://example.test/law", label: "Code" },
      { kind: "document", url: "javascript:alert(1)", label: "Diagnostics" },
      { kind: "document", label: "Plan cadastral sans lien" },
    ];
    const result = collectSaleDocuments({
      ...EXAMPLE_SALE,
      documents_rich: [],
      documents: [{ url: "https://example.test/pv.pdf", name: "PV descriptif.pdf" }],
    });
    expect(result).toHaveLength(2);
    expect(result.find((d) => d.url.endsWith("ccv.pdf"))).toMatchObject({
      type: "cahier_conditions",
      label: "CCV du 19.11.2025.pdf",
      extraction_status: null,
    });
    expect(result.filter((d) => d.url.endsWith("pv.pdf"))).toHaveLength(1);
  });
  it("preserves extraction metadata when a case reference duplicates an enriched document", () => {
    mocks.sources = [
      { kind: "document", url: "https://example.test/pv.pdf", label: "PV descriptif.pdf" },
    ];
    const result = collectSaleDocuments({
      ...EXAMPLE_SALE,
      documents: [],
      documents_rich: [
        {
          url: "https://example.test/pv.pdf",
          label: null,
          type: "pdf",
          extraction_status: "downloaded",
          text_chars: 5000,
        },
      ],
    });
    expect(result).toEqual([
      expect.objectContaining({
        label: "PV descriptif.pdf",
        extraction_status: "downloaded",
        text_chars: 5000,
      }),
    ]);
  });
});
