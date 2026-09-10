import { describe, expect, it } from "vitest";
import { createTextPdf, paginatePdfLines } from "@/lib/simple-pdf";

describe("createTextPdf", () => {
  it("moves a heading with its following paragraph instead of leaving it at the page foot", () => {
    const paragraph = "- " + "Une action à vérifier dans les pièces. ".repeat(5);
    const pages = paginatePdfLines(
      [...Array.from({ length: 41 }, (_, i) => `Repère ${i}`), "Actions", paragraph],
      ["Actions"],
    );
    expect(pages[0]).toHaveLength(41);
    expect(pages[1][0]).toEqual({ text: "Actions", heading: true });
    expect(
      pages[1]
        .slice(1)
        .map((line) => line.text)
        .join(" "),
    ).toContain("Une action à vérifier");
    expect(pages).toHaveLength(2);
  });

  it("keeps a wrapped bullet together when it fits on a fresh page", () => {
    const pages = paginatePdfLines([
      ...Array.from({ length: 41 }, () => "Repère"),
      "- " + "Document à relire. ".repeat(12),
    ]);
    expect(pages[0]).toHaveLength(41);
    expect(pages[1][0].text).toMatch(/^- /);
    expect(pages[1].length).toBeGreaterThan(1);
  });

  it("splits oversized paragraphs without dropping text or exceeding page capacity", () => {
    const source = "Une ligne longue. ".repeat(500);
    const pages = paginatePdfLines(["Actions", source], ["Actions"]);
    expect(pages[0][0].heading).toBe(true);
    expect(pages[0].length).toBeGreaterThan(1);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 42)).toBe(true);
    expect(
      pages
        .flat()
        .filter((line) => !line.heading)
        .map((line) => line.text)
        .join("")
        .replace(/\s/g, ""),
    ).toBe(source.replace(/\s/g, ""));
  });

  it("encodes French characters and units as WinAnsi without corrupting PDF offsets", () => {
    const text = new TextDecoder().decode(
      createTextPdf({
        title: "Évry — 58 m²",
        lines: ["3 022 €/m² ; volume 140 m³", "Œuvre à vérifier : e\u0301tage"],
      }),
    );
    expect(text).toContain("/Encoding /WinAnsiEncoding");
    expect(text).toContain("\\311vry \\227 58 m\\262");
    expect(text).toContain("3 022 \\200/m\\262 ; volume 140 m\\263");
    expect(text).toContain("\\214uvre \\340 v\\351rifier : \\351tage");
    expect([...text].every((character) => character.charCodeAt(0) < 128)).toBe(true);
    const xref = Number(text.match(/startxref\n(\d+)/)?.[1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
  });
  it("embeds a sanitized watermark when provided", () => {
    const pdf = createTextPdf({
      title: "Rapport test",
      lines: ["Ligne de rapport"],
      watermark: "VERSION DÉCOUVERTE — EXTRAIT LIMITÉ",
    });

    const text = new TextDecoder().decode(pdf);

    expect(text).toContain("%PDF-1.4");
    expect(text).toContain("VERSION D\\311COUVERTE \\227 EXTRAIT LIMIT\\311");
    expect(text).toContain("0.707 0.707 -0.707 0.707");
  });
});
