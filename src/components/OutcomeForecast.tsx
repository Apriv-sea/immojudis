"use client";

import { useMemo, useState } from "react";
import Ban from "lucide-react/dist/esm/icons/ban.js";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import CircleDashed from "lucide-react/dist/esm/icons/circle-dashed.js";
import Gavel from "lucide-react/dist/esm/icons/gavel.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import TrendingUp from "lucide-react/dist/esm/icons/trending-up.js";
import Users from "lucide-react/dist/esm/icons/users.js";
import type { OutcomeGraphForecastQuery } from "@/hooks/use-outcome-graph-forecast";
import { formatPrice } from "@/lib/format";
import {
  cumulativeProbability,
  withOutcomeGraphCeiling,
  type OutcomeGraphForecast,
  type OutcomeGraphQuantiles,
} from "@/lib/outcome-graph";

export type { OutcomeGraphForecastQuery } from "@/hooks/use-outcome-graph-forecast";

export function OutcomeForecast({ forecastQuery }: { forecastQuery: OutcomeGraphForecastQuery }) {
  const [ceilingDraft, setCeilingDraft] = useState("");

  const forecast = forecastQuery.data?.forecast;
  if (!forecast || forecast.status !== "ready") {
    return null;
  }

  return (
    <OutcomeForecastReady
      forecast={forecast}
      ceilingDraft={ceilingDraft}
      onCeilingDraftChange={setCeilingDraft}
    />
  );
}

