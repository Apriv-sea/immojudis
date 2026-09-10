import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SaleComparisonTable } from "@/components/search/SaleComparisonTable";
import { formatDate } from "@/lib/format";
import { getSharedSaleComparison } from "@/lib/sale-analysis-sets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Comparaison partagée",
  description: "Comparaison de biens issue du catalogue ImmoJudis.",
  robots: { index: false, follow: false },
};

export default async function SharedSaleComparisonPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const comparison = await getSharedSaleComparison(token).catch(() => null);
  if (!comparison) notFound();

  return (
    <main className="min-h-screen bg-[#f4f7f9] px-3 py-8 text-[#132238] sm:px-6">
      <article className="mx-auto max-w-5xl overflow-hidden rounded-xl border border-[#d6e3e8] bg-white shadow-sm">
        <header className="border-b border-[#d6e3e8] px-4 py-5 sm:px-6">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0f766e]">
            Comparaison partagée ImmoJudis
          </p>
          <h1 className="mt-2 text-2xl font-extrabold sm:text-3xl">{comparison.name}</h1>
          <p className="mt-2 text-sm text-[#526170]">
            Instantané mis à jour le {formatDate(comparison.updatedAt)} · lien valable jusqu’au{" "}
            {formatDate(comparison.expiresAt)}
          </p>
        </header>

        <SaleComparisonTable items={comparison.items} returnTo="/sales" />

        <footer className="space-y-2 border-t border-[#d6e3e8] bg-[#fbfdff] px-4 py-4 text-xs leading-relaxed text-[#526170] sm:px-6">
          <p>
            Cet instantané contient seulement des informations publiques du catalogue. Il n’inclut
            ni score d’investissement, ni adresse détaillée, ni donnée personnelle.
          </p>
          <p>
            La mise à prix n’est ni le prix final ni le coût total. Vérifiez les pièces officielles
            et la disponibilité des biens avant toute décision.
          </p>
          <a
            href="/sales"
            className="inline-flex min-h-11 items-center font-bold text-[#0f766e] underline underline-offset-2"
          >
            Explorer le catalogue
          </a>
        </footer>
      </article>
    </main>
  );
}
