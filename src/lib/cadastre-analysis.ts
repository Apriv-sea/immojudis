import type { AuctionSale, SaleDocumentRich, SaleRisk } from "@/lib/types";

export type CadastralReference = {
  prefix?: string | null;
  section: string | null;
  number: string | null;
  raw: string;
  source: string;
  confidence: "structured" | "direct" | "inferred";
};

export type CadastralDocument = {
  label: string;
  type: string | null;
  url: string | null;
};

export type CadastralAnalysis = {
  available: boolean;
  status: "identified" | "partial" | "document_referenced" | "surface_only" | "missing";
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  landSurfaceM2: number | null;
  references: CadastralReference[];
  structuredParcels: StructuredCadastralParcel[];
  documents: CadastralDocument[];
  sources: string[];
  summary: string;
  nextActions: string[];
  limitations: string[];
};

export type StructuredCadastralParcel = {
  parcelKey: string | null;
  parcelId: string | null;
  codeInsee: string | null;
  department: string | null;
  city: string | null;
  section: string | null;
  parcelNumber: string | null;
  surfaceM2: number | null;
  centroidLat: number | null;
  centroidLng: number | null;
  matchKind: string | null;
  confidence: number | null;
  sourceApi: string | null;
};

type TextCandidate = {
  text: string;
  source: string;
  confidence: CadastralReference["confidence"];
};

const CADASTRAL_CONTEXT =
  /cadastre|cadastral|cadastr|parcelle|section|contenance|terrain|limite|servitude|plan/i;
const CADASTRAL_KEY =
  /cadastre|cadastral|cadastr|parcelle|parcel|section|contenance|terrain|land_surface|surface_terrain/i;
const SECTION_KEYS = /(^|_|\.)(section|section_cadastrale|cadastral_section)$/i;
const NUMBER_KEYS =
  /(?:^|\.)(?:number|numero|numero_parcelle|num_parcelle|cadastral_number|parcel_number|parcelNumber|parcelle|parcel)$/i;
const COMPACT_REFERENCE_KEY =
  /(?:^|\.)(?:cadastre|reference_cadastrale|cadastral_reference|parcelle|parcel_reference)$/i;

const REFERENCE_PATTERNS = [
  /\bsection\s+(?:[0-9]{3}\s+)?([A-Z]{1,4})\s*(?:,|\s|-)*(?:parcelle\s*)?(?:n(?:umero|o|°|º)?\.?\s*)?([0-9]{1,5}[A-Z]?)\b/gi,
  /\bparcelle(?:s)?(?:\s+cadastr(?:ee|e|ees|ees))?\s*(?:section\s*)?([A-Z]{1,4})\s*(?:n(?:umero|o|°|º)?\.?\s*)?([0-9]{1,5}[A-Z]?)\b/gi,
  /\bcadastre(?:e|es|s)?\s*(?:section\s*)?([A-Z]{1,4})\s*(?:n(?:umero|o|°|º)?\.?\s*)?([0-9]{1,5}[A-Z]?)\b/gi,
];

export function buildCadastralAnalysis(
  sale: AuctionSale,
  structuredParcels: StructuredCadastralParcel[] = [],
): CadastralAnalysis {
  const normalizedParcels = normalizeStructuredParcels(structuredParcels);
  const documents = collectCadastralDocuments(sale.documents_rich ?? []);
  const references = collectCadastralReferences(sale, normalizedParcels);
  const landSurfaceM2 =
    positiveNumber(sale.land_surface_m2) ??
    normalizedParcels.find((parcel) => parcel.surfaceM2 != null)?.surfaceM2 ??
    null;
  const sources = collectSources({
    references,
    documents,
    landSurfaceM2,
    structuredParcels: normalizedParcels,
  });
  const status = cadastralStatus({ references, documents, landSurfaceM2 });
  const confidence = cadastralConfidence(status, references);

  return {
    available: status !== "missing",
    status,
    confidence,
    confidenceLabel: confidenceLabel(status, confidence, references),
    landSurfaceM2,
    references,
    structuredParcels: normalizedParcels,
    documents,
    sources,
    summary: cadastralSummary({ status, references, documents, landSurfaceM2 }),
    nextActions: cadastralNextActions({ status, references, documents, landSurfaceM2 }),
    limitations: cadastralLimitations(status),
  };
}

