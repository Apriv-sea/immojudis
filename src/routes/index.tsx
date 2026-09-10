"use client";

import { createFileRoute, Link } from "@/lib/router-compat";
import Image from "next/image";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import Calculator from "lucide-react/dist/esm/icons/calculator.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Radar from "lucide-react/dist/esm/icons/radar.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import { useEffect, useState, type ComponentType } from "react";
import { BrandMark } from "@/components/BrandLogo";
import { SaleTypesOverview } from "@/components/SaleTypesOverview";
import { RESOURCES_PATH } from "@/lib/navigation";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Immojudis — Les enchères immobilières en toute clarté" },
      {
        name: "description",
        content:
          "Ventes au tribunal, enchères notariales et ventes domaniales référencées : comprenez les procédures et préparez votre achat immobilier avec Immojudis.",
      },
    ],
  }),
  component: HomePage,
});

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
type CandleArrowGeometry = {
  width: number;
  height: number;
  linePath: string;
  headPath: string;
};

const benefits = [
  { icon: FileSearch, title: "Rapports d'opportunité", text: "mise à prix, DVF, risques" },
  { icon: Calculator, title: "Mise plafond", text: "budget, frais, travaux, marge" },
  { icon: Radar, title: "Alertes data-driven", text: "décote, rendement, zone" },
] satisfies Array<{ icon: IconComponent; title: string; text: string }>;

const auctionCards = [
  {
    example: "bordeaux",
    image: "/media/landing/auction-bordeaux.webp",
    badge: "Décote à examiner",
    city: "Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    title: "Appartement de caractère, quartier Jardin Public",
    price: "Mise à prix 92 000 €",
    signal: "9 comparables DVF",
    score: "78/100",
    confidence: "Confiance moyenne",
  },
  {
    example: "nantes",
    image: "/media/landing/auction-nantes.webp",
    badge: "Frais à simuler",
    city: "Nantes",
    tribunal: "Tribunal judiciaire de Nantes",
    title: "Maison de ville en pierre avec dépendance",
    price: "Mise à prix 138 500 €",
    signal: "Maison avec terrain",
    score: "71/100",
    confidence: "Dossier à compléter",
  },
  {
    example: "toulouse",
    image: "/media/landing/auction-toulouse.webp",
    badge: "Travaux à provisionner",
    city: "Toulouse",
    tribunal: "Tribunal judiciaire de Toulouse",
    title: "Maison ancienne avec jardin arboré",
    price: "Mise à prix 121 000 €",
    signal: "Risque locatif à lire",
    score: "69/100",
    confidence: "Risque à lire",
  },
] as const;

const workflowSteps = [
  {
    number: "01",
    icon: Search,
    title: "Repérez",
    text: "Filtrez les annonces par type de vente, zone, budget, type de bien et date.",
  },
  {
    number: "02",
    icon: ChartNoAxesCombined,
    title: "Chiffrez",
    text: "Comparez la mise à prix au marché local, aux frais et à vos hypothèses de travaux.",
  },
  {
    number: "03",
    icon: Scale,
    title: "Décidez",
    text: "Fixez une mise maximale avant la vente et gardez la trace des points à valider.",
  },
] satisfies Array<{ number: string; icon: IconComponent; title: string; text: string }>;

const reportOutcomes = [
  {
    icon: ChartNoAxesCombined,
    title: "Comprendre la valeur",
    text: "Estimation de marché, fourchette de valeur et ventes comparables réunies dans une lecture cohérente.",
  },
  {
    icon: Scale,
    title: "Identifier les risques",
    text: "Les points d'attention juridiques, techniques et locatifs sont rendus visibles avant de s'engager.",
  },
  {
    icon: Calculator,
    title: "Fixer sa mise maximale",
    text: "Budget, frais, travaux et marge de sécurité sont transformés en une limite claire avant la vente.",
  },
] satisfies Array<{ icon: IconComponent; title: string; text: string }>;

