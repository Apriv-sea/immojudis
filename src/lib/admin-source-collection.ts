export const CLOUD_COLLECTION_SOURCES = ["petites_affiches", "cessions_etat"] as const;

export function collectionTransportNote(source: string): string | null {
  if (source === "all") {
    return "Toutes les sources inclut Petites Affiches et Cessions État, téléchargées via Supabase. Un seul lancement suffit.";
  }
  if (CLOUD_COLLECTION_SOURCES.some((item) => item === source)) {
    return "Les pages de cette source sont téléchargées via Supabase, puis extraites et intégrées par le collecteur. Le résultat apparaît dans cette même exécution.";
  }
  return null;
}

export function collectionSourceResults(summary: Record<string, unknown>) {
  const coverage = summary.scrape_coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) return [];
  return Object.entries(coverage).flatMap(([source, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    return [
      {
        source,
        transport:
          row.fetch_transport === "supabase"
            ? "Supabase"
            : row.fetch_transport === "direct"
              ? "Direct"
              : "Non renseigné",
        listings: typeof row.listings_emitted === "number" ? row.listings_emitted : null,
        failed: typeof row.errors === "number" && row.errors > 0,
      },
    ];
  });
}
