export function documentTypeLabel(type: string | null | undefined): string {
  if (!type) return "Document";
  const s = type.toLowerCase();
  const labels: Record<string, string> = {
    source_listing: "Page de l'annonce",
    annonce_vente: "Annonce / insertion",
    pv_huissier: "PV de commissaire de justice",
    pv_descriptif: "PV descriptif",
    pv_notaire: "PV de notaire",
    proces_verbal: "Procès-verbal",
    cahier_conditions_vente: "Cahier des conditions",
    cahier_conditions: "Cahier des conditions",
    conditions_vente: "Conditions de vente",
    diagnostics_techniques: "Diagnostics techniques",
    diagnostics: "Diagnostics techniques",
    bail: "Bail / occupation",
    procedure_saisie: "Procédure de saisie",
    cadastre: "Cadastre / plan",
    pdf: "Document PDF",
  };
  return labels[s] ?? type.replaceAll("_", " ");
}

export function documentTypeHelp(type: string | null | undefined): string {
  if (!type) return "Document source utilisé comme indice, à relire avant de décider.";
  const s = type.toLowerCase();
  const descriptions: Record<string, string> = {
    source_listing:
      "Page de l'annonce : utile pour les informations commerciales, mais moins probante qu'un acte ou un diagnostic.",
    annonce_vente:
      "Annonce ou insertion : bonne source de contexte, à confirmer dans les pièces officielles.",
    pv_huissier:
      "PV de commissaire de justice : décrit ce qui a été constaté sur place, souvent très utile pour l'état réel et l'occupation.",
    pv_descriptif:
      "PV descriptif : pièce centrale pour comprendre l'état, l'occupation et les éléments visibles du bien.",
    pv_notaire:
      "PV de notaire : source juridique utile pour les conditions et éléments officiels de la vente.",
    proces_verbal:
      "Procès-verbal : document de constat ou de procédure, à lire avec son contexte exact.",
    cahier_conditions_vente:
      "Cahier des conditions de vente : pièce clé pour les règles de vente, charges, servitudes et contraintes juridiques.",
    cahier_conditions:
      "Cahier des conditions de vente : pièce clé pour les règles de vente, charges, servitudes et contraintes juridiques.",
    conditions_vente:
      "Conditions de vente : précise les règles, frais et obligations liés à l'adjudication.",
    diagnostics_techniques:
      "Diagnostics techniques : source prioritaire pour amiante, plomb, DPE, termites et autres risques réglementaires.",
    diagnostics:
      "Diagnostics techniques : source prioritaire pour amiante, plomb, DPE, termites et autres risques réglementaires.",
    bail: "Bail ou pièce d'occupation : utile pour comprendre qui occupe le bien, à quelles conditions et avec quel impact locatif.",
    procedure_saisie:
      "Procédure de saisie : document de contexte juridique, pas toujours directement lié à l'état du bien.",
    cadastre:
      "Cadastre ou plan : utile pour la parcelle, les accès et le périmètre, mais ne suffit pas pour qualifier un risque.",
    pdf: "Document PDF : source documentaire importée, à qualifier selon son contenu exact.",
  };
  return (
    descriptions[s] ??
    "Document source utilisé comme indice, à relire dans son contexte avant de décider."
  );
}