const trustPoints = [
  {
    icon: CalendarDays,
    title: "Sources et fraîcheur affichées",
    text: "Les dates et limites des données restent visibles.",
  },
  {
    icon: ChartNoAxesCombined,
    title: "Comparables DVF",
    text: "Le marché local est replacé dans son contexte.",
  },
  {
    icon: FileSearch,
    title: "Documents de la vente",
    text: "Les pièces disponibles sont regroupées par vente.",
  },
  {
    icon: Scale,
    title: "Niveau de confiance",
    text: "La solidité de l'analyse est explicitée.",
  },
] satisfies Array<{ icon: IconComponent; title: string; text: string }>;

const reportMetrics = [
  { label: "Mise à prix", value: "92 000 €", tone: "neutral" },
  { label: "Valeur estimée", value: "145-162 k€", tone: "opportunity" },
  { label: "Décote apparente", value: "-31 %", tone: "opportunity" },
  { label: "Score", value: "78/100", tone: "watch" },
] as const;

const reportRows = [
  ["DVF comparables", "9 ventes retenues", "300 m - 24 mois"],
  ["Frais estimés", "14 800 €", "à confirmer avec l'avocat"],
  ["Risque principal", "Occupation à vérifier", "impact prix plafond"],
  ["Confiance", "Moyenne", "surface et DPE à recouper"],
] as const;

const planPreviews = [
  {
    name: "Découverte",
    price: "Gratuit",
    audience: "Pour explorer les ventes et repérer les dossiers à approfondir.",
    cta: "Créer mon compte gratuit",
    features: [
      "Recherche par lieu, budget et type de vente",
      "Informations essentielles de chaque bien",
      "Aperçu des analyses disponibles",
    ],
  },
  {
    name: "Analyse",
    price: "29 € / 30 jours",
    audience: "Pour chiffrer une opportunité et préparer sa décision avant la vente.",
    cta: "Débloquer les analyses",
    features: [
      "Rapports, risques et comparables détaillés",
      "Estimation, frais et mise maximale conseillée",
      "Alertes, favoris, exports et historique",
      "Cadastre, DPE, quartier et avocats référencés",
    ],
  },
] as const;

const searchGhostCities = [
  "Bordeaux",
  "Gironde",
  "33000",
  "Nouvelle-Aquitaine",
  "Paris",
  "Hérault",
] as const;

export function HomePage() {
  return (
    <main className="ij-page">
      <HeroSection />
      <SaleFamiliesSection />
      <OpportunityReportSection />
      <AuctionCardsSection />
      <HomeProcessSection />
      <OfferPlansSection />
      <HomeFooter />
    </main>
  );
}

function HeroSection() {
  return (
    <section className="ij-hero" aria-labelledby="home-title">
      <div className="ij-sky" aria-hidden />
      <div className="ij-hero-inner">
        <div className="ij-hero-copy">
          <p className="ij-badge ij-reveal">Ventes judiciaires, notariales et domaniales</p>

          <h1 id="home-title" className="ij-title ij-reveal ij-reveal-2">
            Les enchères immobilières,
            <br /> en toute <em>clarté.</em>
          </h1>

          <p className="ij-lead ij-reveal ij-reveal-3">
            Au tribunal, chez le notaire ou auprès de l’État : Immojudis réunit les annonces
            référencées et vous aide à comprendre les règles de chaque vente avant de vous engager.
          </p>

          <SearchBar />

          <div className="ij-benefits ij-reveal ij-reveal-5" aria-label="Bénéfices ImmoJudis">
            {benefits.map(({ icon: Icon, title, text }) => (
              <div key={title} className="ij-benefit">
                <Icon aria-hidden className="h-6 w-6" />
                <span>
                  <strong>{title}</strong>
                  <small>{text}</small>
                </span>
              </div>
            ))}
          </div>
        </div>

        <JusticeGoddessVisual />

        <div className="ij-candle-scene ij-reveal ij-reveal-6">
          <CandleAnimation />
          <article className="ij-candle-note">
            <h2>Décider avant la vente</h2>
            <p>
              Une mise à prix basse ne suffit jamais : le rapport relie marché local, frais et
              risques pour cadrer l'enchère.
            </p>
            <Link to={RESOURCES_PATH}>
              Comprendre la méthode <ArrowRight aria-hidden className="h-4 w-4" />
            </Link>
          </article>
        </div>

        <CandleArrow />
      </div>
    </section>
  );
}

