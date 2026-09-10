"use client";

import { createFileRoute, Link } from "@/lib/router-compat";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import SearchCheck from "lucide-react/dist/esm/icons/search-check.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { RESOURCES_PATH } from "@/lib/navigation";

export const Route = createFileRoute("/a-propos")({
  head: () => ({
    meta: [
      { title: "À propos — Immojudis" },
      {
        name: "description",
        content:
          "Immojudis rassemble les ventes au tribunal, notariales et domaniales référencées et explique les règles propres à chaque procédure.",
      },
    ],
  }),
  component: AboutPage,
});

export function AboutPage() {
  return (
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto max-w-6xl">
        <section className="glass-shell overflow-hidden rounded-lg p-6 sm:p-8 lg:p-10">
          <div className="grid gap-8 lg:grid-cols-[1fr_26rem] lg:items-center">
            <div>
              <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
                <Landmark className="h-4 w-4" />À propos d'Immojudis
              </div>
              <h1 className="mt-4 max-w-3xl font-display text-4xl leading-tight text-foreground sm:text-5xl">
                Rendre les ventes immobilières aux enchères compréhensibles et comparables.
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                Au tribunal, chez le notaire ou auprès de l’État, les démarches ne sont pas les
                mêmes. Immojudis rassemble les annonces référencées, explique le type de vente et
                aide à préparer sa décision. Une vente notariale ou domaniale n’est pas forcément
                judiciaire.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link
                  to={RESOURCES_PATH}
                  className="liquid-button inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.16em] text-background"
                >
                  Lire les ressources <ArrowRight className="h-4 w-4" />
                </Link>
                <Link to="/sales" className="ij-login-button">
                  Explorer les ventes
                </Link>
              </div>
            </div>

            <div className="relative min-h-[24rem] overflow-hidden rounded-lg bg-[#eef7ff]">
              <img
                src="/media/landing/justice-goddess.webp"
                alt=""
                width={1600}
                height={2400}
                loading="lazy"
                className="absolute -bottom-24 left-1/2 h-[34rem] w-auto -translate-x-1/2 opacity-90"
              />
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-3">
          <AboutCard
            icon={SearchCheck}
            title="Centraliser"
            text="Regrouper les ventes dispersées pour éviter la veille manuelle et les angles morts."
          />
          <AboutCard
            icon={ShieldCheck}
            title="Qualifier"
            text="Mettre en avant les points qui changent vraiment une décision : occupation, frais, risques et preuves."
          />
          <AboutCard
            icon={Landmark}
            title="Préparer"
            text="Aider chaque acheteur à comprendre les conditions de sa vente et à contacter le bon interlocuteur."
          />
        </section>
      </div>
    </main>
  );
}

function AboutCard({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Landmark;
  title: string;
  text: string;
}) {
  return (
    <article className="liquid-panel-soft rounded-lg p-5">
      <Icon className="h-5 w-5 text-gold" />
      <h2 className="mt-4 text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
    </article>
  );
}
