import { collectSaleDocuments } from "@/lib/sale-documents";
import type { EnvironmentalContext } from "@/lib/environment.functions";
import type { MarketEstimate } from "@/lib/market.functions";
import type { AuctionSale, SaleDocumentRich, SaleRisk } from "@/lib/types";
import type { StructuredCadastralParcel } from "@/lib/cadastre-analysis";
import type { StructuredDpeDiagnostic } from "@/lib/dpe";
import type { StructuredUrbanPlanningSignal } from "@/lib/urban-planning-analysis";
import {
  getSaleProcedure,
  lawyerRequirementLabel,
  saleVerificationLabel,
  saleVenueLabel,
} from "@/lib/sale-procedure";

export type SourceTraceKind =
  | "judicial_listing"
  | "judicial_document"
  | "sale_procedure"
  | "surface_evidence"
  | "cadastral_context"
  | "dpe_context"
  | "urban_planning_context"
  | "risk_evidence"
  | "market_estimate"
  | "environmental_context";

export type SourceTraceEntry = {
  id: string;
  kind: SourceTraceKind;
  label: string;
  sourceName: string;
  url: string | null;
  capturedAt: string | null;
  confidenceLabel: string;
  detail: string;
  limitation: string;
};

export type ReportTraceability = {
  generatedAt: string;
  entries: SourceTraceEntry[];
  limitations: string[];
  complianceNotice: string;
};

export const REPORT_COMPLIANCE_NOTICE =
  "Rapport indicatif ImmoJudis : les estimations, scores et plafonds d’enchère sont des aides à la décision, sans promesse de gain. Vérifiez les pièces officielles, la visite, le cahier des conditions de vente et votre conseil avant toute enchère.";

const GENERIC_REPORT_LIMITATIONS = [
  "Les estimations reposent sur les données disponibles au moment de la génération du rapport.",
  "Les comparables de marché peuvent être incomplets, décalés dans le temps ou non parfaitement comparables au bien.",
  "Le score d’opportunité ne tient pas compte de tous les éléments qualitatifs observés lors d'une visite.",
  "Les frais, travaux, conditions d'occupation et points juridiques doivent être confirmés avant l'audience.",
  "Aucun rendement, gain, adjudication ou prix de revente n'est garanti.",
];

export function buildReportTraceability({
  sale,
  marketEstimate,
  cadastreParcels = [],
  dpeDiagnostics = [],
  urbanPlanningSignals = [],
  environmentalContext,
  generatedAt = new Date().toISOString(),
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  cadastreParcels?: StructuredCadastralParcel[];
  dpeDiagnostics?: StructuredDpeDiagnostic[];
  urbanPlanningSignals?: StructuredUrbanPlanningSignal[];
  environmentalContext?: EnvironmentalContext | null;
  generatedAt?: string;
}): ReportTraceability {
  const entries = dedupeTraceEntries([
    ...listingEntries(sale),
    ...procedureEntries(sale),
    ...surfaceEntries(sale),
    ...cadastreEntries(cadastreParcels),
    ...dpeEntries(dpeDiagnostics),
    ...urbanPlanningEntries(urbanPlanningSignals),
    ...documentEntries(collectSaleDocuments(sale)),
    ...riskEntries(sale.risks ?? []),
    ...marketEntries(marketEstimate),
    ...environmentEntries(environmentalContext ?? null),
  ]);

  return {
    generatedAt,
    entries,
    limitations: buildLimitations({ marketEstimate, sale }),
    complianceNotice: REPORT_COMPLIANCE_NOTICE,
  };
}

function procedureEntries(sale: AuctionSale): SourceTraceEntry[] {
  const procedure = getSaleProcedure(sale);
  if (!procedure.procedure) return [];

  return procedure.sources
    .filter((source) => source.kind !== "document")
    .map((source, index) => ({
      id: stableId("sale-procedure", source.url, source.label, String(index)),
      kind: "sale_procedure",
      label: cleanText(source.label) ?? `Source de procédure ${index + 1}`,
      sourceName: cleanText(source.source_name) ?? "Vérification Immojudis",
      url: cleanText(source.url),
      capturedAt: cleanText(source.checked_at) ?? procedure.verifiedAt,
      confidenceLabel: saleVerificationLabel(procedure.verificationStatus),
      detail: `${saleVenueLabel(procedure.venueType)} · ${lawyerRequirementLabel(procedure)}`,
      limitation: procedure.issues.length
        ? procedure.issues.join(" ")
        : "Les conditions particulières du cahier des charges restent applicables à cette vente.",
    }));
}

