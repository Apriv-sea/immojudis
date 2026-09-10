import { formatPrice, propertyTypeLabel } from "@/lib/format";
import { isActiveComparableSale } from "@/lib/sale-window";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

export type ActiveComparableItem = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  propertyType: string | null;
  saleDate: string | null;
  startingPriceEur: number | null;
  surfaceM2: number | null;
  pricePerM2: number | null;
  investmentScore: number | null;
  status: string | null;
  matchScore: number;
  matchLabel: string;
  reasons: string[];
};

export type ActiveComparablesAnalysis = {
  available: boolean;
  status: "matched" | "candidates_only" | "missing";
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  scopeLabel: string;
  items: ActiveComparableItem[];
  summary: string;
  decisionImpact: string;
  nextActions: string[];
  limitations: string[];
};

export function buildActiveComparablesAnalysis({
  sale,
  candidates,
  scopeLabel,
  now = new Date(),
}: {
  sale: AuctionSale;
  candidates: AuctionSale[];
  scopeLabel: string;
  now?: Date;
}): ActiveComparablesAnalysis {
  const items = candidates
    .filter(
      (candidate) =>
        candidate.id && candidate.id !== sale.id && isActiveComparableSale(candidate, now),
    )
    .map((candidate) => comparableItem({ sale, candidate, now }))
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 8);
  const strongMatches = items.filter((item) => item.matchScore >= 70);
  const status = items.length ? (strongMatches.length ? "matched" : "candidates_only") : "missing";
  const confidence = confidenceForStatus({ status, items, strongMatches });

  return {
    available: items.length > 0,
    status,
    confidence,
    confidenceLabel: confidenceLabel({ status, confidence }),
    scopeLabel,
    items,
    summary: summary({ items, strongMatches, scopeLabel }),
    decisionImpact: decisionImpact(status),
    nextActions: nextActions({ status, items }),
    limitations: limitations(status),
  };
}

function comparableItem({
  sale,
  candidate,
  now,
}: {
  sale: AuctionSale;
  candidate: AuctionSale;
  now: Date;
}): ActiveComparableItem {
  const saleSurface = getSaleSurface(sale).value;
  const candidateSurface = getSaleSurface(candidate).value;
  const price = positiveNumber(candidate.starting_price_eur);
  const pricePerM2 =
    price != null && candidateSurface != null && candidateSurface > 0
      ? Math.round(price / candidateSurface)
      : null;
  const match = scoreCandidate({ sale, candidate, saleSurface, candidateSurface, now });

  return {
    id: candidate.id,
    title: candidate.title,
    city: candidate.city,
    department: candidate.department,
    propertyType: candidate.property_type,
    saleDate: candidate.sale_date,
    startingPriceEur: price,
    surfaceM2: candidateSurface,
    pricePerM2,
    investmentScore:
      typeof candidate.investment_score === "number" ? candidate.investment_score : null,
    status: candidate.status,
    matchScore: match.score,
    matchLabel: matchLabel(match.score),
    reasons: match.reasons,
  };
}

function scoreCandidate({
  sale,
  candidate,
  saleSurface,
  candidateSurface,
  now,
}: {
  sale: AuctionSale;
  candidate: AuctionSale;
  saleSurface: number | null;
  candidateSurface: number | null;
  now: Date;
}): { score: number; reasons: string[] } {
  let score = 35;
  const reasons: string[] = [];

  if (sale.property_type && candidate.property_type === sale.property_type) {
    score += 18;
    reasons.push(`Même type : ${propertyTypeLabel(candidate.property_type)}`);
  }
  if (sale.city && candidate.city === sale.city) {
    score += 18;
    reasons.push(`Même ville : ${candidate.city}`);
  } else if (sale.department && candidate.department === sale.department) {
    score += 10;
    reasons.push(`Même département : ${candidate.department}`);
  }
  const surfaceGap = relativeGap(saleSurface, candidateSurface);
  if (surfaceGap != null) {
    if (surfaceGap <= 0.15) {
      score += 15;
      reasons.push("Surface très proche");
    } else if (surfaceGap <= 0.3) {
      score += 10;
      reasons.push("Surface comparable");
    } else if (surfaceGap > 0.6) {
      score -= 10;
      reasons.push("Surface éloignée");
    }
  }
  const priceGap = relativeGap(sale.starting_price_eur, candidate.starting_price_eur);
  if (priceGap != null) {
    if (priceGap <= 0.2) {
      score += 10;
      reasons.push("Mise à prix proche");
    } else if (priceGap > 0.7) {
      score -= 8;
      reasons.push("Mise à prix éloignée");
    }
  }
  if (isFutureSale(candidate.sale_date, now)) {
    score += 8;
    reasons.push("Audience à venir");
  }
  if (typeof candidate.investment_score === "number") {
    if (candidate.investment_score >= 70) {
      score += 6;
      reasons.push("Score opportunité élevé");
    } else if (candidate.investment_score < 45) {
      score -= 4;
      reasons.push("Score opportunité faible");
    }
  }

  if (!sale.property_type || candidate.property_type !== sale.property_type) {
    reasons.unshift("Type de bien différent ou non confirmé");
    score = Math.min(score, 69);
  }
  const sameArea = Boolean(
    (sale.city && candidate.city === sale.city) ||
    (sale.department && candidate.department === sale.department),
  );
  if (!sameArea) {
    reasons.unshift("Hors du secteur géographique confirmé : référence locale à vérifier");
    score = Math.min(score, 69);
  }
  return { score: clamp(score), reasons: reasons.slice(0, 5) };
}