function SaleFamiliesSection() {
  return (
    <section
      aria-labelledby="sale-families-title"
      className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold-soft">
        Comprendre avant de choisir
      </p>
      <h2
        id="sale-families-title"
        className="mt-3 font-display text-3xl font-semibold text-brand-navy sm:text-4xl"
      >
        Un même projet immobilier, des règles différentes.
      </h2>
      <p className="mb-6 mt-3 max-w-3xl text-sm leading-relaxed text-brand-navy/75 sm:text-base">
        Immojudis ne se limite pas aux ventes au tribunal. Commencez par identifier qui organise la
        vente : cela change vos démarches, vos interlocuteurs et les conditions pour participer.
      </p>
      <SaleTypesOverview />
      <Link
        href="/ventes-immobilieres-judiciaires#differences"
        className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-brand-navy underline underline-offset-4"
      >
        Comprendre les types de ventes <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </section>
  );
}

function CandleArrow() {
  const [geometry, setGeometry] = useState<CandleArrowGeometry | null>(null);

  useEffect(() => {
    let frame = 0;

    const px = (value: number) => Math.round(value * 10) / 10;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = document.querySelector<HTMLElement>(".ij-hero-inner");
        const start = document.querySelector<HTMLElement>("[data-arrow-start]");
        const end = document.querySelector<HTMLElement>("[data-arrow-end]");
        const candleScene = document.querySelector<HTMLElement>(".ij-candle-scene");

        if (
          !root ||
          !start ||
          !end ||
          !candleScene ||
          getComputedStyle(candleScene).display === "none"
        ) {
          setGeometry(null);
          return;
        }

        const rootRect = root.getBoundingClientRect();
        const startRect = start.getBoundingClientRect();
        const endRect = end.getBoundingClientRect();
        const startX = px(startRect.left + startRect.width / 2 - rootRect.left);
        const startY = px(startRect.top + startRect.height / 2 - rootRect.top);
        const endX = px(endRect.left + endRect.width / 2 - rootRect.left);
        const endY = px(endRect.top + endRect.height / 2 - rootRect.top);
        const dx = endX - startX;
        const dy = endY - startY;
        const lift = Math.min(132, Math.max(44, Math.abs(dx) * 0.75 + Math.abs(dy) * 0.55));
        const c1X = px(startX + dx * 0.12);
        const c1Y = px(startY - lift);
        const c2X = px(startX + dx * 0.82);
        const c2Y = px(endY - lift * 0.65);
        const angle = Math.atan2(endY - c2Y, endX - c2X);
        const headLength = 18;
        const wing = 0.58;
        const leftX = px(endX - Math.cos(angle - wing) * headLength);
        const leftY = px(endY - Math.sin(angle - wing) * headLength);
        const rightX = px(endX - Math.cos(angle + wing) * headLength);
        const rightY = px(endY - Math.sin(angle + wing) * headLength);
        const width = px(Math.max(rootRect.width, startX, endX, c1X, c2X, leftX, rightX) + 24);
        const height = px(Math.max(rootRect.height, startY, endY, c1Y, c2Y, leftY, rightY) + 24);

        setGeometry({
          width,
          height,
          linePath: `M ${startX} ${startY} C ${c1X} ${c1Y} ${c2X} ${c2Y} ${endX} ${endY}`,
          headPath: `M ${leftX} ${leftY} L ${endX} ${endY} L ${rightX} ${rightY}`,
        });
      });
    };

    const observer = "ResizeObserver" in window ? new ResizeObserver(update) : null;
    const hero = document.querySelector<HTMLElement>(".ij-hero-inner");
    const settleTimers = [120, 420, 820, 1220].map((delay) => window.setTimeout(update, delay));
    document
      .querySelectorAll<HTMLElement>(
        ".ij-hero-inner, [data-arrow-start], [data-arrow-end], .ij-candle-scene",
      )
      .forEach((element) => observer?.observe(element));

    update();
    hero?.addEventListener("animationend", update, true);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.addEventListener("load", update);
    void document.fonts?.ready.then(update);

    return () => {
      cancelAnimationFrame(frame);
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      observer?.disconnect();
      hero?.removeEventListener("animationend", update, true);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("load", update);
    };
  }, []);

  if (!geometry) return null;

  return (
    <svg
      className="ij-candle-arrow"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      style={{ width: geometry.width, height: geometry.height }}
      aria-hidden="true"
    >
      <defs>
        <mask
          id="ij-candle-arrow-mask"
          maskUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={geometry.width}
          height={geometry.height}
        >
          <path className="ij-candle-arrow-mask-line" d={geometry.linePath} pathLength={1} />
        </mask>
      </defs>
      <g mask="url(#ij-candle-arrow-mask)">
        <path className="ij-candle-arrow-line" d={geometry.linePath} />
      </g>
      <path className="ij-candle-arrow-head" d={geometry.headPath} pathLength={1} />
    </svg>
  );
}

