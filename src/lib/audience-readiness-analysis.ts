import type { AuctionCostAnalysis } from "@/lib/auction-cost-analysis";
import type { LegalAttentionAnalysis } from "@/lib/legal-attention-analysis";
import type { OccupancyAnalysis } from "@/lib/occupation-analysis";
import type { RenovationAnalysis } from "@/lib/renovation-analysis";
import type { AuctionSale, SaleDocumentRich } from "@/lib/types";

export type AudienceReadinessStatus = "ready" | "needs_work" | "urgent" | "missing_date" | "past";

export type AudienceReadinessItemStatus = "done" | "to_do" | "watch";
export type AudienceReadinessPriority = "high" | "medium" | "low";

export type AudienceReadinessItem = {
  key: string;
  label: string;
  status: AudienceReadinessItemStatus;
  priority: AudienceReadinessPriority;
  source: string;
  detail: string;
  action: string;
};

export type AudienceReadinessAnalysis = {
  available: boolean;
  status: AudienceReadinessStatus;
  label: string;
  urgency: "past" | "today" | "week" | "month" | "later" | "unknown";
  urgencyLabel: string;
  daysUntilAudience: number | null;
  audienceDate: string | null;
  visitDates: string[];
  progressPct: number;
  doneCount: number;
  totalCount: number;
  highPriorityOpenCount: number;
  checklist: AudienceReadinessItem[];
  summary: string;
  decisionImpact: string;
  nextActions: string[];
  limitations: string[];
};

import { publishedDay, sourceVisitExcerpt, visitHasPassed } from "./listing-evidence";
import { safeDocumentUrl } from "./documents";

export function buildAudienceReadinessAnalysis({
  sale,
  documents,
  auctionCostAnalysis,
  occupancyAnalysis,
  renovationAnalysis,
  legalAttentionAnalysis,
  bidCeilingAvailable,
  now = new Date(),
}: {
  sale: AuctionSale;
  documents: SaleDocumentRich[];
  auctionCostAnalysis: AuctionCostAnalysis;
  occupancyAnalysis: OccupancyAnalysis;
  renovationAnalysis: RenovationAnalysis;
  legalAttentionAnalysis: LegalAttentionAnalysis;
  bidCeilingAvailable: boolean;
  now?: Date;
}): AudienceReadinessAnalysis {
  const audienceDate = parseDate(sale.sale_date);
  const daysUntilAudience = daysUntil(audienceDate, now);
  const visitDates = normalizeVisitDates(sale);
  const checklist = buildChecklist({
    sale,
    documents,
    auctionCostAnalysis,
    occupancyAnalysis,
    renovationAnalysis,
    legalAttentionAnalysis,
    bidCeilingAvailable,
    audienceDate,
    daysUntilAudience,
    visitDates,
    now,
  });
  const totalCount = checklist.length;
  const doneCount = checklist.filter((item) => item.status === "done").length;
  const highPriorityOpenCount = checklist.filter(
    (item) => item.priority === "high" && item.status !== "done",
  ).length;
  const progressPct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
  const status = resolveStatus({
    audienceDate,
    daysUntilAudience,
    progressPct,
    highPriorityOpenCount,
  });
  const urgency = resolveUrgency({ audienceDate, daysUntilAudience });

  return {
    available: true,
    status,
    label: statusLabel(status),
    urgency,
    urgencyLabel: urgencyLabel(urgency, daysUntilAudience),
    daysUntilAudience,
    audienceDate: sale.sale_date,
    visitDates,
    progressPct,
    doneCount,
    totalCount,
    highPriorityOpenCount,
    checklist,
    summary: summary({ status, progressPct, doneCount, totalCount, highPriorityOpenCount }),
    decisionImpact: decisionImpact(status),
    nextActions: nextActions(checklist, status),
    limitations: [
      "Cette préparation est déduite des données du dossier ; elle ne confirme pas que l'utilisateur a réellement accompli chaque action.",
      "Les modalités d'audience, de consignation et de paiement doivent être confirmées dans les pièces officielles ou auprès du conseil.",
    ],
  };
}