function urbanPlanningEntries(signals: StructuredUrbanPlanningSignal[]): SourceTraceEntry[] {
  return signals.slice(0, 4).map((signal, index) => {
    const detail = [
      cleanText(signal.label),
      cleanText(signal.excerpt),
      typeof signal.pageNumber === "number" ? `page ${signal.pageNumber}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      id: stableId("urban-planning", signal.signalKey, String(index)),
      kind: "urban_planning_context",
      label: cleanText(signal.label) ?? "Signal urbanisme",
      sourceName:
        cleanText(signal.documentLabel) ??
        cleanText(signal.sourceName) ??
        "Signal urbanisme ImmoJudis",
      url: cleanText(signal.documentUrl),
      capturedAt: cleanText(signal.updatedAt),
      confidenceLabel:
        typeof signal.confidence === "number"
          ? `${Math.round(signal.confidence * 100)}%`
          : "À confirmer",
      detail: truncate(detail || "Signal urbanisme, permis ou servitude rattache a la vente.", 260),
      limitation:
        "Le signal doit etre recoupe avec le PLU, le cahier des conditions et les pieces officielles.",
    };
  });
}

function dpeEntries(diagnostics: StructuredDpeDiagnostic[]): SourceTraceEntry[] {
  return diagnostics.slice(0, 3).map((diagnostic, index) => {
    const detail = [
      diagnostic.diagnosticNumber ? `DPE ${diagnostic.diagnosticNumber}` : null,
      diagnostic.dpeClass ? `classe ${diagnostic.dpeClass}` : null,
      diagnostic.gesClass ? `GES ${diagnostic.gesClass}` : null,
      diagnostic.establishedAt ? `etabli le ${diagnostic.establishedAt}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      id: stableId("dpe", diagnostic.diagnosticNumber, String(index)),
      kind: "dpe_context",
      label: "Diagnostic DPE",
      sourceName: cleanText(diagnostic.sourceApi) ?? "ADEME DPE Open Data",
      url: null,
      capturedAt: diagnostic.establishedAt,
      confidenceLabel:
        typeof diagnostic.confidence === "number"
          ? `${Math.round(diagnostic.confidence * 100)}%`
          : "À confirmer",
      detail: detail || "Diagnostic energetique rattache a la vente.",
      limitation:
        "Le rattachement ADEME doit etre recoupe avec le diagnostic joint au dossier et l'adresse exacte du bien.",
    };
  });
}

function cadastreEntries(parcels: StructuredCadastralParcel[]): SourceTraceEntry[] {
  return parcels.slice(0, 3).map((parcel, index) => {
    const reference = [
      parcel.codeInsee ? `INSEE ${parcel.codeInsee}` : null,
      parcel.section && parcel.parcelNumber
        ? `section ${parcel.section} n° ${parcel.parcelNumber}`
        : null,
      parcel.surfaceM2 ? `contenance ${Math.round(parcel.surfaceM2)} m2` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      id: stableId("cadastre", parcel.parcelKey, parcel.parcelId, String(index)),
      kind: "cadastral_context",
      label: "Parcelle cadastrale",
      sourceName: cleanText(parcel.sourceApi) ?? "API Carto Cadastre",
      url: null,
      capturedAt: null,
      confidenceLabel:
        typeof parcel.confidence === "number"
          ? `${Math.round(parcel.confidence * 100)}%`
          : "À confirmer",
      detail: reference || "Parcelle rattachee depuis la localisation geocodee.",
      limitation:
        "Le rattachement par point geocode doit etre recoupe avec le plan cadastral et les pieces officielles.",
    };
  });
}

