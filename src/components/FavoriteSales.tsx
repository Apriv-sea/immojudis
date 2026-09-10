"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { fetchFavoriteSales } from "@/lib/client-api";
import { formatPrice, formatDate } from "@/lib/format";
import { FavoriteButton } from "./FavoriteButton";

export function FavoriteSales() {
  const { user, loading } = useAuth();
  const query = useQuery({
    queryKey: ["favorites", user?.id],
    queryFn: fetchFavoriteSales,
    enabled: Boolean(user) && !loading,
  });
  const data = user && !loading ? query.data : undefined;
  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 pb-16 pt-28">
      <h1 className="text-3xl font-bold">Mes ventes suivies</h1>
      <p className="mt-3 text-muted-foreground">
        Retrouvez vos favoris sur vos appareils. Jusqu’à 10 favoris en Découverte ; sans limite avec
        Analyse.
      </p>
      <Link href="/sales" className="mt-4 inline-block underline">
        Rechercher d’autres ventes
      </Link>
      {query.isPending || loading ? (
        <p role="status" className="mt-8">
          Chargement des favoris…
        </p>
      ) : null}
      {query.isError ? (
        <div role="alert" className="mt-8">
          <p>Impossible de charger vos favoris.</p>
          <button type="button" onClick={() => void query.refetch()} className="mt-2 underline">
            Réessayer
          </button>
        </div>
      ) : null}
      {data?.favorites.length === 0 ? (
        <p className="mt-8">
          Aucune vente suivie disponible. Utilisez le cœur dans le catalogue pour en ajouter.
        </p>
      ) : null}
      {data ? (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {data.favorites.map(({ saleId, sale }) => (
            <li key={saleId} className="rounded-xl border p-5">
              <div className="flex items-start justify-between gap-3">
                <Link href={`/sales/${saleId}`} className="font-bold underline">
                  {sale.city || "Commune non renseignée"}
                  {sale.department ? ` (${sale.department})` : ""}
                </Link>
                <FavoriteButton saleId={saleId} compact />
              </div>
              <p className="mt-3">Mise à prix : {formatPrice(sale.starting_price_eur)}</p>
              <p>Date : {formatDate(sale.sale_date)}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {data?.unavailableSaleIds?.length ? (
        <section className="mt-8">
          <h2 className="font-bold">Ventes indisponibles</h2>
          <p className="text-sm">Retirez ces favoris pour libérer leur place dans votre quota.</p>
          <ul>
            {data.unavailableSaleIds.map((saleId) => (
              <li
                key={saleId}
                className="mt-3 flex items-center justify-between rounded border p-3"
              >
                <span>Annonce retirée du catalogue</span>
                <FavoriteButton saleId={saleId} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="mt-8 text-sm text-muted-foreground">
        Les annonces retirées du catalogue peuvent ne plus apparaître. Les favoris ne déclenchent
        pas d’e-mail automatique.
      </p>
    </main>
  );
}
