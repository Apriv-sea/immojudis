import { parseDocs, safeDocumentUrl } from "./documents";
import { getSaleProcedure } from "./sale-procedure";
import type { AuctionSale, SaleDocumentRich } from "./types";

/** Case documents only: regulatory links and labels without a usable URL are excluded. */
export function collectSaleDocuments(
  sale: AuctionSale,
): Array<SaleDocumentRich & { name?: string }> {
  const documents = new Map<string, SaleDocumentRich & { name?: string }>();
  const candidates: SaleDocumentRich[] = [
    ...(sale.documents_rich ?? []),
    ...parseDocs(sale.documents).map((doc) => ({
      url: doc.url,
      label: doc.name ?? null,
      type: doc.type ?? null,
      extraction_status: null,
    })),
    ...getSaleProcedure(sale)
      .sources.filter((source) => source.kind === "document")
      .map((source) => ({
        url: source.url ?? "",
        label: source.label ?? null,
        type: source.document_type ?? null,
        extraction_status: null,
      })),
  ];
  for (const document of candidates) {
    const url = safeDocumentUrl(document.url);
    if (!url) continue;
    const previous = documents.get(url);
    const label = previous?.label || document.label || null;
    const type = previous?.type || document.type || null;
    const qualifiedType =
      (!type || type === "pdf") && /\bccv\b/i.test(label ?? "") ? "cahier_conditions" : type;
    documents.set(url, {
      ...document,
      ...previous,
      url,
      label,
      name: label ?? undefined,
      type: qualifiedType,
    });
  }
  return [...documents.values()];
}