function confidenceForStatus({
  status,
  items,
  strongMatches,
}: {
  status: ActiveComparablesAnalysis["status"];
  items: ActiveComparableItem[];
  strongMatches: ActiveComparableItem[];
}): ActiveComparablesAnalysis["confidence"] {
  if (status !== "matched") return "low";
  if (strongMatches.length >= 3) return "high";
  if (items.length >= 2) return "medium";
  return "low";
}

function confidenceLabel({
  status,
  confidence,
}: {
  status: ActiveComparablesAnalysis["status"];
  confidence: ActiveComparablesAnalysis["confidence"];
}): string {
  if (status === "matched" && confidence === "high") return "Plusieurs biens actifs proches";
  if (status === "matched") return "Biens actifs comparables repérés";
  if (status === "candidates_only") return "Candidats actifs à filtrer";
  return "Aucun comparable actif exploitable";
}

function summary({
  items,
  strongMatches,
  scopeLabel,
}: {
  items: ActiveComparableItem[];
  strongMatches: ActiveComparableItem[];
  scopeLabel: string;
}): string {
  if (!items.length) return "Aucun bien comparable en vente repéré dans le périmètre actuel.";
  if (!strongMatches.length) {
    return `${items.length} candidat(s) dans "${scopeLabel}". Aucun bien retenu selon les critères de comparaison ; aucune référence recommandée.`;
  }
  const best = strongMatches[0];
  const price = best.startingPriceEur != null ? `, ${formatPrice(best.startingPriceEur)}` : "";
  return `${items.length} bien(s) actif(s) dans "${scopeLabel}", dont ${strongMatches.length} retenu(s) selon les critères de comparaison. Meilleur candidat : ${best.matchLabel}${price}.`;
}

function decisionImpact(status: ActiveComparablesAnalysis["status"]): string {
  if (status === "matched") {
    return "Comparer ces ventes actives permet d'arbitrer rareté, concurrence et priorité de l'audience.";
  }
  if (status === "candidates_only") {
    return "Les candidats donnent un contexte d'offre, mais leur comparabilité doit être filtrée avant décision.";
  }
  return "Sans comparable actif, l'arbitrage repose surtout sur DVF, risques et plafond de mise.";
}

function nextActions({
  status,
  items,
}: {
  status: ActiveComparablesAnalysis["status"];
  items: ActiveComparableItem[];
}): string[] {
  if (status === "missing") {
    return [
      "Élargir le périmètre de recherche aux ventes du département ou du tribunal.",
      "Comparer avec les ventes DVF vendues si aucune audience active proche n'existe.",
    ];
  }
  if (status === "candidates_only") {
    return [
      "Rechercher des biens de même type dans le secteur du bien étudié.",
      "Vérifier localisation, surface, état et occupation avant de retenir un candidat.",
      "Ne pas utiliser les candidats non retenus comme références de valeur.",
    ];
  }
  const actions = [
    "Ouvrir les meilleurs matches pour comparer pièces, occupation, travaux et frais.",
    "Comparer les mises à prix au m² avec le plafond calculé du bien étudié.",
  ];
  if (items.some((item) => item.saleDate)) {
    actions.push("Prioriser les audiences selon date, consignation et niveau d'opportunité.");
  }
  return actions;
}

function limitations(status: ActiveComparablesAnalysis["status"]): string[] {
  const items = [
    "Les biens actifs ne sont pas des ventes réalisées : ils indiquent l'offre disponible, pas la valeur de marché finale.",
    "La comparabilité dépend des pièces, de l'état, de l'occupation et des frais, pas seulement du type ou de la surface.",
  ];
  if (status !== "matched") {
    items.unshift(
      "Le périmètre actif ne contient pas encore assez de biens proches pour conclure.",
    );
  }
  return items;
}

function matchLabel(score: number): string {
  if (score >= 80) return "Très comparable";
  if (score >= 70) return "Comparable";
  if (score >= 55) return "À filtrer";
  return "Éloigné";
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function relativeGap(a: unknown, b: unknown): number | null {
  const left = positiveNumber(a);
  const right = positiveNumber(b);
  if (left == null || right == null) return null;
  return Math.abs(left - right) / Math.max(left, right);
}

function isFutureSale(value: string | null, now: Date): boolean {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() >= now.getTime();
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