function buildChecklist({
  sale,
  documents,
  auctionCostAnalysis,
  occupancyAnalysis,
  renovationAnalysis,
  legalAttentionAnalysis,
  bidCeilingAvailable,
  audienceDate,
  daysUntilAudience,
  visitDates,
  now,
}: {
  sale: AuctionSale;
  documents: SaleDocumentRich[];
  auctionCostAnalysis: AuctionCostAnalysis;
  occupancyAnalysis: OccupancyAnalysis;
  renovationAnalysis: RenovationAnalysis;
  legalAttentionAnalysis: LegalAttentionAnalysis;
  bidCeilingAvailable: boolean;
  audienceDate: Date | null;
  daysUntilAudience: number | null;
  visitDates: string[];
  now: Date;
}): AudienceReadinessItem[] {
  const hasConditions = hasDocument(documents, /cahier|conditions/i);
  const hasDescriptiveReport = hasDocument(documents, /pv|descriptif|commissaire|huissier/i);
  const hasDiagnostics = hasDocument(documents, /diagnostic|dpe|amiante|plomb|termite/i);
  const currentVisits = visitDates.filter(
    (value) => publishedDay(value) && !visitHasPassed(value, now),
  );
  const pastVisits = visitDates.filter((value) => visitHasPassed(value, now));

  return [
    {
      key: "audience_date",
      label: "Date d'audience",
      status: !audienceDate
        ? "to_do"
        : daysUntilAudience != null && daysUntilAudience < 0
          ? "watch"
          : "done",
      priority: "high",
      source: "Annonce",
      detail: audienceDate
        ? daysUntilAudience != null && daysUntilAudience < 0
          ? "Date d'audience passée ou à requalifier."
          : "Date d'audience renseignée."
        : "Date d'audience absente ou illisible.",
      action: audienceDate
        ? "Confirmer date, heure et lieu d'audience."
        : "Renseigner la date d'audience avant de suivre le dossier.",
    },
    {
      key: "visits",
      label: "Visite ou accès au bien",
      status: currentVisits.length ? "done" : visitDates.length ? "watch" : "to_do",
      priority: "medium",
      source: "Annonce et sources",
      detail: currentVisits.length
        ? `${currentVisits.length} créneau(x) daté(s) encore à venir ou aujourd’hui. La présence à la visite n’est pas confirmée.`
        : pastVisits.length
          ? "Les créneaux datés repérés sont passés. Aucun nouveau rendez-vous confirmé."
          : "Aucun créneau de visite daté exploitable.",
      action: currentVisits.length
        ? "Vérifier présence, horaires et modalités d'inscription à la visite."
        : "Demander à l’organisateur si un nouvel accès au bien est possible.",
    },
    {
      key: "consignation",
      label: "Consignation",
      status: auctionCostAnalysis.consignation ? "done" : "to_do",
      priority: "high",
      source: "Analyse frais",
      detail: auctionCostAnalysis.consignation
        ? `Montant repéré : ${formatMoney(auctionCostAnalysis.consignation.amountEur)}.`
        : "Montant, bénéficiaire ou forme de consignation non confirmés.",
      action: auctionCostAnalysis.consignation
        ? "Contrôler forme de paiement, bénéficiaire et délai de remise."
        : "Identifier la consignation exigée avant audience.",
    },
    {
      key: "conditions",
      label: "Cahier des conditions",
      status: hasConditions ? "done" : "to_do",
      priority: "high",
      source: "Pièces du dossier",
      detail: hasConditions ? "Pièce repérée." : "Pièce centrale non repérée.",
      action: hasConditions
        ? "Relire clauses particulières, frais, paiement et surenchère."
        : "Récupérer le cahier des conditions avant de figer le plafond.",
    },
    {
      key: "descriptive_report",
      label: "PV descriptif",
      status: hasDescriptiveReport ? "done" : "to_do",
      priority: "medium",
      source: "Pièces du dossier",
      detail: hasDescriptiveReport
        ? "PV ou constat repéré."
        : "PV descriptif ou constat non repéré.",
      action: hasDescriptiveReport
        ? "Relire état, occupation, accès et équipements visibles."
        : "Récupérer le PV descriptif pour qualifier état et occupation.",
    },
    {
      key: "diagnostics",
      label: "Diagnostics techniques",
      status: hasDiagnostics ? "done" : "to_do",
      priority: "medium",
      source: "Pièces du dossier",
      detail: hasDiagnostics ? "Diagnostics repérés." : "Diagnostics non qualifiés.",
      action: hasDiagnostics
        ? "Reporter les points techniques dans le budget travaux."
        : "Rechercher DPE, amiante, plomb, termites et diagnostics utiles.",
    },
    {
      key: "occupation",
      label: "Occupation",
      status:
        occupancyAnalysis.status === "free" ||
        occupancyAnalysis.status === "occupied" ||
        occupancyAnalysis.status === "rented"
          ? "done"
          : occupancyAnalysis.status === "conflicting"
            ? "watch"
            : "to_do",
      priority: "high",
      source: "Analyse occupation",
      detail: occupancyAnalysis.summary,
      action: occupancyAnalysis.nextActions[0] ?? "Qualifier l'occupation exacte avant audience.",
    },
    {
      key: "works_budget",
      label: "Travaux et état",
      status:
        renovationAnalysis.status === "unknown"
          ? "to_do"
          : renovationAnalysis.status === "heavy_works"
            ? "watch"
            : "done",
      priority: renovationAnalysis.priority === "high" ? "high" : "medium",
      source: "Analyse travaux",
      detail: renovationAnalysis.summary,
      action:
        renovationAnalysis.nextActions[0] ??
        "Transformer les travaux en enveloppe basse, médiane et haute.",
    },
    {
      key: "bid_ceiling",
      label: "Mise maximale",
      status: bidCeilingAvailable ? "done" : "to_do",
      priority: "high",
      source: "Calcul de plafond",
      detail: bidCeilingAvailable
        ? "Plafond calculable dans le rapport."
        : "Plafond indisponible avec les données actuelles.",
      action: bidCeilingAvailable
        ? "Tester le plafond avec plusieurs hypothèses de travaux et frais."
        : "Compléter marché, surface, frais et travaux pour calculer le plafond.",
    },
    {
      key: "legal_review",
      label: "Points juridiques",
      status: legalAttentionAnalysis.priority === "low" ? "done" : "watch",
      priority: legalAttentionAnalysis.priority === "high" ? "high" : "medium",
      source: "Revue juridique",
      detail: legalAttentionAnalysis.summary,
      action:
        legalAttentionAnalysis.nextActions[0] ??
        "Relire les pièces officielles et faire confirmer les points sensibles.",
    },
  ];
}

