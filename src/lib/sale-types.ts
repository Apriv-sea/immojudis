import type { SaleVenueType } from "@/lib/types";

// A participation channel (such as online) is not a family of sales.
export const SALE_TYPE_OPTIONS = [
  { value: "tribunal", label: "Au tribunal" },
  { value: "notary", label: "Chez le notaire" },
  { value: "state", label: "Domaniales" },
  { value: "unknown", label: "À préciser" },
] as const;

export type SaleTypeFilter = (typeof SALE_TYPE_OPTIONS)[number]["value"];

export function parseSaleType(value: unknown): SaleTypeFilter | undefined {
  return SALE_TYPE_OPTIONS.find((option) => option.value === value)?.value;
}

export function saleTypeFilterLabel(value: SaleTypeFilter): string {
  return SALE_TYPE_OPTIONS.find((option) => option.value === value)!.label;
}

export function saleVenueMatchesType(venue: SaleVenueType, filter: SaleTypeFilter): boolean {
  return filter === "unknown" ? venue === "unknown" || venue === "online" : venue === filter;
}

export const SALE_FAMILIES = [
  {
    type: "tribunal",
    title: "Au tribunal",
    subtitle: "Les enchères judiciaires à la barre",
    description:
      "La vente se tient devant le tribunal, notamment après une saisie ou un partage judiciaire.",
    participation: "Un avocat du barreau compétent porte vos enchères.",
    nextStep: "Repérez le tribunal et contactez un avocat avant la vente.",
    linkLabel: "Voir les ventes au tribunal",
  },
  {
    type: "notary",
    title: "Chez le notaire",
    subtitle: "Les enchères notariales",
    description:
      "Le notaire organise la vente. Elle peut être volontaire ou avoir une origine judiciaire.",
    participation:
      "Les conditions de vente précisent l’inscription, les garanties et la façon d’enchérir.",
    nextStep: "Contactez l’office notarial pour connaître les modalités du dossier.",
    linkLabel: "Voir les ventes notariales",
  },
  {
    type: "state",
    title: "Ventes domaniales",
    subtitle: "Les ventes de biens de l’État",
    description:
      "L’État cède des biens selon différentes procédures : enchères, appel d’offres ou vente amiable.",
    participation: "Ce ne sont pas nécessairement des ventes judiciaires ni des enchères.",
    nextStep: "Consultez la procédure et les conditions publiées par l’organisme vendeur.",
    linkLabel: "Voir les ventes domaniales référencées",
  },
] as const;
