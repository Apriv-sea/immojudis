import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesPage } from "@/routes/sales.index";

export const metadata: Metadata = {
  title: "Annonces",
  description: "Consultez toutes les ventes aux encheres immobilieres disponibles.",
  alternates: { canonical: "/sales" },
};

export default function Page() {
  return (
    <Suspense fallback={<SalesCatalogFallback />}>
      <SalesPage />
    </Suspense>
  );
}

function SalesCatalogFallback() {
  return (
    <main className="min-h-screen bg-[#f4f7f9] px-4 py-10 text-[#132238] sm:px-6">
      <section className="mx-auto max-w-6xl">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#0f766e]">
          Catalogue ImmoJudis
        </p>
        <h1 className="mt-3 font-display text-4xl leading-tight sm:text-5xl">
          Ventes immobilières aux enchères
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-[#526170]">
          Recherchez les ventes au tribunal, notariales et domaniales référencées, par lieu et
          budget. Les filtres interactifs et la carte se chargent ensuite sans masquer ce contenu
          essentiel.
        </p>
        <form action="/sales" method="get" className="mt-7 flex max-w-2xl gap-2">
          <label htmlFor="catalog-search-fallback" className="sr-only">
            Ville, département, tribunal ou code postal
          </label>
          <input
            id="catalog-search-fallback"
            name="q"
            type="search"
            placeholder="Ville, département, tribunal ou code postal"
            className="min-w-0 flex-1 rounded-md border border-[#cbd5df] bg-white px-4 py-3"
          />
          <button type="submit" className="rounded-md bg-[#132238] px-5 py-3 font-bold text-white">
            Rechercher
          </button>
        </form>
      </section>
    </main>
  );
}