function SearchBar() {
  const [query, setQuery] = useState("");
  const [cityIndex, setCityIndex] = useState(0);
  const [letterCount, setLetterCount] = useState(0);
  const ghostCity = searchGhostCities[cityIndex];

  useEffect(() => {
    if (query) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (letterCount !== ghostCity.length) setLetterCount(ghostCity.length);
      return;
    }

    const isComplete = letterCount >= ghostCity.length;
    const timer = window.setTimeout(
      () => {
        if (isComplete) {
          setCityIndex((current) => (current + 1) % searchGhostCities.length);
          setLetterCount(0);
          return;
        }

        setLetterCount((current) => current + 1);
      },
      isComplete ? 950 : 92,
    );

    return () => window.clearTimeout(timer);
  }, [cityIndex, ghostCity.length, letterCount, query]);

  return (
    <form className="ij-search ij-reveal ij-reveal-4" action="/sales">
      <span className="ij-search-arrow-start" data-arrow-start aria-hidden="true" />
      <span className={`ij-search-ghost${query ? " ij-search-ghost-hidden" : ""}`} aria-hidden>
        {ghostCity.slice(0, letterCount)}
        <span className="ij-search-ghost-caret" />
      </span>
      <label className="sr-only" htmlFor="home-search">
        Rechercher par région, département, ville ou code postal
      </label>
      <input
        id="home-search"
        name="q"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoComplete="off"
      />
      <button type="submit" aria-label="Rechercher">
        <Search aria-hidden className="h-6 w-6" />
      </button>
    </form>
  );
}

function JusticeGoddessVisual() {
  return (
    <div className="ij-goddess" aria-hidden="true">
      <div className="ij-cloud ij-cloud-a" />
      <div className="ij-cloud ij-cloud-b" />
      <Image
        src="/media/landing/justice-goddess.webp"
        alt=""
        width={1600}
        height={2400}
        priority
        sizes="(max-width: 900px) 120vw, 70vw"
      />
      <span className="ij-balance-glint" />
    </div>
  );
}

function CandleAnimation() {
  return (
    <div className="ij-candle" aria-hidden="true">
      <Image
        src="/media/landing/judicial-candle.webp"
        alt=""
        width={1188}
        height={1324}
        sizes="336px"
      />
      <span className="ij-candle-glow" />
      <span className="ij-candle-flame-glow" />
      <span className="ij-candle-arrow-end" data-arrow-end aria-hidden="true" />
    </div>
  );
}

