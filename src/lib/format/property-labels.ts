export function occupancyLabel(status: string | null | undefined): string {
  if (!status) return "Non renseigné";
  const s = status.toLowerCase();
  if (s === "unknown" || s === "inconnu") return "À confirmer";
  if (s.includes("libre") || s === "vacant" || s === "free") return "Libre";
  if (s.includes("occup")) return "Occupé";
  if (s.includes("loué") || s.includes("loue") || s.includes("rented")) return "Loué";
  return status;
}

export function propertyTypeLabel(t: string | null | undefined): string {
  if (!t) return "Bien";
  const s = t.toLowerCase();
  if (s === "unknown" || s === "other") return "Bien à qualifier";
  if (s.includes("apart") || s.includes("apt")) return "Appartement";
  if (s === "studio" || s.includes("studio")) return "Appartement";
  if (s.includes("house") || s.includes("maison")) return "Maison";
  if (s.includes("building") || s.includes("immeuble")) return "Immeuble";
  if (s.includes("land") || s.includes("terrain")) return "Terrain";
  if (s.includes("garage") || s.includes("park")) return "Garage / Parking";
  if (s.includes("commerce") || s.includes("commercial") || s.includes("local")) {
    return "Local commercial";
  }
  return t;
}

export function saleStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  const s = status.toLowerCase();
  const labels: Record<string, string> = {
    upcoming: "Vente à venir",
    active: "Vente active",
    unknown: "Statut à confirmer",
    past: "Vente passée",
    adjudicated: "Adjugée",
    postponed: "Vente reportée",
    cancelled: "Annulée",
    withdrawn: "Retirée",
  };
  return labels[s] ?? status;
}

export function surfaceSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  const s = source.toLowerCase();
  const labels: Record<string, string> = {
    llm: "extraction documentaire",
    llm_extraction: "extraction documentaire",
    pdf: "document PDF",
    document: "document PDF",
    docling: "extraction PDF",
    source_listing: "page de l'annonce",
    listing: "page de l'annonce",
    surface_m2_fallback: "surface déclarée",
    built_surface_text: "texte du dossier",
    habitable_surface_m2: "surface habitable",
    carrez_surface_m2: "surface Carrez",
    land_surface_m2: "surface terrain",
  };
  return labels[s] ?? source.replaceAll("_", " ");
}