export function formatCadastralReference(reference: CadastralReference): string {
  if (reference.section && reference.number) {
    return `Section ${reference.prefix ? `${reference.prefix} ` : ""}${reference.section} n° ${reference.number}`;
  }
  return reference.raw;
}

function collectCadastralReferences(
  sale: AuctionSale,
  structuredParcels: StructuredCadastralParcel[],
): CadastralReference[] {
  const candidates = [
    ...referencesFromStructuredParcels(structuredParcels),
    ...directReferencesFromBlocks(sale.source_blocks, "Données source"),
    ...Object.entries(sale.source_blocks_by_source ?? {}).flatMap(([sourceName, blocks]) =>
      directReferencesFromBlocks(blocks, `Données source ${sourceName}`),
    ),
    ...textCandidatesFromSale(sale).flatMap(extractReferencesFromCandidate),
  ];

  return dedupeReferences(candidates).slice(0, 8);
}

function referencesFromStructuredParcels(
  parcels: StructuredCadastralParcel[],
): CadastralReference[] {
  return parcels
    .map((parcel): CadastralReference | null => {
      const section = normalizeSection(parcel.section);
      const number = normalizeParcelNumber(parcel.parcelNumber);
      const raw = [parcel.codeInsee, section, number].filter(Boolean).join(" ");
      if (!section && !number && !parcel.parcelId && !parcel.parcelKey) return null;
      return {
        section,
        number,
        raw: raw || parcel.parcelId || parcel.parcelKey || "Parcelle API Carto",
        source: parcel.sourceApi || "API Carto Cadastre",
        confidence: "structured",
      };
    })
    .filter((reference): reference is CadastralReference => Boolean(reference));
}

function directReferencesFromBlocks(
  blocks: Record<string, unknown> | null | undefined,
  source: string,
): CadastralReference[] {
  if (!blocks || typeof blocks !== "object") return [];

  const values = flattenKeyValues(blocks);
  const references: CadastralReference[] = [];
  for (const section of values.filter((item) => SECTION_KEYS.test(item.path))) {
    const parent = section.path.slice(0, section.path.lastIndexOf(".") + 1);
    const number = values.find(
      (item) =>
        NUMBER_KEYS.test(item.path) &&
        item.path.slice(0, item.path.lastIndexOf(".") + 1) === parent,
    );
    const normalizedSection = normalizeSection(section.value);
    const normalizedNumber = normalizeParcelNumber(number?.value);
    if (!normalizedSection || !normalizedNumber || !number) continue;
    references.push({
      section: normalizedSection,
      number: normalizedNumber,
      raw: `${normalizedSection} ${normalizedNumber}`,
      source: `${source} (${section.path}, ${number.path})`,
      confidence: "direct",
    });
  }

  for (const item of values) {
    if (!CADASTRAL_KEY.test(item.path)) continue;
    const text = cleanText(item.value);
    if (!text) continue;
    const compact =
      COMPACT_REFERENCE_KEY.test(item.path) &&
      /^([A-Z]{1,4})\s*(?:n(?:umero|o|°|º)?\.?\s*)?([0-9]{1,5}[A-Z]?)$/i.exec(text);
    if (compact)
      references.push({
        section: normalizeSection(compact[1]),
        number: normalizeParcelNumber(compact[2]),
        raw: text,
        source: `${source} (${item.path})`,
        confidence: "direct",
      });
    references.push(
      ...extractReferencesFromCandidate({
        text,
        source: `${source} (${item.path})`,
        confidence: "inferred",
      }),
    );
  }

  return references;
}