function OpportunityReportSection() {
  return (
    <section className="ij-report" aria-labelledby="report-title">
      <div className="ij-report-layout">
        <div className="ij-report-story">
          <div className="ij-report-head">
            <p className="ij-proof-kicker">Nouvelle offre ImmoJudis</p>
            <h2 id="report-title">Un rapport d'opportunité pour décider avant la vente.</h2>
            <p>
              Chaque vente est transformée en dossier de décision pour évaluer son potentiel,
              identifier ses risques et préparer les démarches adaptées à la vente.
            </p>
          </div>

          <div className="ij-report-outcomes" aria-label="Bénéfices du rapport">
            {reportOutcomes.map(({ icon: Icon, title, text }) => (
              <article key={title} className="ij-report-outcome">
                <span className="ij-report-outcome-icon">
                  <Icon aria-hidden className="h-5 w-5" />
                </span>
                <span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </span>
              </article>
            ))}
          </div>
        </div>

        <aside className="ij-report-card" aria-label="Aperçu de rapport">
          <div className="ij-report-card-head">
            <span>Rapport exemple</span>
            <strong>Appartement · Bordeaux</strong>
            <small>Tribunal judiciaire · audience J-12</small>
          </div>

          <div className="ij-report-metrics">
            {reportMetrics.map((metric) => (
              <div key={metric.label} data-tone={metric.tone}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </div>
            ))}
          </div>

          <div className="ij-report-table">
            {reportRows.map(([label, value, detail]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{detail}</small>
              </div>
            ))}
          </div>

          <Link to="/annonce-exemple" className="ij-report-link">
            Voir une annonce enrichie <ArrowRight aria-hidden className="h-4 w-4" />
          </Link>
        </aside>
      </div>

      <div className="ij-trust-rail" aria-label="Transparence des analyses">
        {trustPoints.map(({ icon: Icon, title, text }) => (
          <div key={title} className="ij-trust-item">
            <Icon aria-hidden className="h-5 w-5" />
            <span>
              <strong>{title}</strong>
              <small>{text}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AuctionCardsSection() {
  return (
    <section id="exemples" className="ij-auctions" aria-labelledby="auctions-title">
      <div className="ij-auctions-head">
        <div>
          <p className="ij-proof-kicker">Exemples de lecture</p>
          <h2 id="auctions-title">Des ventes à explorer, avec les signaux utiles.</h2>
        </div>
        <Link to="/sales" className="ij-all-sales">
          Voir toutes les ventes <ArrowRight aria-hidden className="h-4 w-4" />
        </Link>
      </div>

      <div className="ij-card-grid">
        {auctionCards.map((card) => (
          <Link
            key={card.title}
            to="/annonce-exemple"
            search={{ bien: card.example }}
            className="ij-auction-card"
          >
            <span className="ij-card-image">
              <Image
                src={card.image}
                alt=""
                width={896}
                height={512}
                sizes="(max-width: 700px) 100vw, (max-width: 1100px) 50vw, 25vw"
              />
              <span>{card.badge}</span>
            </span>
            <span className="ij-card-body">
              <span className="ij-card-city">
                <Radar aria-hidden className="h-4 w-4" />
                {card.city}
              </span>
              <strong>{card.title}</strong>
              <span className="ij-card-meta">
                <Scale aria-hidden className="h-4 w-4" />
                {card.tribunal}
              </span>
              <span className="ij-card-price">
                <CalendarDays aria-hidden className="h-4 w-4" />
                {card.price}
              </span>
              <span className="ij-card-analysis">
                <span>{card.signal}</span>
                <strong>{card.score}</strong>
              </span>
              <span className="ij-card-confidence">{card.confidence}</span>
              <span className="ij-card-action">
                Voir l'annonce exemple <ArrowRight aria-hidden className="h-4 w-4" />
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function OfferPlansSection() {
  return (
    <section className="ij-plans" aria-labelledby="plans-title">
      <div className="ij-plans-intro">
        <p className="ij-proof-kicker">Une offre simple, sans abonnement</p>
        <h2 id="plans-title">Commencez gratuitement. Analysez pendant 30 jours pour 29 €.</h2>
        <p>Choisissez le niveau de lecture adapté au dossier que vous préparez aujourd'hui.</p>
      </div>

      <div className="ij-plan-grid">
        {planPreviews.map((plan, index) => (
          <article key={plan.name} className="ij-plan-card">
            <div>
              <span>{plan.name}</span>
              <strong>{plan.price}</strong>
              <p>{plan.audience}</p>
            </div>
            <ul>
              {plan.features.map((feature) => (
                <li key={feature}>
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            {index === 0 ? (
              <Link
                to="/login"
                search={{ mode: "investor", redirect: undefined }}
                className="ij-plan-button"
              >
                {plan.cta} <ArrowRight aria-hidden className="h-4 w-4" />
              </Link>
            ) : (
              <Link to="/accompagnement" className="ij-plan-button ij-plan-button-primary">
                {plan.cta} <ArrowRight aria-hidden className="h-4 w-4" />
              </Link>
            )}
          </article>
        ))}
      </div>

      <p className="ij-plan-renewal">Paiement unique, sans renouvellement automatique.</p>
    </section>
  );
}

function HomeProcessSection() {
  return (
    <section className="ij-process" aria-labelledby="process-title">
      <div className="ij-process-head">
        <div>
          <p className="ij-proof-kicker">Parcours de décision</p>
          <h2 id="process-title">Du signal à la mise maximale</h2>
        </div>
        <p>
          Trois étapes pour transformer les informations du dossier en une décision chiffrée et
          défendable.
        </p>
      </div>

      <div className="ij-process-body">
        <div className="ij-process-steps">
          <div className="ij-step-grid">
            {workflowSteps.map(({ number, icon: Icon, title, text }) => (
              <article key={title} className="ij-step">
                <span className="ij-step-number" aria-hidden>
                  {number}
                </span>
                <span className="ij-step-icon" aria-hidden>
                  <Icon aria-hidden className="h-4 w-4" />
                </span>
                <span className="ij-step-copy">
                  <strong>{title}</strong>
                  <small>{text}</small>
                </span>
                <ArrowRight aria-hidden className="ij-step-flow h-4 w-4" />
              </article>
            ))}
          </div>
        </div>

        <div className="ij-freshness">
          <CalendarDays aria-hidden className="h-5 w-5" />
          <span>
            <strong>Pipeline data et limites affichées</strong>
            <small>
              DVF garde un délai de publication et certaines données doivent être recoupées :
              ImmoJudis affiche donc les sources, la fraîcheur et le niveau de confiance.
            </small>
          </span>
        </div>
      </div>
    </section>
  );
}

function HomeFooter() {
  return (
    <footer className="ij-footer" aria-label="Pied de page">
      <div className="ij-footer-inner">
        <Link to="/" className="ij-footer-brand" aria-label="ImmoJudis — accueil">
          <span className="ij-footer-mark" aria-hidden="true">
            <BrandMark variant="transparent" className="h-5 w-5" />
          </span>
          <span>
            <strong>
              Immo<span>Judis</span>
            </strong>
            <small>Ventes immobilières aux enchères</small>
          </span>
        </Link>

        <nav className="ij-footer-nav" aria-label="Navigation pied de page">
          <Link to="/sales">Ventes</Link>
          <Link to="/annonce-exemple">Annonce exemple</Link>
          <Link to={RESOURCES_PATH}>Ressources</Link>
          <Link to="/contact">Contact</Link>
        </nav>

        <div className="ij-footer-legal">
          <span>© 2026 ImmoJudis</span>
          <Link to="/legal">Mentions légales</Link>
          <Link to="/conditions-generales">Conditions générales</Link>
          <Link to="/privacy">Confidentialité</Link>
          <Link to="/mes-droits">Mes droits</Link>
        </div>
      </div>
    </footer>
  );
}