function OutcomeForecastReady({
  forecast,
  ceilingDraft,
  onCeilingDraftChange,
}: {
  forecast: OutcomeGraphForecast;
  ceilingDraft: string;
  onCeilingDraftChange: (value: string) => void;
}) {
  const initialCeilingCents = forecast.ceiling?.amountCents ?? forecast.finalPrice?.p50Cents ?? 0;
  const parsedCeiling = Number(ceilingDraft);
  const ceilingCents =
    ceilingDraft && Number.isFinite(parsedCeiling) && parsedCeiling >= 0
      ? Math.round(parsedCeiling * 100)
      : initialCeilingCents;
  const displayedForecast = useMemo(
    () => withOutcomeGraphCeiling(forecast, ceilingCents),
    [ceilingCents, forecast],
  );
  const ceiling = displayedForecast.ceiling!;

  const flowSteps = [
    {
      label: "Audience tenue",
      value: displayedForecast.flow.heldProbability,
      icon: Users,
      tone: "navy" as const,
    },
    {
      label: "Adjudication si audience tenue",
      value: displayedForecast.flow.adjudicatedIfHeldProbability,
      icon: Gavel,
      tone: "gold" as const,
    },
    {
      label: "Enchères désertes si audience tenue",
      value: displayedForecast.flow.noBidIfHeldProbability,
      icon: CircleDashed,
      tone: "muted" as const,
    },
    {
      label: "Report",
      value: displayedForecast.flow.postponedProbability,
      icon: CalendarClock,
      tone: "muted" as const,
    },
    {
      label: "Annulation ou vente non requise",
      value: displayedForecast.flow.cancelledOrNotRequestedProbability,
      icon: Ban,
      tone: "muted" as const,
    },
  ];

  return (
    <section
      id="outcome-forecast"
      aria-labelledby="outcome-forecast-title"
      className="scroll-mt-36 border-b border-brand-navy/10 bg-[#eef7ff]"
    >
      <div className="mx-auto max-w-[1410px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <h2
          id="outcome-forecast-title"
          className="font-display text-4xl font-medium text-brand-navy sm:text-5xl"
        >
          Prévision de l’audience
        </h2>

        <div className="relative mt-9 md:grid md:grid-cols-5 md:gap-5">
          <div
            aria-hidden
            className="absolute left-[1.35rem] top-6 hidden h-px w-[calc(100%-2.7rem)] bg-brand-navy/15 md:block"
          />
          <div
            aria-hidden
            className="absolute bottom-5 left-[1.35rem] top-6 w-px bg-brand-navy/15 md:hidden"
          />
          {flowSteps.map((step) => (
            <FlowStep key={step.label} {...step} />
          ))}
        </div>

        <div className="mt-10 grid gap-8 border-y border-brand-navy/14 py-8 lg:grid-cols-2 lg:gap-0">
          <PriceDistribution
            label="Prix initial médian estimé"
            quantiles={displayedForecast.initialPrice!}
            className="lg:pr-10"
          />
          <div className="border-t border-brand-navy/14 pt-8 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
            <PriceDistribution
              label="Prix définitif médian estimé"
              quantiles={displayedForecast.finalPrice!}
            />
            <p className="mt-6 text-base font-medium text-brand-navy sm:text-lg">
              Probabilité de surenchère{" "}
              <strong className="ml-1 font-display text-2xl font-semibold text-gold-soft">
                {formatProbability(displayedForecast.surenchereProbability)}
              </strong>
            </p>
          </div>
        </div>

        <div className="mt-8 overflow-hidden rounded-lg border border-brand-navy/18 bg-white shadow-[0_18px_45px_rgba(72,104,132,0.08)]">
          <div className="grid lg:grid-cols-[minmax(250px,0.72fr)_minmax(0,1.65fr)]">
            <div className="border-b border-brand-navy/12 p-5 sm:p-7 lg:border-b-0 lg:border-r">
              <label
                htmlFor="outcome-ceiling"
                className="block font-display text-2xl font-semibold text-brand-navy"
              >
                Votre plafond
              </label>
              <div className="relative mt-4 max-w-[17rem]">
                <input
                  id="outcome-ceiling"
                  type="number"
                  min={0}
                  step={5_000}
                  value={ceilingDraft || String(Math.round(initialCeilingCents / 100))}
                  onChange={(event) => onCeilingDraftChange(event.target.value)}
                  className="h-14 w-full rounded-md border border-brand-navy/20 bg-white px-4 pr-12 font-display text-2xl font-semibold text-brand-navy outline-none transition focus:border-gold focus:ring-2 focus:ring-gold/20"
                  aria-describedby="outcome-ceiling-help"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 right-4 flex items-center font-display text-xl text-brand-navy/60"
                >
                  €
                </span>
              </div>
              <p
                id="outcome-ceiling-help"
                className="mt-3 text-xs leading-relaxed text-brand-navy/70"
              >
                Ce montant reste dans votre navigateur et n’alimente aucune cohorte.
              </p>

              <div className="mt-7 border-t border-brand-navy/12 pt-6">
                <p className="font-display text-6xl font-medium leading-none text-gold-soft sm:text-7xl">
                  {formatProbability(ceiling.finalPriceBelowOrEqualIfAdjudicatedProbability)}
                </p>
                <p className="mt-3 max-w-sm text-sm font-medium leading-relaxed text-brand-navy sm:text-base">
                  Probabilité que le prix final reste inférieur ou égal à votre plafond
                </p>
                <p className="mt-4 text-xs leading-relaxed text-brand-navy/62">
                  Probabilité combinée avec une adjudication :{" "}
                  <strong className="text-brand-navy">
                    {formatProbability(ceiling.adjudicationAndFinalPriceBelowOrEqualProbability)}
                  </strong>
                </p>
              </div>
            </div>

            <div className="min-w-0 p-4 sm:p-7">
              <CeilingCurve
                quantiles={displayedForecast.finalPrice!}
                ceilingCents={ceiling.amountCents}
                probability={ceiling.finalPriceBelowOrEqualIfAdjudicatedProbability}
              />
            </div>
          </div>
        </div>

        <ForecastMeta forecast={displayedForecast} />

        <details className="mt-7 border-t border-brand-navy/12 pt-5 text-sm text-brand-navy/68">
          <summary className="cursor-pointer font-semibold text-brand-navy">
            Méthode, facteurs et limites
          </summary>
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <ul className="space-y-2">
              {displayedForecast.explanationFactors.map((factor) => (
                <li key={factor.label}>
                  <strong className="text-brand-navy">{factor.label} :</strong> {factor.detail}
                </li>
              ))}
            </ul>
            <ul className="list-disc space-y-2 pl-5">
              {displayedForecast.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </div>
        </details>
      </div>
    </section>
  );
}

function FlowStep({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number | null;
  icon: typeof Users;
  tone: "navy" | "gold" | "muted";
}) {
  const toneClass =
    tone === "navy"
      ? "border-brand-navy bg-brand-navy text-white"
      : tone === "gold"
        ? "border-gold bg-white text-gold-soft"
        : "border-brand-navy/18 bg-white text-brand-navy/55";
  return (
    <div className="relative grid grid-cols-[2.75rem_minmax(0,1fr)] gap-4 pb-7 last:pb-0 md:block md:pb-0 md:text-center">
      <span
        className={`relative z-10 grid h-11 w-11 place-items-center rounded-full border ${toneClass} md:mx-auto`}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <div className="pt-0.5 md:mt-3 md:pt-0">
        <p
          className={`text-sm font-medium ${tone === "gold" ? "text-gold-soft" : "text-brand-navy/72"}`}
        >
          {label}
        </p>
        <p
          className={`mt-1 font-display text-4xl font-medium leading-none ${tone === "gold" ? "text-gold-soft" : "text-brand-navy"}`}
        >
          {formatProbability(value)}
        </p>
      </div>
    </div>
  );
}

function PriceDistribution({
  label,
  quantiles,
  className = "",
}: {
  label: string;
  quantiles: OutcomeGraphQuantiles;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-base font-medium text-brand-navy sm:text-lg">{label}</p>
      <p className="mt-2 font-display text-5xl font-medium leading-none text-brand-navy sm:text-6xl">
        {formatPrice(euros(quantiles.p50Cents))}
      </p>
      <p className="mt-4 text-sm text-brand-navy/72 sm:text-base">
        Fourchette probable à 80 % :{" "}
        <strong className="font-display text-xl font-semibold text-gold-soft">
          {formatPrice(euros(quantiles.p10Cents))} – {formatPrice(euros(quantiles.p90Cents))}
        </strong>
      </p>
      <div className="mt-7">
        <div className="grid grid-cols-3 text-xs text-brand-navy/66">
          <span>10 %</span>
          <span className="text-center">Médiane</span>
          <span className="text-right">90 %</span>
        </div>
        <div className="relative mt-2 h-1 rounded-full bg-brand-navy/12" aria-hidden>
          <span className="absolute inset-y-0 left-[28%] right-[28%] bg-gold" />
          <span className="absolute -top-1 left-[5%] h-3 w-px bg-brand-navy/65" />
          <span className="absolute -top-1 left-1/2 h-3 w-px bg-brand-navy" />
          <span className="absolute -top-1 right-[5%] h-3 w-px bg-brand-navy/65" />
        </div>
        <div className="mt-2 grid grid-cols-3 font-display text-base font-semibold text-brand-navy/72 sm:text-lg">
          <span>{formatPrice(euros(quantiles.p10Cents))}</span>
          <span className="text-center text-gold-soft">
            {formatPrice(euros(quantiles.p50Cents))}
          </span>
          <span className="text-right">{formatPrice(euros(quantiles.p90Cents))}</span>
        </div>
      </div>
    </div>
  );
}

function CeilingCurve({
  quantiles,
  ceilingCents,
  probability,
}: {
  quantiles: OutcomeGraphQuantiles;
  ceilingCents: number;
  probability: number;
}) {
  const width = 720;
  const height = 260;
  const padding = { left: 58, right: 22, top: 18, bottom: 42 };
  const minPrice = Math.max(0, Math.round(quantiles.p10Cents * 0.6));
  const maxPrice = Math.max(minPrice + 1, Math.round(quantiles.p90Cents * 1.25));
  const x = (price: number) =>
    padding.left +
    ((Math.min(maxPrice, Math.max(minPrice, price)) - minPrice) / (maxPrice - minPrice)) *
      (width - padding.left - padding.right);
  const y = (value: number) => padding.top + (1 - value) * (height - padding.top - padding.bottom);
  const points = Array.from({ length: 41 }, (_, index) => {
    const price = minPrice + ((maxPrice - minPrice) * index) / 40;
    return `${x(price).toFixed(1)},${y(cumulativeProbability(quantiles, price)).toFixed(1)}`;
  }).join(" ");
  const markerX = x(ceilingCents);
  const markerY = y(probability);
  const ticks = [minPrice, quantiles.p10Cents, quantiles.p50Cents, quantiles.p90Cents, maxPrice];

  return (
    <div>
      <h3 className="font-display text-2xl font-semibold text-brand-navy">
        Distribution du prix définitif
      </h3>
      <p className="mt-1 text-sm text-brand-navy/70">Lecture conditionnelle à une adjudication.</p>
      <div
        className="mt-5 overflow-x-auto"
        role="region"
        aria-label="Graphique cumulatif du prix définitif"
        tabIndex={0}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto min-w-[540px]"
          role="img"
          aria-label={`Courbe cumulative : ${formatProbability(probability)} de probabilité sous ${formatPrice(euros(ceilingCents))}`}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <g key={tick}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="rgba(19,34,56,0.15)"
                strokeDasharray={tick === 0 ? undefined : "5 5"}
              />
              <text
                x={padding.left - 10}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-brand-navy/60 text-[12px]"
              >
                {Math.round(tick * 100)} %
              </text>
            </g>
          ))}
          <polyline points={points} fill="none" stroke="#132238" strokeWidth="3" />
          <line
            x1={padding.left}
            x2={markerX}
            y1={markerY}
            y2={markerY}
            stroke="#c98d45"
            strokeWidth="1.5"
            strokeDasharray="6 5"
          />
          <line
            x1={markerX}
            x2={markerX}
            y1={markerY}
            y2={height - padding.bottom}
            stroke="#c98d45"
            strokeWidth="1.5"
            strokeDasharray="6 5"
          />
          <circle cx={markerX} cy={markerY} r="7" fill="#c98d45" />
          {ticks.map((tick, index) => (
            <text
              key={`${tick}-${index}`}
              x={x(tick)}
              y={height - 12}
              textAnchor={index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"}
              className={`text-[12px] ${tick === ceilingCents ? "fill-gold-soft" : "fill-brand-navy/60"}`}
            >
              {compactPrice(tick)}
            </text>
          ))}
          <text
            x={Math.min(width - 58, Math.max(58, markerX))}
            y={height - padding.bottom + 25}
            textAnchor="middle"
            className="fill-gold-soft text-[13px] font-semibold"
          >
            {compactPrice(ceilingCents)}
          </text>
        </svg>
      </div>
    </div>
  );
}