function listingEntries(sale: AuctionSale): SourceTraceEntry[] {
  const sourceName = cleanText(sale.source_name) ?? cleanText(sale.primary_source) ?? "Annonce";
  const primaryUrl = cleanText(sale.source_url);
  const capturedAt = sourceCapturedAt(sale);
  const entries: SourceTraceEntry[] = [];

  if (primaryUrl || sourceName !== "Annonce") {
    entries.push({
      id: stableId("listing", primaryUrl ?? sourceName),
      kind: "judicial_listing",
      label: "Annonce de vente",
      sourceName,
      url: primaryUrl,
      capturedAt,
      confidenceLabel: "Source primaire",
      detail: cleanText(sale.primary_source) ?? "Fiche issue de la source de vente collectée.",
      limitation: "La fiche doit etre relue dans sa version officielle avant toute decision.",
    });
  }

  for (const url of collectUrlStrings(sale.source_urls)) {
    if (url === primaryUrl) continue;
    entries.push({
      id: stableId("listing-extra", url),
      kind: "judicial_listing",
      label: "Source complementaire",
      sourceName,
      url,
      capturedAt,
      confidenceLabel: "Source collectee",
      detail: "URL rattachee a la meme vente ou a une observation source.",
      limitation:
        "Les doublons ou observations multiples peuvent diverger et doivent etre recoupes.",
    });
  }

  return entries;
}

function surfaceEntries(sale: AuctionSale): SourceTraceEntry[] {
  const evidence = cleanText(sale.surface_evidence);
  if (!evidence) return [];
  const confidence =
    typeof sale.surface_confidence === "number"
      ? `${Math.round(sale.surface_confidence * 100)}%`
      : "À confirmer";

  return [
    {
      id: stableId("surface", sale.id, evidence),
      kind: "surface_evidence",
      label: "Surface retenue",
      sourceName: cleanText(sale.surface_source)?.replaceAll("_", " ") ?? "Pièce du dossier",
      url: cleanText(sale.source_url),
      capturedAt: sourceCapturedAt(sale),
      confidenceLabel: confidence,
      detail: truncate(evidence, 260),
      limitation:
        "Une surface erronnee modifie le prix au metre carre, les comparables et le plafond d’enchère.",
    },
  ];
}

function documentEntries(documents: SaleDocumentRich[]): SourceTraceEntry[] {
  return documents
    .filter(
      (document) =>
        cleanText(document.url) || cleanText(document.label) || cleanText(document.type),
    )
    .map((document, index) => {
      const label =
        cleanText(document.label) ?? cleanText(document.type) ?? `Document ${index + 1}`;
      const status = cleanText(document.extraction_status) ?? cleanText(document.download_status);
      return {
        id: stableId("document", document.url, label, String(index)),
        kind: "judicial_document",
        label,
        sourceName:
          cleanText(document.type) ?? cleanText(document.document_type) ?? "Pièce du dossier",
        url: cleanText(document.url),
        capturedAt: null,
        confidenceLabel: status ? `Statut ${status}` : "Pièce référencée",
        detail:
          typeof document.text_chars === "number" && document.text_chars > 0
            ? `${document.text_chars.toLocaleString("fr-FR")} caracteres extraits`
            : "Pièce référencée dans le dossier de vente.",
        limitation: "Le contenu doit etre confronte au document officiel complet et a ses annexes.",
      };
    });
}

function riskEntries(risks: SaleRisk[]): SourceTraceEntry[] {
  return risks
    .filter((risk) => cleanText(risk.evidence) || cleanText(risk.risk_label))
    .slice(0, 5)
    .map((risk, index) => {
      const occurrence = bestRiskOccurrence(risk);
      const label =
        cleanText(risk.risk_label) ?? cleanText(risk.risk_type) ?? `Risque ${index + 1}`;
      const confidence =
        typeof risk.confidence === "number"
          ? `${Math.round(risk.confidence * 100)}%`
          : "À confirmer";
      return {
        id: stableId("risk", label, occurrence?.document_url, String(index)),
        kind: "risk_evidence",
        label,
        sourceName:
          cleanText(occurrence?.document_label) ??
          cleanText(occurrence?.document_type) ??
          "Preuve de risque",
        url: cleanText(occurrence?.document_url),
        capturedAt: cleanText(occurrence?.updated_at),
        confidenceLabel: confidence,
        detail: truncate(cleanText(occurrence?.excerpt) ?? cleanText(risk.evidence) ?? "", 260),
        limitation:
          "Ce point d'attention doit etre qualifie et chiffre avec les pieces officielles.",
      };
    });
}