function textCandidatesFromSale(sale: AuctionSale): TextCandidate[] {
  const candidates: TextCandidate[] = [];

  addCandidate(candidates, sale.title, "Titre annonce", "inferred");
  addCandidate(
    candidates,
    sale.source_description ? null : sale.description,
    "Description annonce",
    "inferred",
  );
  addCandidate(candidates, sale.source_description, "Description source", "inferred");
  addCandidate(candidates, sale.surface_evidence, "Preuve de surface", "inferred");

  for (const item of flattenKeyValues(sale.source_blocks ?? {})) {
    if (CADASTRAL_KEY.test(item.path) || CADASTRAL_CONTEXT.test(cleanText(item.value) ?? "")) {
      addCandidate(candidates, cleanText(item.value), "Données source", "inferred");
    }
  }

  for (const [sourceName, blocks] of Object.entries(sale.source_blocks_by_source ?? {})) {
    for (const item of flattenKeyValues(blocks)) {
      if (CADASTRAL_KEY.test(item.path) || CADASTRAL_CONTEXT.test(cleanText(item.value) ?? "")) {
        addCandidate(candidates, cleanText(item.value), `Données source ${sourceName}`, "inferred");
      }
    }
  }

  for (const document of sale.documents_rich ?? []) {
    addCandidate(
      candidates,
      `${document.type ?? ""} ${document.document_type ?? ""} ${document.label ?? ""}`,
      "Pièces du dossier",
      "inferred",
    );
  }

  for (const risk of sale.risks ?? []) {
    for (const text of riskTexts(risk)) {
      addCandidate(candidates, text, "Preuves de risques", "inferred");
    }
  }

  return candidates.filter((candidate) => CADASTRAL_CONTEXT.test(candidate.text));
}

function extractReferencesFromCandidate(candidate: TextCandidate): CadastralReference[] {
  const normalizedText = normalizeForMatching(candidate.text);
  if (!CADASTRAL_CONTEXT.test(normalizedText)) return [];

  const references: CadastralReference[] = [];
  for (const pattern of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of normalizedText.matchAll(pattern)) {
      const section = normalizeSection(match[1]);
      const number = normalizeParcelNumber(match[2]);
      if (!section || !number) continue;
      references.push({
        section,
        number,
        prefix: /\bsection\s+([0-9]{3})\s+/i.exec(match[0])?.[1] ?? null,
        raw: match[0].trim(),
        source: candidate.source,
        confidence: candidate.confidence,
      });
    }
  }

  return references;
}

function collectCadastralDocuments(documents: SaleDocumentRich[]): CadastralDocument[] {
  return documents
    .filter((document) =>
      CADASTRAL_CONTEXT.test(
        `${document.type ?? ""} ${document.document_type ?? ""} ${document.label ?? ""}`,
      ),
    )
    .map((document, index) => ({
      label:
        cleanText(document.label) ?? cleanText(document.type) ?? `Document cadastral ${index + 1}`,
      type: cleanText(document.type) ?? cleanText(document.document_type),
      url: cleanText(document.url),
    }))
    .slice(0, 6);
}

function cadastralStatus({
  references,
  documents,
  landSurfaceM2,
}: {
  references: CadastralReference[];
  documents: CadastralDocument[];
  landSurfaceM2: number | null;
}): CadastralAnalysis["status"] {
  if (references.some((reference) => reference.section && reference.number)) return "identified";
  if (references.length) return "partial";
  if (documents.length) return "document_referenced";
  if (landSurfaceM2 != null) return "surface_only";
  return "missing";
}

function cadastralConfidence(
  status: CadastralAnalysis["status"],
  references: CadastralReference[],
): CadastralAnalysis["confidence"] {
  if (
    status === "identified" &&
    references.some(
      (reference) => reference.confidence === "structured" || reference.confidence === "direct",
    )
  ) {
    return "high";
  }
  if (status === "identified" || status === "partial" || status === "document_referenced") {
    return "medium";
  }
  return "low";
}