function ForecastMeta({ forecast }: { forecast: OutcomeGraphForecast }) {
  const pressure = forecast.pressure;
  const confidence = forecast.confidence;
  const items = [
    {
      icon: TrendingUp,
      label: "Pression concurrentielle",
      value: pressure ? `${pressure.score}/100 — ${pressure.label}` : "À confirmer",
    },
    {
      icon: ShieldCheck,
      label: "Niveau de confiance",
      value: confidence ? capitalize(confidence.label) : "À confirmer",
    },
    {
      icon: ChartNoAxesCombined,
      label: "Échantillon",
      value: confidence ? `${confidence.sampleSize} résultats A/B` : "À confirmer",
    },
    {
      icon: Landmark,
      label: "Résultats dans ce tribunal",
      value: confidence ? String(confidence.tribunalSampleSize) : "À confirmer",
    },
    {
      icon: CalendarDays,
      label: "Date de calcul",
      value: formatCalculationDate(forecast.generatedAt),
    },
  ];

  return (
    <div className="mt-8 grid border-y border-brand-navy/14 sm:grid-cols-2 lg:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.label}
          className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 border-b border-brand-navy/10 px-3 py-5 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0"
        >
          <item.icon className="mt-0.5 h-5 w-5 text-gold-soft" aria-hidden />
          <dl>
            <dt className="text-xs text-brand-navy/70">{item.label}</dt>
            <dd className="mt-1 text-sm font-semibold text-brand-navy">{item.value}</dd>
          </dl>
        </div>
      ))}
    </div>
  );
}

function formatProbability(value: number | null): string {
  return value == null ? "Inconnu" : `${Math.round(value * 100)} %`;
}

function compactPrice(valueCents: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(
    Math.round(euros(valueCents)),
  )} €`;
}

function euros(valueCents: number): number {
  return valueCents / 100;
}

function formatCalculationDate(value: string | null): string {
  if (!value) return "À confirmer";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() <= 1970) return "À confirmer";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  }).format(date);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
