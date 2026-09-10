"use client";

import type { ReactNode } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import { BillingActions } from "@/components/BillingActions";

import { createFileRoute, Link } from "@/lib/router-compat";

export const Route = createFileRoute("/accompagnement")({
  head: () => ({
    meta: [
      { title: "Offres Découverte et Analyse — Immojudis" },
      {
        name: "description",
        content:
          "Photos, enveloppe travaux et annuaire d'avocats gratuitement, puis mise plafond, marché et risques avec Analyse à 29 € pour 30 jours.",
      },
    ],
  }),
  component: AccompagnementPage,
});

const discoveryFeatures = [
  "Photos du bien",
  "Mise à prix et date de vente",
  "Surface et localisation",
  "Montant global estimé des travaux",
  "Annuaire des avocats par barreau",
] as const;

const analysisFeatures = [
  "Mise plafond avec travaux incluse par défaut",
  "Estimation du bien et ventes comparables",
  "Détail des frais, travaux, risques et pièces",
  "3 enquêtes IA supervisées par période de 30 jours",
  "Contact avocat pour les ventes au tribunal",
] as const;

export function AccompagnementPage() {
  return (
    <main className="min-h-screen bg-white text-brand-navy">
      <section className="border-b border-brand-navy/10 bg-[#eef7ff]">
        <div className="mx-auto grid max-w-[1460px] gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(500px,0.85fr)] lg:items-center lg:px-8 lg:py-8">
          <div>
            <h1 className="max-w-3xl font-display text-[clamp(3.2rem,4.5vw,4.75rem)] font-medium leading-[0.96] text-brand-navy">
              La mise à prix lance l'enchère. Votre mise plafond protège votre argent.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-brand-navy/72 sm:text-lg">
              Immojudis croise le marché, les frais et les travaux pour vous aider à savoir jusqu'où
              enchérir — sans sacrifier votre marge.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/#exemples"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-gold-soft px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-gold"
              >
                Voir les exemples sur l'accueil
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link
                to="/sales"
                className="inline-flex min-h-12 items-center justify-center rounded-md border border-brand-navy/35 bg-white px-5 py-3 text-sm font-semibold text-brand-navy transition-colors hover:border-gold hover:text-gold-soft"
              >
                Explorer gratuitement
              </Link>
            </div>
          </div>

          <DecisionEquation />
        </div>
      </section>

      <section className="mx-auto max-w-[1220px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div className="grid gap-5 lg:grid-cols-2">
          <PlanPanel
            name="Découverte"
            price="0 €"
            description="Pour repérer un bien et évaluer l'ampleur du chantier."
            features={discoveryFeatures}
          >
            <Link
              to="/login"
              search={{ mode: "investor", redirect: "/sales" }}
              className="inline-flex min-h-12 w-full items-center justify-center rounded-md border border-brand-navy bg-white px-5 py-3 text-sm font-semibold text-brand-navy transition-colors hover:bg-[#eef7ff]"
            >
              Créer mon compte gratuit
            </Link>
          </PlanPanel>

          <PlanPanel
            name="Analyse"
            price="29 € / 30 jours"
            description="Pour décider, chiffrer et préparer l'enchère."
            features={analysisFeatures}
            highlighted
          >
            <p className="mb-3 text-center text-xs font-medium text-brand-navy/70">
              Paiement unique · sans abonnement
            </p>
            <BillingActions hideHelper className="[&>button]:w-full" />
          </PlanPanel>
        </div>

        <p className="mx-auto mt-9 max-w-4xl text-center font-display text-2xl font-semibold leading-tight text-brand-navy sm:text-3xl">
          Commencez gratuitement. Payez seulement quand un dossier mérite une vraie décision.
        </p>
      </section>

      <section className="border-t border-brand-navy/10 bg-[#fffaf2]">
        <div className="mx-auto grid max-w-[1220px] gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:px-8 lg:py-16">
          <div>
            <h2 className="font-display text-4xl font-medium leading-tight text-brand-navy sm:text-5xl">
              Le prix de départ ne dit pas si l'affaire est bonne.
            </h2>
            <p className="mt-5 max-w-xl text-sm leading-relaxed text-brand-navy/68 sm:text-base">
              Une mise à prix peut sembler attractive, ou au contraire être déjà trop haute. La
              décision utile consiste à partir du marché et à retrancher ce que le dossier vous
              coûtera réellement.
            </p>
          </div>
          <div className="divide-y divide-brand-navy/12 border-y border-brand-navy/14">
            <OfferProof
              icon={<Target className="h-5 w-5" />}
              title="Un chiffre à ne pas dépasser"
              text="La mise plafond transforme une analyse longue en limite de décision claire avant la vente."
            />
            <OfferProof
              icon={<Wrench className="h-5 w-5" />}
              title="Les travaux comptent dès le premier calcul"
              text="Le rafraîchissement est inclus par défaut, puis reste ajustable selon l'état réel du bien."
            />
            <OfferProof
              icon={<ShieldCheck className="h-5 w-5" />}
              title="Les preuves restent accessibles"
              text="Comparables, frais, risques, pièces et avocat permettent de vérifier ce qui soutient le plafond."
            />
          </div>
        </div>
      </section>
    </main>
  );
}

