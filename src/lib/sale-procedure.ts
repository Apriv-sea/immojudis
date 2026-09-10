import { z } from "zod";
import { formatPrice } from "@/lib/format";
import type {
  AuctionSale,
  SaleLegalFramework,
  SaleVenueType,
  SaleVerificationStatus,
} from "@/lib/types";

const venueTypeSchema = z.enum(["tribunal", "notary", "state", "online", "unknown"]);
const legalFrameworkSchema = z.enum([
  "judicial_seizure",
  "judicial_partition",
  "insolvency",
  "voluntary_notarial",
  "state_sale",
  "unknown",
]);
const verificationStatusSchema = z.enum(["verified", "cross_checked", "pending", "conflict"]);
const nullableNumber = z.number().finite().nonnegative().nullable();

const sourceSchema = z
  .object({
    kind: z.string().optional(),
    label: z.string().optional(),
    source_name: z.string().optional(),
    url: z.string().nullable().optional(),
    checked_at: z.string().nullable().optional(),
    document_type: z.string().nullable().optional(),
  })
  .passthrough();

const factSchema = z
  .object({
    key: z.string(),
    value: z.unknown(),
    status: verificationStatusSchema,
    evidence: z.array(z.string()).default([]),
    source_url: z.string().nullable().optional(),
  })
  .passthrough();