function confidenceLabel(
  status: CadastralAnalysis["status"],
  confidence: CadastralAnalysis["confidence"],
  references: CadastralReference[],
): string {
  if (
    status === "identified" &&
    references.some((reference) => reference.confidence === "structured")
  ) {
    return "Parcelle API Carto rattachée";
  }
  if (status === "identified" && confidence === "high") return "Référence cadastrale structurée";
  if (status === "identified") return "Référence détectée à confirmer";
  if (status === "partial") return "Indice parcellaire incomplet";
  if (status === "document_referenced") return "Pièce cadastrale repérée";
  if (status === "surface_only") return "Surface terrain connue sans parcelle";
  return "Cadastre non identifié";
}

function cadastralSummary({
  status,
  references,
  documents,
  landSurfaceM2,
}: {
  status: CadastralAnalysis["status"];
  references: CadastralReference[];
  documents: CadastralDocument[];
  landSurfaceM2: number | null;
}): string {
  const formattedReferences = references.slice(0, 3).map(formatCadastralReference);
  const surface = landSurfaceM2 != null ? ` · surface terrain ${Math.round(landSurfaceM2)} m²` : "";

  if (status === "identified") {
    return `Parcelle repérée : ${formattedReferences.join(", ")}${surface}.`;
  }
  if (status === "partial") {
    return `Indice cadastral détecté : ${formattedReferences.join(", ")}${surface}.`;
  }
  if (status === "document_referenced") {
    return `Pièce cadastrale ou plan repéré dans le dossier (${documents.length} document(s)).`;
  }
  if (status === "surface_only") {
    return `Surface terrain connue (${Math.round(landSurfaceM2 ?? 0)} m²), parcelle à rattacher.`;
  }
  return "Parcelle cadastrale à connecter ou à confirmer.";
}

function cadastralNextActions({
  status,
  references,
  documents,
  landSurfaceM2,
}: {
  status: CadastralAnalysis["status"];
  references: CadastralReference[];
  documents: CadastralDocument[];
  landSurfaceM2: number | null;
}): string[] {
  const actions: string[] = [];

  if (references.length) {
    actions.push(
      "Vérifier la concordance section/numéro avec le plan cadastral et le cahier des conditions de vente.",
    );
  } else if (documents.length) {
    actions.push(
      "Extraire la section et le numéro de parcelle depuis la pièce cadastrale repérée.",
    );
  } else {
    actions.push(
      "Rattacher la vente à une parcelle via l'adresse géocodée, puis contrôler la section et le numéro.",
    );
  }

  if (landSurfaceM2 != null) {
    actions.push("Comparer la contenance cadastrale avec la surface terrain annoncée.");
  } else if (status !== "missing") {
    actions.push(
      "Ajouter la contenance cadastrale pour contrôler terrain, accès et éventuelles divisions.",
    );
  }

  actions.push(
    "Contrôler les accès, servitudes, limites de lot et éventuelles indivisions avant enchère.",
  );
  return actions.slice(0, 4);
}

function cadastralLimitations(status: CadastralAnalysis["status"]): string[] {
  const limitations = [
    "Analyse issue des données collectées et des libellés de pièces ; elle ne remplace pas le plan cadastral officiel.",
    "La jointure API Carto par point géocodé doit être recoupée avec l'adresse, le plan et le cahier des conditions de vente.",
    "La parcelle, la contenance et les servitudes doivent être confirmées dans les pièces officielles.",
  ];

  if (status === "missing" || status === "surface_only") {
    limitations.unshift(
      "Aucune référence section/numéro fiable n'est encore rattachée à cette vente.",
    );
  }

  return limitations;
}

function collectSources({
  references,
  documents,
  landSurfaceM2,
  structuredParcels,
}: {
  references: CadastralReference[];
  documents: CadastralDocument[];
  landSurfaceM2: number | null;
  structuredParcels: StructuredCadastralParcel[];
}): string[] {
  const sources = new Set<string>();
  references.forEach((reference) => sources.add(reference.source));
  documents.forEach((document) => sources.add(document.label));
  structuredParcels.forEach((parcel) => sources.add(parcel.sourceApi || "API Carto Cadastre"));
  if (landSurfaceM2 != null) sources.add("Surface terrain");
  return [...sources].slice(0, 8);
}