function resolveStatus({
  audienceDate,
  daysUntilAudience,
  progressPct,
  highPriorityOpenCount,
}: {
  audienceDate: Date | null;
  daysUntilAudience: number | null;
  progressPct: number;
  highPriorityOpenCount: number;
}): AudienceReadinessStatus {
  if (!audienceDate) return "missing_date";
  if (daysUntilAudience != null && daysUntilAudience < 0) return "past";
  if (daysUntilAudience != null && daysUntilAudience <= 7 && highPriorityOpenCount > 0) {
    return "urgent";
  }
  if (daysUntilAudience != null && daysUntilAudience <= 2) return "urgent";
  if (highPriorityOpenCount === 0 && progressPct >= 70) return "ready";
  return "needs_work";
}

function resolveUrgency({
  audienceDate,
  daysUntilAudience,
}: {
  audienceDate: Date | null;
  daysUntilAudience: number | null;
}): AudienceReadinessAnalysis["urgency"] {
  if (!audienceDate || daysUntilAudience == null) return "unknown";
  if (daysUntilAudience < 0) return "past";
  if (daysUntilAudience === 0) return "today";
  if (daysUntilAudience <= 7) return "week";
  if (daysUntilAudience <= 30) return "month";
  return "later";
}

function statusLabel(status: AudienceReadinessStatus): string {
  const labels: Record<AudienceReadinessStatus, string> = {
    ready: "Préparation avancée",
    needs_work: "Préparation à compléter",
    urgent: "Préparation urgente",
    missing_date: "Audience à dater",
    past: "Audience passée ou à requalifier",
  };
  return labels[status];
}

