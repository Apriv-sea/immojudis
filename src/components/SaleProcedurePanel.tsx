import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import FileCheck2 from "lucide-react/dist/esm/icons/file-check-2.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import WalletCards from "lucide-react/dist/esm/icons/wallet-cards.js";
import { formatDateTime } from "@/lib/format";
import { safeExternalHttpUrl } from "@/lib/external-url";
import {
  getSaleProcedure,
  guaranteeLabel,
  lawyerRequirementLabel,
  overbidLabel,
  participationModeLabel,
  paymentDeadlineLabel,
  saleLegalFrameworkLabel,
  saleProcedureIsConfirmed,
  saleVerificationLabel,
  saleVenueLabel,
  type SaleProcedurePresentation,
} from "@/lib/sale-procedure";
import type { AuctionSale, SaleVerificationStatus } from "@/lib/types";
import listingStyles from "@/components/sale-detail/SaleListing.module.css";

export function SaleProcedureBadge({ sale }: { sale: AuctionSale }) {
  const procedure = getSaleProcedure(sale);
  const verified = ["verified", "cross_checked"].includes(procedure.verificationStatus);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] backdrop-blur ${
        verified
          ? "border-emerald-200 bg-emerald-50/95 text-emerald-900"
          : procedure.verificationStatus === "conflict"
            ? "border-red-200 bg-red-50/95 text-red-900"
            : "border-amber-200 bg-amber-50/95 text-amber-950"
      }`}
      title={`${saleVenueLabel(procedure.venueType)} · ${saleVerificationLabel(procedure.verificationStatus)}`}
    >
      {verified ? (
        <ShieldCheck className="h-3 w-3" aria-hidden />
      ) : (
        <CircleAlert className="h-3 w-3" aria-hidden />
      )}
      {saleVenueLabel(procedure.venueType)}
    </span>
  );
}

export function SaleProcedureSummary({
  sale,
  showBadge = true,
}: {
  sale: AuctionSale;
  showBadge?: boolean;
}) {
  const procedure = getSaleProcedure(sale);
  return (
    <section aria-label="Cette vente en clair" className={listingStyles.section}>
      <h2 className={listingStyles.heading}>Cette vente en clair</h2>
      <div className={listingStyles.card}>
        {showBadge ? (
          <div className="mb-4">
            <SaleProcedureBadge sale={sale} />
          </div>
        ) : null}
        <dl className={listingStyles.rows}>
          <div className={listingStyles.row}>
            <dt>Cadre juridique</dt>
            <dd>{saleLegalFrameworkLabel(procedure.legalFramework)}</dd>
          </div>
          <div className={listingStyles.row}>
            <dt>Participation</dt>
            <dd>{participationModeLabel(procedure.participationMode)}</dd>
          </div>
          <div className={listingStyles.row}>
            <dt>Représentation</dt>
            <dd>{lawyerRequirementLabel(procedure)}</dd>
          </div>
        </dl>
        <a href="#participation" className={`${listingStyles.textLink} mt-3`}>
          Voir les démarches et conditions de cette vente
        </a>
      </div>
    </section>
  );
}

export function SaleProcedurePanel({ sale }: { sale: AuctionSale }) {
  const procedure = getSaleProcedure(sale);
  const steps = participationSteps(procedure);
  const verificationTone = verificationClasses(procedure.verificationStatus);

  return (
    <section
      id="participation"
      className="mt-8 scroll-mt-36 overflow-hidden rounded-[20px] border border-slate-200 bg-white"
      aria-labelledby="sale-procedure-title"
    >
      <div className="border-b border-slate-200 bg-slate-50/60 px-5 py-6 sm:px-7 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-brand-navy text-white">
              {procedure.venueType === "tribunal" ? (
                <Landmark className="h-6 w-6" aria-hidden />
              ) : (
                <Scale className="h-6 w-6" aria-hidden />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-soft">
                Organisation de la vente
              </p>
              <h2
                id="sale-procedure-title"
                className="mt-1 text-2xl font-semibold leading-tight text-brand-navy"
              >
                {saleVenueLabel(procedure.venueType)}
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-brand-navy/75 sm:text-base">
                {lawyerRequirementLabel(procedure)}. Immojudis réunit ici les démarches, délais et
                justificatifs utiles pour participer sans devoir reconstituer la procédure.
              </p>
            </div>
          </div>
          <span
            className={`inline-flex w-fit shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold ${verificationTone}`}
          >
            {procedure.verificationStatus === "conflict" ? (
              <CircleAlert className="h-4 w-4" aria-hidden />
            ) : (
              <ShieldCheck className="h-4 w-4" aria-hidden />
            )}
            {saleVerificationLabel(procedure.verificationStatus)}
          </span>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        <div className="p-5 sm:p-7 lg:border-r lg:border-brand-navy/10 lg:p-8">
          <h3 className="font-display text-2xl font-semibold text-brand-navy">
            Ce que cela change pour vous
          </h3>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <ProcedureFact
              icon={Scale}
              label="Représentation"
              value={lawyerRequirementLabel(procedure)}
              detail={procedure.eligibleBar ?? procedure.lawyerNote}
            />
            <ProcedureFact
              icon={WalletCards}
              label="Consignation"
              value={guaranteeLabel(procedure)}
              detail={procedure.guaranteeNote}
            />
            <ProcedureFact
              icon={CalendarClock}
              label="Paiement du prix"
              value={paymentDeadlineLabel(procedure.paymentDeadlineDays)}
              detail={
                procedure.financingCondition === false
                  ? "Financement à sécuriser avant la vente : pas de condition suspensive usuelle."
                  : "Conditions de financement à confirmer dans le dossier."
              }
            />
            <ProcedureFact
              icon={FileCheck2}
              label="Surenchère"
              value={overbidLabel(procedure)}
              detail={procedure.overbidNote}
            />
          </div>

          <div className="mt-5 rounded-md border border-brand-navy/10 bg-[#eef7ff] p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <CompactFact label="Lieu / organisme" value={procedure.venueName ?? "À confirmer"} />
              <CompactFact
                label="Mode de participation"
                value={participationModeLabel(procedure.participationMode)}
              />
              <CompactFact
                label="Cadre juridique"
                value={saleLegalFrameworkLabel(procedure.legalFramework)}
              />
              <CompactFact
                label="Rétractation"
                value={
                  procedure.coolingOffPeriod === false
                    ? "Aucun délai de rétractation"
                    : "À confirmer"
                }
              />
            </div>
            {procedure.venueAddress ? (
              <p className="mt-3 flex items-start gap-2 border-t border-brand-navy/10 pt-3 text-sm text-brand-navy/75">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" aria-hidden />
                {procedure.venueAddress}
              </p>
            ) : null}
          </div>
        </div>

        <div className="border-t border-brand-navy/10 p-5 sm:p-7 lg:border-t-0 lg:p-8">
          <h3 className="font-display text-2xl font-semibold text-brand-navy">
            Votre parcours de participation
          </h3>
          <ol className="mt-5 space-y-4">
            {steps.map((step, index) => (
              <li key={step.title} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-gold-soft text-xs font-bold text-white">
                  {index + 1}
                </span>
                <div>
                  <p className="text-sm font-semibold text-brand-navy">{step.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-brand-navy/75">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>

          {procedure.organizerName || procedure.organizerContact ? (
            <div className="mt-6 rounded-md border border-gold/25 bg-[#fffaf2] p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-navy/75">
                Contact de la vente
              </p>
              <p className="mt-2 font-semibold text-brand-navy">
                {procedure.organizerName ?? "Coordonnées disponibles"}
              </p>
              {procedure.organizerContact ? (
                <p className="mt-1 break-words text-sm text-brand-navy/75">
                  {procedure.organizerContact}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <VerificationDetails procedure={procedure} />
    </section>
  );
}

function ProcedureFact({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Scale;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <dl className="rounded-md border border-brand-navy/10 p-4">
      <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-brand-navy/75">
        <Icon className="h-4 w-4 text-gold-soft" aria-hidden />
        {label}
      </dt>
      <dd className="mt-3 text-base font-semibold leading-snug text-brand-navy">{value}</dd>
      <dd className="mt-2 text-xs leading-relaxed text-brand-navy/75">{detail}</dd>
    </dl>
  );
}

function CompactFact({ label, value }: { label: string; value: string }) {
  return (
    <dl>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-brand-navy/75">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-brand-navy">{value}</dd>
    </dl>
  );
}

function VerificationDetails({ procedure }: { procedure: SaleProcedurePresentation }) {
  const sourceLinks = procedure.sources.flatMap((source, index) => {
    const href = safeExternalHttpUrl(source.url);
    return href
      ? [
          {
            href,
            label: source.label ?? source.source_name ?? `Source ${index + 1}`,
            sourceName: source.source_name ?? null,
          },
        ]
      : [];
  });

  return (
    <details className="group border-t border-brand-navy/10 bg-[#f8fbfe] px-5 py-4 sm:px-7 lg:px-8">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-semibold text-brand-navy">
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-gold-soft" aria-hidden />
          Vérification Immojudis · {sourceLinks.length} source{sourceLinks.length > 1 ? "s" : ""}
        </span>
        <span className="text-xs font-normal text-brand-navy/75">
          {procedure.verifiedAt
            ? `contrôlé ${formatDateTime(procedure.verifiedAt)}`
            : "date à confirmer"}
        </span>
      </summary>
      <div className="mt-4 grid gap-5 border-t border-brand-navy/10 pt-4 lg:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-brand-navy/75">
            Sources contrôlées
          </p>
          {sourceLinks.length ? (
            <ul className="mt-3 space-y-2">
              {sourceLinks.map((source) => (
                <li key={source.href}>
                  <a
                    href={source.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-start gap-2 text-sm font-semibold text-brand-navy underline decoration-gold/45 underline-offset-4 hover:text-gold-soft"
                  >
                    <span>{source.label}</span>
                    <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  </a>
                  {source.sourceName && source.sourceName !== source.label ? (
                    <p className="mt-0.5 text-xs text-brand-navy/75">{source.sourceName}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-brand-navy/75">
              Les justificatifs de cette qualification sont en cours de rattachement.
            </p>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-brand-navy/75">
            Points encore ouverts
          </p>
          {procedure.issues.length ? (
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-brand-navy/75">
              {procedure.issues.map((issue) => (
                <li key={issue} className="flex gap-2">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                  {issue}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-emerald-800">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Aucun conflit détecté sur le mode de vente publié.
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

function participationSteps(procedure: SaleProcedurePresentation) {
  if (procedure.venueType === "tribunal" && saleProcedureIsConfirmed(procedure)) {
    return [
      {
        title: "Choisir l’avocat compétent",
        detail:
          procedure.eligibleBar ?? "Vérifier le barreau du tribunal avant de mandater l’avocat.",
      },
      {
        title: "Faire relire le dossier",
        detail: "Valider occupation, frais, consignation, clauses et pouvoir avec l’avocat.",
      },
      {
        title: "Remettre le mandat et la garantie",
        detail: `${guaranteeLabel(procedure)} selon les instructions exactes du cahier des conditions de vente.`,
      },
      {
        title: "L’avocat porte les enchères",
        detail: "Fixer par écrit un plafond qui intègre prix, frais, occupation et travaux.",
      },
    ];
  }
  if (procedure.venueType === "notary" && saleProcedureIsConfirmed(procedure)) {
    return [
      {
        title: "Consulter le cahier des charges",
        detail:
          "Vérifier les modalités propres à la séance, les frais et la surenchère éventuelle.",
      },
      {
        title: "Sécuriser le financement",
        detail:
          "Aucun délai de rétractation ou condition suspensive usuelle ne protège l’adjudicataire.",
      },
      {
        title: "Préparer la consignation",
        detail: guaranteeLabel(procedure),
      },
      {
        title: "S’enregistrer et enchérir",
        detail: `${participationModeLabel(procedure.participationMode)} selon les instructions du notaire.`,
      },
    ];
  }
  return [
    {
      title: "Attendre la qualification vérifiée",
      detail: "Immojudis contrôle le lieu, l’organisateur et les règles applicables.",
    },
    {
      title: "Consulter les conditions de vente",
      detail:
        "Ne verser aucune consignation tant que son montant et son bénéficiaire ne sont pas confirmés.",
    },
    {
      title: "Sécuriser le financement",
      detail: "Préparer le budget complet avant de prendre un engagement.",
    },
    {
      title: "Vérifier la mise à jour",
      detail: "Contrôler les éventuels reports ou changements publiés avant la vente.",
    },
  ];
}

function verificationClasses(status: SaleVerificationStatus): string {
  if (status === "cross_checked" || status === "verified") {
    return "border-emerald-200 bg-emerald-50 text-emerald-900";
  }
  if (status === "conflict") return "border-red-200 bg-red-50 text-red-900";
  return "border-amber-200 bg-amber-50 text-amber-950";
}