function DecisionEquation() {
  const items = [
    {
      icon: <Building2 className="h-7 w-7" />,
      label: "Valeur de marché",
      sign: "−",
    },
    {
      icon: <ShieldCheck className="h-7 w-7" />,
      label: "Marge de sécurité",
      sign: "−",
    },
    {
      icon: <FileText className="h-7 w-7" />,
      label: "Frais",
      sign: "−",
    },
    {
      icon: <Wrench className="h-7 w-7" />,
      label: "Travaux inclus par défaut",
      sign: "=",
      accent: true,
    },
    {
      icon: <BadgeEuro className="h-8 w-8" />,
      label: "Mise plafond",
      result: true,
    },
  ];

  return (
    <div>
      <div className="grid grid-cols-5 items-start gap-2">
        {items.map((item) => (
          <div key={item.label} className="relative text-center">
            <span
              className={`mx-auto grid h-16 w-16 place-items-center rounded-full border ${
                item.result
                  ? "border-brand-navy bg-brand-navy text-white"
                  : "border-white bg-white text-brand-navy shadow-sm"
              }`}
            >
              {item.icon}
            </span>
            <p
              className={`mt-3 text-xs font-semibold leading-tight sm:text-sm ${
                item.accent ? "text-gold-soft" : "text-brand-navy"
              }`}
            >
              {item.label}
            </p>
            {item.sign ? (
              <span
                className="absolute -right-2 top-5 text-2xl font-semibold text-gold-soft"
                aria-hidden
              >
                {item.sign}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-7 border-t border-gold pt-6 text-center">
        <p className="text-sm font-medium leading-relaxed text-brand-navy sm:text-base">
          Parce qu'un bien vendu aux enchères est rarement en état neuf.
        </p>
      </div>
    </div>
  );
}

function PlanPanel({
  name,
  price,
  description,
  features,
  children,
  highlighted = false,
}: {
  name: string;
  price: string;
  description: string;
  features: readonly string[];
  children: ReactNode;
  highlighted?: boolean;
}) {
  return (
    <article
      className={`overflow-hidden rounded-lg border bg-white shadow-sm ${
        highlighted ? "border-brand-navy" : "border-brand-navy/30"
      }`}
    >
      <div className={highlighted ? "bg-brand-navy px-6 py-4 text-white" : "px-6 pt-5"}>
        <h2 className="text-center font-display text-4xl font-semibold">{name}</h2>
      </div>
      <div className="flex h-[calc(100%-5rem)] flex-col p-6 sm:p-8">
        <div className="text-center">
          <strong className="font-display text-5xl font-medium leading-none text-brand-navy sm:text-6xl">
            {price}
          </strong>
          <p className="mt-4 text-sm text-brand-navy/68">{description}</p>
        </div>
        <ul className="mx-auto my-7 grid w-full max-w-md gap-3">
          {features.map((feature) => (
            <li key={feature} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 text-sm">
              <Check className="mt-0.5 h-4 w-4 text-gold-soft" aria-hidden />
              <span className="leading-relaxed text-brand-navy/78">{feature}</span>
            </li>
          ))}
        </ul>
        <div className="mt-auto">{children}</div>
      </div>
    </article>
  );
}

function OfferProof({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <article className="grid grid-cols-[2rem_minmax(0,1fr)] gap-4 py-5">
      <span className="mt-1 text-gold-soft" aria-hidden>
        {icon}
      </span>
      <div>
        <h3 className="text-base font-semibold text-brand-navy">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-brand-navy/65">{text}</p>
      </div>
    </article>
  );
}