function urgencyLabel(urgency: AudienceReadinessAnalysis["urgency"], days: number | null): string {
  if (urgency === "past") return "Audience passée";
  if (urgency === "today") return "Audience aujourd'hui";
  if (urgency === "week") return `${days} jour(s) avant audience`;
  if (urgency === "month") return `${days} jour(s) avant audience`;
  if (urgency === "later") return `${days} jour(s) avant audience`;
  return "Date d'audience à confirmer";
}

function summary({
  status,
  progressPct,
  doneCount,
  totalCount,
  highPriorityOpenCount,
}: {
  status: AudienceReadinessStatus;
  progressPct: number;
  doneCount: number;
  totalCount: number;
  highPriorityOpenCount: number;
}): string {
  const open = highPriorityOpenCount
    ? ` · ${highPriorityOpenCount} point(s) prioritaire(s) ouvert(s)`
    : "";
  return `${statusLabel(status)} · ${doneCount}/${totalCount} élément(s) renseigné(s) (${progressPct} %)${open}.`;
}

function decisionImpact(status: AudienceReadinessStatus): string {
  if (status === "ready") {
    return "Le dossier semble suffisamment cadré pour arbitrer la stratégie d'enchère, sous réserve de confirmation des pièces.";
  }
  if (status === "urgent") {
    return "Ne pas déposer de consignation sans traiter les points prioritaires restants.";
  }
  if (status === "missing_date") {
    return "Le suivi d'audience et les rappels ne sont pas fiables sans date stabilisée.";
  }
  if (status === "past") {
    return "Vérifier si la vente est reportée, adjugée ou à sortir du suivi actif.";
  }
  return "Les points ouverts peuvent modifier le plafond, le calendrier ou la capacité à enchérir.";
}

function nextActions(
  checklist: AudienceReadinessItem[],
  status: AudienceReadinessStatus,
): string[] {
  const urgent = checklist
    .filter((item) => item.status !== "done" && item.priority === "high")
    .map((item) => item.action);
  const medium = checklist
    .filter((item) => item.status !== "done" && item.priority === "medium")
    .map((item) => item.action);
  const actions = [...urgent, ...medium];
  if (!actions.length && status === "ready") {
    actions.push(
      "Planifier un dernier contrôle des pièces et de la consignation avant l'audience.",
    );
  }
  return dedupeStrings(actions).slice(0, 5);
}

function normalizeVisitDates(sale: AuctionSale): string[] {
  const sourceVisit = sourceVisitExcerpt(sale);
  const values = [
    ...primitiveTexts(sale.visit_dates),
    ...(sourceVisit ? [sourceVisit] : []),
    ...sourceBlockTexts(sale.source_blocks, /visite|visit/i),
    ...Object.values(sale.source_blocks_by_source ?? {}).flatMap((blocks) =>
      sourceBlockTexts(blocks, /visite|visit/i),
    ),
  ];
  return dedupeStrings(values).slice(0, 6);
}

function sourceBlockTexts(blocks: Record<string, unknown> | null, keyPattern: RegExp): string[] {
  if (!blocks) return [];
  return Object.entries(blocks)
    .filter(([key]) => keyPattern.test(key))
    .flatMap(([, value]) => primitiveTexts(value));
}

function primitiveTexts(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) return value.flatMap(primitiveTexts);
  return [];
}

function hasDocument(documents: SaleDocumentRich[], pattern: RegExp): boolean {
  return documents.some(
    (document) =>
      Boolean(safeDocumentUrl(document.url)) &&
      pattern.test(
        `${document.type ?? ""} ${document.document_type ?? ""} ${document.label ?? ""}`,
      ),
  );
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function daysUntil(date: Date | null, now: Date): number | null {
  if (!date || !Number.isFinite(now.getTime())) return null;
  const calendarDay = (value: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value);
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"));
  };
  return (calendarDay(date) - calendarDay(now)) / (24 * 60 * 60 * 1000);
}

function formatMoney(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value)} €`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
