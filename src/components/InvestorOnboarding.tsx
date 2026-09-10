"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@/lib/router-compat";
import { firstSearchToUrl, type FirstSearch } from "@/lib/onboarding";
import { HOME_TYPE_OPTIONS } from "@/lib/search/search-filters";
import { formatPrice } from "@/lib/format";

const steps = ["Votre secteur", "Vos critères", "Votre première recherche"];
const inputClass =
  "w-full rounded-lg border border-border bg-background px-4 py-3 text-base text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

export function InvestorOnboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState<FirstSearch>({ area: "", maxPrice: "", homeType: "" });
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < steps.length - 1) {
      setStep((current) => current + 1);
      return;
    }
    void navigate({ to: "/sales", search: firstSearchToUrl(search) });
  }

  const criteria = firstSearchToUrl(search);
  return (
    <main className="liquid-page min-h-[calc(100svh-4rem)] px-4 py-10 sm:px-6 sm:py-16">
      <section className="glass-shell mx-auto max-w-2xl rounded-lg p-6 sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Bienvenue dans votre compte Découverte
        </p>
        <ol aria-label="Étapes de démarrage" className="mt-6 flex gap-2">
          {steps.map((label, index) => (
            <li
              key={label}
              aria-current={step === index ? "step" : undefined}
              className={`h-1.5 flex-1 rounded-full ${index <= step ? "bg-gold" : "bg-muted"}`}
            >
              <span className="sr-only">
                {index + 1}. {label}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-muted-foreground">
          Étape {step + 1} sur {steps.length}
        </p>
        <h1
          ref={heading}
          tabIndex={-1}
          className="mt-2 font-display text-3xl text-foreground outline-none"
        >
          {steps[step]}
        </h1>

        <form onSubmit={submit} className="mt-6 space-y-6">
          {step === 0 && (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Choisissez où chercher. Tous les champs sont facultatifs et vos filtres resteront
                modifiables dans le catalogue.
              </p>
              <label className="grid gap-2 text-sm font-medium">
                Ville, département ou région
                <input
                  className={inputClass}
                  value={search.area}
                  onChange={(event) =>
                    setSearch((current) => ({ ...current, area: event.target.value }))
                  }
                  placeholder="Ex. Bordeaux, 33 ou Nouvelle-Aquitaine"
                  maxLength={120}
                  autoComplete="off"
                />
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Les annonces disponibles dépendent des sources suivies. L’absence de résultat ne
                signifie pas qu’aucune vente n’existe dans votre secteur.
              </p>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-5">
              <label className="grid gap-2 text-sm font-medium">
                Type de bien
                <select
                  className={inputClass}
                  value={search.homeType}
                  onChange={(event) =>
                    setSearch((current) => ({ ...current, homeType: event.target.value }))
                  }
                >
                  <option value="">Tous les types</option>
                  {HOME_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Mise à prix maximale (€)
                <input
                  type="number"
                  min={1}
                  max={1_000_000_000}
                  step="any"
                  inputMode="decimal"
                  className={inputClass}
                  value={search.maxPrice}
                  onChange={(event) =>
                    setSearch((current) => ({ ...current, maxPrice: event.target.value }))
                  }
                  placeholder="Sans plafond"
                  aria-describedby="starting-price-help"
                />
              </label>
              <p id="starting-price-help" className="text-xs leading-relaxed text-muted-foreground">
                C’est le point de départ des enchères, hors frais et travaux. Le prix final peut le
                dépasser : ce filtre n’est pas votre budget total d’acquisition.
              </p>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-5">
              <dl className="space-y-3 rounded-lg border border-border bg-background/70 p-4 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Secteur</dt>
                  <dd>{criteria.query ?? "Tous les secteurs couverts"}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Type de bien</dt>
                  <dd>
                    {HOME_TYPE_OPTIONS.find((option) => option.value === search.homeType)?.label ??
                      "Tous les types"}
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Mise à prix maximale</dt>
                  <dd>
                    {typeof criteria.maxPrice === "number"
                      ? formatPrice(criteria.maxPrice)
                      : "Sans plafond"}
                  </dd>
                </div>
              </dl>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Ouvrez une fiche pour vérifier la date, la localisation et les caractéristiques du
                bien. Les calculs détaillés et les pièces nécessitent un accès Analyse.
              </p>
              <Link
                to="/annonce-exemple"
                className="inline-block text-sm font-medium text-gold-soft underline underline-offset-4"
              >
                Comprendre une analyse sur l’annonce exemple gratuite
              </Link>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            {step > 0 ? (
              <button
                type="button"
                onClick={() => setStep((current) => current - 1)}
                className="rounded-lg px-3 py-3 text-sm text-muted-foreground hover:text-foreground"
              >
                Retour
              </button>
            ) : (
              <span />
            )}
            <button
              type="submit"
              className="liquid-button rounded-lg px-6 py-3 text-sm font-semibold text-brand-navy"
            >
              {step === steps.length - 1 ? "Voir les biens" : "Continuer"}
            </button>
          </div>
        </form>
        <Link
          to="/sales"
          className="mt-6 inline-block text-sm text-muted-foreground underline underline-offset-4"
        >
          Passer et explorer le catalogue
        </Link>
      </section>
    </main>
  );
}
