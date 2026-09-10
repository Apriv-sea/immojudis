"use client";

import { createFileRoute } from "@/lib/router-compat";
import { CinematicHero } from "@/components/CinematicHome";
import { HomeDiscovery } from "@/components/HomeDiscovery";

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

export function HomePage() {
  return (
    <main className="ij-page ij-cinematic-page">
      <CinematicHero />
      <HomeDiscovery />
    </main>
  );
}
