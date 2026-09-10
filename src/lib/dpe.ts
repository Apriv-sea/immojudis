import type { AuctionSale } from "@/lib/types";

export const DPE_CLASSES = ["A", "B", "C", "D", "E", "F", "G"] as const;

export type DpeClass = (typeof DPE_CLASSES)[number];

export type DpeSummary = {
  class: DpeClass | null;
  label: string | null;
  source: DpeSource | null;
  diagnostic: StructuredDpeDiagnostic | null;
};

export type DpeSource = "ademe" | "source_blocks" | "documents";

export type StructuredDpeDiagnostic = {
  diagnosticNumber: string | null;
  dpeClass: DpeClass | null;
  gesClass: DpeClass | null;
  establishedAt: string | null;
  validUntil: string | null;
  propertyType: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  inseeCode: string | null;
  department: string | null;
  surfaceM2: number | null;
  energyConsumptionKwhM2Year: number | null;
  emissionsKgCo2M2Year: number | null;
  latitude: number | null;
  longitude: number | null;
  matchKind: string | null;
  confidence: number | null;
  sourceApi: string | null;
};

const DPE_COLORS: Record<DpeClass, { background: string; foreground: string; border: string }> = {
  A: { background: "#0f766e", foreground: "#ffffff", border: "#0f766e" },
  B: { background: "#22c55e", foreground: "#052e16", border: "#16a34a" },
  C: { background: "#a3e635", foreground: "#1a2e05", border: "#84cc16" },
  D: { background: "#fde047", foreground: "#422006", border: "#eab308" },
  E: { background: "#fb923c", foreground: "#431407", border: "#f97316" },
  F: { background: "#ef4444", foreground: "#ffffff", border: "#dc2626" },
  G: { background: "#7f1d1d", foreground: "#ffffff", border: "#7f1d1d" },
};

export function extractDpe(
  sale: Pick<AuctionSale, "source_blocks" | "documents_rich">,
  diagnostics: StructuredDpeDiagnostic[] = [],
): DpeSummary {
  const structured = bestStructuredDpe(diagnostics);
  if (structured?.dpeClass) {
    return {
      class: structured.dpeClass,
      label: `DPE ${structured.dpeClass}`,
      source: "ademe",
      diagnostic: structured,
    };
  }

  const fromBlocks = dpeFromSourceBlocks(sale.source_blocks);
  if (fromBlocks) {
    return {
      class: fromBlocks,
      label: `DPE ${fromBlocks}`,
      source: "source_blocks",
      diagnostic: null,
    };
  }

  const fromDocuments = sale.documents_rich?.some((document) =>
    /dpe|diagnostic/i.test(`${document.type ?? ""} ${document.label ?? ""}`),
  );

  return {
    class: null,
    label: fromDocuments ? "DPE à lire" : null,
    source: fromDocuments ? "documents" : null,
    diagnostic: null,
  };
}

export function normalizeStructuredDpeDiagnostics(
  diagnostics: StructuredDpeDiagnostic[],
): StructuredDpeDiagnostic[] {
  return diagnostics
    .map((diagnostic) => ({
      diagnosticNumber: cleanText(diagnostic.diagnosticNumber),
      dpeClass: normalizeDpeClass(diagnostic.dpeClass),
      gesClass: normalizeDpeClass(diagnostic.gesClass),
      establishedAt: cleanText(diagnostic.establishedAt),
      validUntil: cleanText(diagnostic.validUntil),
      propertyType: cleanText(diagnostic.propertyType),
      address: cleanText(diagnostic.address),
      city: cleanText(diagnostic.city),
      postalCode: cleanText(diagnostic.postalCode),
      inseeCode: cleanText(diagnostic.inseeCode),
      department: cleanText(diagnostic.department),
      surfaceM2: positiveNumber(diagnostic.surfaceM2),
      energyConsumptionKwhM2Year: positiveNumber(diagnostic.energyConsumptionKwhM2Year),
      emissionsKgCo2M2Year: positiveNumber(diagnostic.emissionsKgCo2M2Year),
      latitude: finiteNumber(diagnostic.latitude),
      longitude: finiteNumber(diagnostic.longitude),
      matchKind: cleanText(diagnostic.matchKind),
      confidence: finiteNumber(diagnostic.confidence),
      sourceApi: cleanText(diagnostic.sourceApi) ?? "ADEME DPE Open Data",
    }))
    .filter((diagnostic) => diagnostic.diagnosticNumber || diagnostic.dpeClass)
    .sort((first, second) => {
      const confidence = (second.confidence ?? 0) - (first.confidence ?? 0);
      if (confidence !== 0) return confidence;
      return String(second.establishedAt ?? "").localeCompare(String(first.establishedAt ?? ""));
    })
    .slice(0, 8);
}

function bestStructuredDpe(diagnostics: StructuredDpeDiagnostic[]) {
  return normalizeStructuredDpeDiagnostics(diagnostics).find((diagnostic) => diagnostic.dpeClass);
}

export function dpeColor(value: DpeClass | null | undefined) {
  return value ? DPE_COLORS[value] : null;
}

export function dpeMatches(value: DpeClass | null, accepted: string[] | undefined): boolean {
  if (!accepted?.length) return true;
  return value != null && accepted.includes(value);
}

export function normalizeDpeClass(value: unknown): DpeClass | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim().toUpperCase();
  const normalized =
    text.match(
      /^(?:(?:DPE|GES|CLASSE(?: ÉNERGIE| ENERGIE| ÉNERGÉTIQUE| ENERGETIQUE)?)\s*[:=-]?\s*)?([A-G])$/,
    )?.[1] ?? "";
  return DPE_CLASSES.includes(normalized as DpeClass) ? (normalized as DpeClass) : null;
}

/** A letter in prose is evidence only when explicitly attached to an energy rating. */
export function dpeClassFromText(value: string): DpeClass | null {
  const classes = new Set<DpeClass>();
  const pattern =
    /\b(?:DPE|classe\s+(?:énergie|energie|énergétique|energetique))\s*[:=-]?\s*(?:classe\s+)?([A-G])(?=$|[\s,;.()])/giu;
  for (const match of value.matchAll(pattern)) {
    // Lowercase "a" in "DPE a confirmer" is not a rating.
    if (match[1] !== match[1].toUpperCase()) continue;
    if (
      /^\s+(?:confirmer|vérifier|verifier|rechercher|lire)\b/i.test(
        value.slice(match.index + match[0].length),
      )
    )
      continue;
    classes.add(match[1] as DpeClass);
  }
  return classes.size === 1 ? [...classes][0] : null;
}

function dpeFromSourceBlocks(blocks: AuctionSale["source_blocks"]): DpeClass | null {
  if (!blocks || typeof blocks !== "object") return null;
  return (
    normalizeDpeClass(blocks.dpe_classe) ??
    normalizeDpeClass(blocks.dpe) ??
    normalizeDpeClass(blocks.diagnostic_dpe) ??
    normalizeDpeClass(blocks.classe_energie)
  );
}

function cleanText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text || null;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