function marketEntries(marketEstimate: MarketEstimate | null): SourceTraceEntry[] {
  if (!marketEstimate) return [];
  return [
    {
      id: stableId("market", marketEstimate.source, String(marketEstimate.radiusM)),
      kind: "market_estimate",
      label: "Estimation marche",
      sourceName: cleanText(marketEstimate.source) ?? "Comparables de marche",
      url: null,
      capturedAt: null,
      confidenceLabel: cleanText(marketEstimate.qualityLabel) ?? "Qualité à confirmer",
      detail: `${marketEstimate.sampleSize} comparable(s), rayon ${marketEstimate.radiusM} m, mode ${marketEstimate.comparableMode}.`,
      limitation:
        "Les references de marche ne captent pas toutes les qualites, defauts, travaux ou contraintes propres au bien.",
    },
  ];
}

function environmentEntries(environmentalContext: EnvironmentalContext | null): SourceTraceEntry[] {
  if (!environmentalContext) return [];
  return [
    {
      id: stableId(
        "environment",
        environmentalContext.resolvedAddress.label,
        String(environmentalContext.period.startYear),
      ),
      kind: "environmental_context",
      label: "Contexte environnemental",
      sourceName: environmentalContext.source,
      url: null,
      capturedAt: null,
      confidenceLabel: environmentalContext.resolvedAddress.source,
      detail: `${environmentalContext.period.years} annees analysees pour ${environmentalContext.resolvedAddress.label}.`,
      limitation:
        "Les donnees environnementales sont indicatives et ne remplacent pas les diagnostics ni les risques locaux officiels.",
    },
  ];
}

function buildLimitations({
  marketEstimate,
  sale,
}: {
  marketEstimate: MarketEstimate | null;
  sale: AuctionSale;
}) {
  const limitations = new Set(GENERIC_REPORT_LIMITATIONS);

  if (!marketEstimate) {
    limitations.add(
      "L'estimation marche n'a pas pu etre calculee faute de localisation ou surface exploitable.",
    );
  } else if (marketEstimate.sampleSize < 6) {
    limitations.add(
      "L'echantillon de comparables est faible : la fourchette de valeur doit etre consideree comme fragile.",
    );
  }

  if (!sale.surface_evidence) {
    limitations.add("La surface retenue n'est pas encore rattachee a une preuve structuree.");
  }

  if (!sale.risks?.length) {
    limitations.add(
      "Aucun risque structure n'est disponible : la revue des pieces reste indispensable.",
    );
  }

  return [...limitations];
}

function dedupeTraceEntries(entries: SourceTraceEntry[]) {
  const seen = new Set<string>();
  const result: SourceTraceEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.kind}|${entry.url ?? ""}|${entry.label}|${entry.sourceName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }

  return result;
}

function sourceCapturedAt(sale: AuctionSale): string | null {
  const blocks = sale.source_blocks;
  return (
    (blocks ? cleanText(blocks.source_updated_at) || cleanText(blocks.updated_at) : null) ??
    cleanText(sale.updated_at) ??
    cleanText(sale.created_at)
  );
}

function bestRiskOccurrence(risk: SaleRisk) {
  return (
    [...(risk.occurrences ?? [])]
      .filter((occurrence) => cleanText(occurrence.excerpt) || cleanText(occurrence.document_url))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0] ?? null
  );
}

function collectUrlStrings(value: unknown): string[] {
  const urls = new Set<string>();

  function visit(node: unknown) {
    if (typeof node === "string") {
      if (looksLikeUrl(node)) urls.add(node.trim());
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === "object") {
      Object.values(node as Record<string, unknown>).forEach(visit);
    }
  }

  visit(value);
  return [...urls];
}

function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) || trimmed.startsWith("/");
}

function stableId(...parts: Array<string | null | undefined>) {
  return parts
    .filter((part): part is string => Boolean(part?.trim()))
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}
