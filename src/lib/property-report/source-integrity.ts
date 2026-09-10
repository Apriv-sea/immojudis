import { createHash } from "node:crypto";
import type { AuctionSale } from "../types";

// A capture timestamp or gallery reorder does not change the report's findings.
const ignoredKeys = new Set(["created_at", "updated_at", "media"]);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !ignoredKeys.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value ?? null;
}

export function reportSourceFingerprint(sale: AuctionSale): string {
  return `v1:${createHash("sha256")
    .update(JSON.stringify(canonical(sale)))
    .digest("hex")}`;
}

export class ReportSourceChangedError extends Error {
  constructor() {
    super(
      "Les données de ce rapport doivent être actualisées. Ouvrez l’annonce et sauvegardez à nouveau votre analyse avant de l’exporter ou de la partager.",
    );
    this.name = "ReportSourceChangedError";
  }
}

export function assertReportSourceCurrent(snapshot: unknown, sale: AuctionSale): void {
  const fingerprint =
    snapshot && typeof snapshot === "object" && "sourceFingerprint" in snapshot
      ? snapshot.sourceFingerprint
      : null;
  if (fingerprint !== reportSourceFingerprint(sale)) {
    throw new ReportSourceChangedError();
  }
}
