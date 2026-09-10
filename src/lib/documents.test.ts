import { describe, expect, it } from "vitest";
import { isEmbeddableDocumentUrl, parseDocs, safeDocumentUrl } from "@/lib/documents";

describe("document URL safety", () => {
  it("preserves the source label as the display name when no name field is supplied", () => {
    expect(
      parseDocs([
        { url: "https://example.test/opaque-id.pdf", label: "Plan cadastral.pdf", type: "pdf" },
      ])[0],
    ).toMatchObject({ name: "Plan cadastral.pdf" });
  });
  it("keeps HTTP(S) documents and rejects active or credentialed URLs", () => {
    expect(
      parseDocs([
        "https://example.test/document.pdf",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "https://user:password@example.test/private.pdf",
      ]),
    ).toEqual([{ url: "https://example.test/document.pdf" }]);
  });

  it("only embeds safe supported document formats", () => {
    expect(isEmbeddableDocumentUrl("https://example.test/document.pdf?version=1")).toBe(true);
    expect(isEmbeddableDocumentUrl("https://example.test/document.html")).toBe(false);
    expect(isEmbeddableDocumentUrl("javascript:alert(1).pdf")).toBe(false);
  });

  it("normalizes absolute document URLs", () => {
    expect(safeDocumentUrl("  https://example.test/a b.pdf  ")).toBe(
      "https://example.test/a%20b.pdf",
    );
  });
});
