import type { SaleDocument } from "@/lib/types";
import { safeExternalHttpUrl } from "@/lib/external-url";

export function parseDocs(raw: unknown): SaleDocument[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((document): SaleDocument | null => {
        if (typeof document === "string") {
          const url = safeDocumentUrl(document);
          return url ? { url } : null;
        }
        if (
          document &&
          typeof document === "object" &&
          "url" in document &&
          typeof (document as { url: unknown }).url === "string"
        ) {
          const url = safeDocumentUrl((document as { url: string }).url);
          const entry = document as SaleDocument & { label?: unknown };
          const name = entry.name || (typeof entry.label === "string" ? entry.label : undefined);
          return url ? { ...entry, url, ...(name ? { name } : {}) } : null;
        }
        return null;
      })
      .filter((document): document is SaleDocument => document !== null);
  }
  if (typeof raw === "object" && raw !== null) {
    return Object.values(raw as Record<string, unknown>)
      .filter((value): value is string => typeof value === "string")
      .map(safeDocumentUrl)
      .filter((url): url is string => url !== null)
      .map((url) => ({ url }));
  }
  return [];
}

export function safeDocumentUrl(value: unknown): string | null {
  return safeExternalHttpUrl(value);
}

export function isEmbeddableDocumentUrl(value: unknown): boolean {
  const href = safeDocumentUrl(value);
  return href !== null && /\.(pdf|png|jpe?g|webp)(?:[?#].*)?$/i.test(href);
}