function normalizeStructuredParcels(
  parcels: StructuredCadastralParcel[],
): StructuredCadastralParcel[] {
  return parcels
    .map((parcel) => ({
      parcelKey: cleanText(parcel.parcelKey),
      parcelId: cleanText(parcel.parcelId),
      codeInsee: cleanText(parcel.codeInsee),
      department: cleanText(parcel.department),
      city: cleanText(parcel.city),
      section: normalizeSection(parcel.section),
      parcelNumber: normalizeParcelNumber(parcel.parcelNumber),
      surfaceM2: positiveNumber(parcel.surfaceM2),
      centroidLat: finiteNumber(parcel.centroidLat),
      centroidLng: finiteNumber(parcel.centroidLng),
      matchKind: cleanText(parcel.matchKind),
      confidence: finiteNumber(parcel.confidence),
      sourceApi: cleanText(parcel.sourceApi) ?? "API Carto Cadastre",
    }))
    .filter(
      (parcel) =>
        parcel.parcelKey ||
        parcel.parcelId ||
        (parcel.codeInsee && parcel.section && parcel.parcelNumber),
    )
    .slice(0, 8);
}

function dedupeReferences(references: CadastralReference[]): CadastralReference[] {
  const byKey = new Map<string, CadastralReference>();
  for (const reference of references) {
    const key =
      reference.section && reference.number
        ? `${reference.prefix ?? ""}-${reference.section}-${reference.number}`
        : normalizeForMatching(reference.raw);
    const existing = byKey.get(key);
    if (!existing || referencePriority(reference) > referencePriority(existing)) {
      byKey.set(key, reference);
    }
  }
  return [...byKey.values()];
}

function referencePriority(reference: CadastralReference): number {
  if (reference.confidence === "structured") return 3;
  if (reference.confidence === "direct") return 2;
  return 1;
}

function addCandidate(
  candidates: TextCandidate[],
  value: unknown,
  source: string,
  confidence: CadastralReference["confidence"],
) {
  const text = cleanText(value);
  if (text) candidates.push({ text, source, confidence });
}

function riskTexts(risk: SaleRisk): string[] {
  const texts: unknown[] = [risk.risk_label, risk.evidence];
  const evidence = risk.evidence_json;
  if (evidence && typeof evidence === "object") {
    const record = evidence as Record<string, unknown>;
    texts.push(record.excerpt);
  }
  for (const occurrence of risk.occurrences ?? []) {
    texts.push(
      occurrence.document_label,
      occurrence.document_type,
      occurrence.excerpt,
      occurrence.matched_terms,
    );
  }
  return texts.map(cleanText).filter((text): text is string => Boolean(text));
}

function flattenKeyValues(value: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenPrimitiveOrObject(item, `${path}[${index}]`));
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    flattenPrimitiveOrObject(item, path ? `${path}.${key}` : key),
  );
}

function flattenPrimitiveOrObject(
  value: unknown,
  path: string,
): Array<{ path: string; value: unknown }> {
  if (value && typeof value === "object") return flattenKeyValues(value, path);
  return [{ path, value }];
}

function normalizeSection(value: unknown): string | null {
  const text = cleanText(value)
    ?.toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!text || !/[A-Z]/.test(text) || text.length > 4) return null;
  return text;
}

function normalizeParcelNumber(value: unknown): string | null {
  const text = cleanText(value)
    ?.toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  if (!text || !/^[0-9]{1,5}[A-Z]?$/.test(text)) return null;
  return text;
}

function normalizeForMatching(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text || null;
  }
  if (Array.isArray(value)) {
    const text = value.map(cleanText).filter(Boolean).join(" ");
    return text || null;
  }
  return null;
}