export const saleProcedureSchema = z
  .object({
    schema_version: z.literal("sale_procedure_v1"),
    ruleset_version: z.string().min(1),
    venue_type: venueTypeSchema,
    legal_framework: legalFrameworkSchema,
    venue_name: z.string().nullable(),
    venue_address: z.string().nullable(),
    participation_mode: z.enum(["in_person", "online", "hybrid", "unknown"]),
    organizer_name: z.string().nullable(),
    organizer_type: z.string(),
    organizer_contact: z.string().nullable(),
    eligible_bar: z.string().nullable(),
    rules: z
      .object({
        lawyer_required: z.boolean().nullable(),
        lawyer_note: z.string(),
        bid_method: z.string(),
        guarantee: z
          .object({
            amount_eur: nullableNumber,
            rate_pct: nullableNumber,
            minimum_eur: nullableNumber,
            status: z.string(),
            note: z.string(),
          })
          .passthrough(),
        financing_condition: z.boolean().nullable(),
        cooling_off_period: z.boolean().nullable(),
        payment_deadline_days: z.number().int().positive().nullable(),
        overbid: z
          .object({
            allowed: z.boolean().nullable(),
            minimum_increase_pct: nullableNumber,
            window_days: z.number().int().positive().nullable(),
            note: z.string(),
          })
          .passthrough(),
      })
      .passthrough(),
    verification: z
      .object({
        status: verificationStatusSchema,
        verified_at: z.string().nullable(),
        case_source_count: z.number().int().nonnegative(),
        case_sources: z.array(sourceSchema),
        regulatory_sources: z.array(sourceSchema),
        facts: z.array(factSchema),
        issues: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough();

export type SaleProcedure = z.infer<typeof saleProcedureSchema>;
export type SaleProcedureSource = z.infer<typeof sourceSchema>;

export type SaleProcedurePresentation = {
  procedure: SaleProcedure | null;
  venueType: SaleVenueType;
  legalFramework: SaleLegalFramework;
  verificationStatus: SaleVerificationStatus;
  verifiedAt: string | null;
  venueName: string | null;
  venueAddress: string | null;
  organizerName: string | null;
  organizerContact: string | null;
  eligibleBar: string | null;
  participationMode: "in_person" | "online" | "hybrid" | "unknown";
  lawyerRequired: boolean | null;
  lawyerNote: string;
  guaranteeAmountEur: number | null;
  guaranteeRatePct: number | null;
  guaranteeMinimumEur: number | null;
  guaranteeNote: string;
  financingCondition: boolean | null;
  coolingOffPeriod: boolean | null;
  paymentDeadlineDays: number | null;
  overbidAllowed: boolean | null;
  overbidMinimumIncreasePct: number | null;
  overbidWindowDays: number | null;
  overbidNote: string;
  sources: SaleProcedureSource[];
  issues: string[];
};

export function getSaleProcedure(sale: AuctionSale): SaleProcedurePresentation {
  const embedded = embeddedProcedure(sale);
  const parsed = saleProcedureSchema.safeParse(embedded);
  const procedure = parsed.success ? parsed.data : null;
  const venueType =
    procedure?.venue_type ?? parseVenueType(sale.sale_venue_type) ?? legacyVenueType(sale);
  const legalFramework =
    procedure?.legal_framework ?? parseLegalFramework(sale.sale_legal_framework) ?? "unknown";
  const verificationStatus =
    procedure?.verification.status ??
    parseVerificationStatus(sale.sale_verification_status) ??
    "pending";
  const venueIsConfirmed =
    verificationStatus === "verified" || verificationStatus === "cross_checked";
  const rules = procedure?.rules;

  return {
    procedure,
    venueType,
    legalFramework,
    verificationStatus,
    verifiedAt: procedure?.verification.verified_at ?? null,
    venueName:
      procedure?.venue_name ??
      (venueType === "tribunal"
        ? (sale.tribunal_name ?? sale.tribunal)
        : venueType === "notary"
          ? sale.lawyer_name
          : null),
    venueAddress: procedure?.venue_address ?? null,
    organizerName: procedure?.organizer_name ?? sale.lawyer_name,
    organizerContact: procedure?.organizer_contact ?? sale.lawyer_contact,
    eligibleBar:
      procedure?.eligible_bar ?? (venueType === "tribunal" ? legacyEligibleBar(sale) : null),
    participationMode:
      procedure?.participation_mode ??
      (venueType === "online"
        ? "online"
        : venueType === "tribunal" && venueIsConfirmed
          ? "in_person"
          : "unknown"),
    lawyerRequired:
      rules?.lawyer_required ?? (venueType === "tribunal" && venueIsConfirmed ? true : null),
    lawyerNote:
      rules?.lawyer_note ??
      (venueType === "tribunal" && venueIsConfirmed
        ? "Les enchères sont portées par un avocat du barreau compétent. Cette règle doit encore être rapprochée des pièces de la vente."
        : "Les modalités de représentation doivent être confirmées dans les conditions de vente."),
    guaranteeAmountEur:
      rules?.guarantee.amount_eur ??
      (venueType === "tribunal" && venueIsConfirmed
        ? judicialGuarantee(sale.starting_price_eur)
        : null),
    guaranteeRatePct:
      rules?.guarantee.rate_pct ?? (venueType === "tribunal" && venueIsConfirmed ? 10 : null),
    guaranteeMinimumEur:
      rules?.guarantee.minimum_eur ?? (venueType === "tribunal" && venueIsConfirmed ? 3000 : null),
    guaranteeNote:
      rules?.guarantee.note ??
      "Le montant exact et le bénéficiaire doivent être confirmés dans les conditions de vente.",
    financingCondition: rules?.financing_condition ?? null,
    coolingOffPeriod: rules?.cooling_off_period ?? null,
    paymentDeadlineDays: rules?.payment_deadline_days ?? null,
    overbidAllowed: rules?.overbid.allowed ?? null,
    overbidMinimumIncreasePct: rules?.overbid.minimum_increase_pct ?? null,
    overbidWindowDays: rules?.overbid.window_days ?? null,
    overbidNote:
      rules?.overbid.note ?? "La faculté de surenchère doit être confirmée pour cette vente.",
    sources: procedure
      ? [...procedure.verification.case_sources, ...procedure.verification.regulatory_sources]
      : [],
    issues: procedure?.verification.issues ?? ["Qualification détaillée en cours de vérification."],
  };
}

export function saleVenueLabel(venueType: SaleVenueType): string {
  return {
    tribunal: "Vente au tribunal",
    notary: "Vente notariale",
    state: "Vente domaniale",
    online: "Organisateur à confirmer",
    unknown: "Type de vente à confirmer",
  }[venueType];
}

export function saleVenueShortLabel(venueType: SaleVenueType): string {
  return {
    tribunal: "Tribunal",
    notary: "Notaire",
    state: "État",
    online: "À confirmer",
    unknown: "À confirmer",
  }[venueType];
}

export function saleVerificationLabel(status: SaleVerificationStatus): string {
  return {
    verified: "Vérifié",
    cross_checked: "Recoupé",
    pending: "En cours de vérification",
    conflict: "Contrôle requis",
  }[status];
}

export function saleProcedureIsConfirmed(procedure: SaleProcedurePresentation): boolean {
  return (
    procedure.verificationStatus === "verified" || procedure.verificationStatus === "cross_checked"
  );
}

export function saleIsTribunalVenue(sale: AuctionSale): boolean {
  return getSaleProcedure(sale).venueType === "tribunal";
}

export function saleLegalFrameworkLabel(framework: SaleLegalFramework): string {
  return {
    judicial_seizure: "Saisie immobilière",
    judicial_partition: "Licitation ou partage judiciaire",
    insolvency: "Liquidation ou procédure collective",
    voluntary_notarial: "Vente notariale volontaire",
    state_sale: "Vente domaniale",
    unknown: "Cadre juridique à confirmer",
  }[framework];
}

export function participationModeLabel(
  value: SaleProcedurePresentation["participationMode"],
): string {
  return {
    in_person: "Sur place",
    online: "En ligne",
    hybrid: "Sur place et en ligne",
    unknown: "À confirmer",
  }[value];
}

export function lawyerRequirementLabel(procedure: SaleProcedurePresentation): string {
  if (procedure.lawyerRequired === true) return "Avocat obligatoire pour enchérir";
  if (procedure.lawyerRequired === false) return "Avocat non obligatoire en principe";
  return "Représentation à confirmer";
}

export function guaranteeLabel(procedure: SaleProcedurePresentation): string {
  const amount = procedure.guaranteeAmountEur;
  const rate = procedure.guaranteeRatePct;
  const minimum = procedure.guaranteeMinimumEur;
  if (amount != null) {
    const suffix = rate != null ? ` · ${formatPercentNumber(rate)} de la mise à prix` : "";
    return `${formatPrice(amount)}${suffix}`;
  }
  if (rate != null) {
    return `${formatPercentNumber(rate)} de la mise à prix${
      minimum != null ? ` · minimum ${formatPrice(minimum)}` : ""
    }`;
  }
  return "Montant à confirmer";
}

export function paymentDeadlineLabel(days: number | null): string {
  if (days == null) return "À confirmer dans les conditions de vente";
  if (days === 60) return "2 mois après l’adjudication définitive";
  return `${days} jours après l’adjudication`;
}

export function overbidLabel(procedure: SaleProcedurePresentation): string {
  if (procedure.overbidAllowed === false) return "Non prévue";
  if (procedure.overbidAllowed !== true) return "À confirmer dans les conditions de vente";
  const parts = [
    procedure.overbidMinimumIncreasePct != null
      ? `+${formatPercentNumber(procedure.overbidMinimumIncreasePct)} minimum`
      : null,
    procedure.overbidWindowDays != null ? `dans les ${procedure.overbidWindowDays} jours` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "Possible";
}

export function saleEventLabel(venueType: SaleVenueType): string {
  return venueType === "tribunal" ? "Audience" : "Vente";
}

function embeddedProcedure(sale: AuctionSale): unknown {
  if (sale.sale_procedure) return sale.sale_procedure;
  const sourceBlocks = sale.source_blocks;
  if (sourceBlocks && typeof sourceBlocks === "object") {
    return sourceBlocks.sale_procedure;
  }
  return null;
}

function legacyVenueType(sale: AuctionSale): SaleVenueType {
  const source = `${sale.source_name ?? ""} ${sale.primary_source ?? ""}`.toLowerCase();
  if (source.includes("notaire")) return "notary";
  if (source.includes("cession") || source.includes("domanial")) return "state";
  if (sale.tribunal || sale.tribunal_code || sale.tribunal_name) return "tribunal";
  return "unknown";
}

function parseVenueType(value: unknown): SaleVenueType | null {
  const parsed = venueTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseLegalFramework(value: unknown): SaleLegalFramework | null {
  const parsed = legalFrameworkSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseVerificationStatus(value: unknown): SaleVerificationStatus | null {
  const parsed = verificationStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function legacyEligibleBar(sale: AuctionSale): string | null {
  const city = sale.tribunal_city ?? sale.tribunal_name?.replace(/^TJ\s+/i, "") ?? null;
  return city ? `Barreau de ${city}` : null;
}

function judicialGuarantee(startingPrice: number | null): number | null {
  if (startingPrice == null || !Number.isFinite(startingPrice)) return null;
  return Math.max(3000, startingPrice * 0.1);
}

function formatPercentNumber(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value)} %`;
}
