import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Comment utiliser Immojudis",
  description:
    "Rechercher une vente, comparer des biens, sauvegarder ses favoris et préparer une simulation.",
};

const steps = [
  {
    title: "Rechercher une vente",
    text: "Dans le catalogue, saisissez une commune ou un département. Choisissez le type de vente, le prix maximum et les caractéristiques recherchées. La liste reste utilisable si la carte ne charge pas. Une donnée absente ne signifie pas que le bien ne présente aucun risque.",
    href: "/sales",
    label: "Ouvrir le catalogue",
  },
  {
    title: "Comparer jusqu’à trois biens",
    text: "Cochez Comparer sur les cartes, puis ouvrez le tableau. Comparez les dates, mises à prix et surfaces de même nature. La sélection temporaire disparaît au rechargement. Avec un compte gratuit, enregistrez une comparaison et retrouvez-la dans Mes comparaisons.",
    href: "/sales",
    label: "Choisir les biens à comparer",
  },
  {
    title: "Retrouver les ventes suivies",
    text: "Le cœur ajoute une vente à vos favoris. Le compte gratuit permet d’en conserver dix, accessibles sur vos appareils. Retirez une vente pour libérer une place. Les favoris seuls n’envoient pas de notification automatique.",
    href: "/favoris",
    label: "Ouvrir mes favoris",
  },
  {
    title: "Tester l’analyse et les scénarios",
    text: "Ouvrez l’annonce exemple pour essayer le simulateur sans compte. Modifiez les travaux, frais et objectifs, puis comparez les résultats. Une sauvegarde du simulateur est locale au navigateur : elle ne se synchronise pas sur vos autres appareils. Reprendre une sauvegarde recalcule avec les données actuelles.",
    href: "/annonce-exemple",
    label: "Essayer le simulateur",
  },
  {
    title: "Passer au dossier réel",
    text: "Le plan Analyse ouvre les modules disponibles sur les fiches réelles. L’export PDF concerne les ventes au tribunal et ne reprend pas encore les réglages personnels du simulateur. Vérifiez les données et documents disponibles avant de décider ; aucune estimation ne garantit le résultat de la vente.",
    href: "/accompagnement",
    label: "Consulter les accès et tarifs",
  },
  {
    title: "Préparer la suite",
    text: "Consultez les ressources propres au type de vente et l’annuaire d’avocats. La présence d’un professionnel dans l’annuaire ne confirme ni sa disponibilité ni l’acceptation de votre dossier. Contactez-le pour vérifier ces points.",
    href: "/avocats",
    label: "Consulter l’annuaire",
  },
];

export default function Page() {
  return (
    <main className="mx-auto max-w-4xl px-4 pb-20 pt-28">
      <h1 className="text-4xl font-bold">Comment utiliser Immojudis</h1>
      <p className="mt-4 text-muted-foreground">
        Un parcours concret, du catalogue à la préparation de votre dossier.
      </p>
      <ol className="mt-10 space-y-6">
        {steps.map((step, index) => (
          <li key={step.href + index} className="rounded-xl border p-6">
            <h2 className="text-xl font-bold">
              {index + 1}. {step.title}
            </h2>
            <p className="mt-3 leading-relaxed">{step.text}</p>
            <Link href={step.href} className="mt-4 inline-block font-semibold underline">
              {step.label}
            </Link>
          </li>
        ))}
      </ol>
      <section className="mt-10 rounded-xl border p-6">
        <h2 className="text-xl font-bold">Une page vide ou une information manquante ?</h2>
        <p className="mt-3">
          Réinitialisez les filtres puis réessayez. La couverture n’est pas exhaustive : aucun
          résultat ne prouve l’absence de vente dans votre secteur. Les modules sans données
          suffisantes restent indisponibles.
        </p>
        <Link href="/contact" className="mt-4 inline-block underline">
          Signaler un problème
        </Link>
      </section>
    </main>
  );
}
