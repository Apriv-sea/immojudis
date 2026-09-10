"use client";

import { useEffect, useState } from "react";
import { useSearch } from "@/lib/router-compat";
import { useQuery } from "@tanstack/react-query";
import { SaleDetailSkeleton, SaleNotFoundComponent } from "@/components/SaleDetailView";
import { DiscoverySaleDetailView } from "@/components/DiscoverySaleDetailView";
import { AnalysisSaleDetailView } from "@/components/SimplifiedSaleDetailView";
import { SalePublicPreview } from "@/components/SalePublicPreview";
import { useAuth } from "@/hooks/use-auth";
import { markSaleViewed } from "@/hooks/use-viewed-sales";
import { getSaleById, getSalePreviewById } from "@/lib/queries";
import { fetchAccessPlan } from "@/lib/client-api";
import { safeSalesReturnTo, saleDetailPath } from "@/lib/navigation";
import { saleSeoTitle } from "@/lib/seo";
import type { AuctionSale } from "@/lib/types";

type SaleDetailRouteData = {
  sale: AuctionSale | null;
  preview: AuctionSale | null;
};

async function loadSaleDetailRouteData(
  id: string,
  options: { discovery?: boolean; authenticated: boolean },
): Promise<SaleDetailRouteData> {
  const sale = options.authenticated
    ? await getSaleById(id, { discovery: options.discovery })
    : null;
  if (sale) return { sale, preview: null };
  return { sale: null, preview: await getSalePreviewById(id) };
}

export function SaleDetailPage({
  id,
  initialData,
  adjudicationStatisticsEnabled = false,
}: {
  id: string;
  initialData?: SaleDetailRouteData;
  adjudicationStatisticsEnabled?: boolean;
}) {
  const search = useSearch() as { from?: unknown };
  const returnTo = safeSalesReturnTo(search.from) ?? "/sales";
  const [requestedHash, setRequestedHash] = useState("");
  useEffect(() => {
    const updateHash = () => setRequestedHash(window.location.hash);
    updateHash();
    window.addEventListener("hashchange", updateHash);
    return () => window.removeEventListener("hashchange", updateHash);
  }, [id]);
  const loginReturnTo = `${saleDetailPath(id, safeSalesReturnTo(search.from))}${requestedHash}`;
  const { session, loading: authLoading, authError } = useAuth();
  const sessionKey = session?.user.id ?? "anonymous";
  const {
    data: entitlementsData,
    isLoading: entitlementsLoading,
    error: entitlementsError,
    refetch: retryEntitlements,
  } = useQuery({
    queryKey: ["feature-entitlements", sessionKey, "plan"],
    queryFn: fetchAccessPlan,
    enabled: Boolean(session) && !authLoading,
    staleTime: 5 * 60_000,
  });
  const discovery = Boolean(session) && entitlementsData?.plan.hasAnalysisAccess !== true;
  const accessReady = !session || Boolean(entitlementsData);
  const canUseServerInitialData =
    initialData?.sale?.id === id || (!session && initialData?.preview?.id === id);
  const { data, isLoading, error } = useQuery({
    queryKey: ["sale-detail", id, sessionKey, discovery ? "discovery" : "analysis"],
    queryFn: () => loadSaleDetailRouteData(id, { discovery, authenticated: Boolean(session) }),
    enabled: !authLoading && accessReady,
    initialData: canUseServerInitialData ? initialData : undefined,
    staleTime: 5 * 60_000,
  });
  const sale = data?.sale ?? null;
  const preview = data?.preview ?? null;
  const pageTitle = `${saleSeoTitle(
    !authLoading && accessReady && session ? (sale ?? preview) : preview,
  )} - Immojudis`;

  useEffect(() => {
    const previousTitle = document.title;
    document.title = pageTitle;
    return () => {
      document.title = previousTitle;
    };
  }, [pageTitle]);

  useEffect(() => {
    if (sale?.id) markSaleViewed(sale.id);
  }, [sale?.id]);

  useEffect(() => {
    if (authLoading || !accessReady || !sale?.id) return;
    let frame = 0;
    const revealAnchor = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let targetId: string;
        try {
          targetId = decodeURIComponent(window.location.hash.slice(1));
        } catch {
          return;
        }
        if (targetId)
          document
            .getElementById(targetId)
            ?.scrollIntoView({ behavior: "instant", block: "start" });
      });
    };
    revealAnchor();
    window.addEventListener("hashchange", revealAnchor);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", revealAnchor);
    };
  }, [sale?.id, authLoading, accessReady]);

  if (!authLoading && authError) {
    return (
      <main className="mx-auto my-12 max-w-xl px-4">
        <section role="alert" className="rounded-lg border border-border bg-white p-6">
          <h1 className="text-xl font-semibold">Connexion à renouveler</h1>
          <p className="mt-3 text-sm text-muted-foreground">{authError}</p>
          <a
            href={`/login?redirect=${encodeURIComponent(loginReturnTo)}`}
            className="mt-5 inline-flex rounded-md bg-brand-navy px-4 py-2 text-white"
          >
            Se reconnecter
          </a>
        </section>
      </main>
    );
  }

  if (!authLoading && session && entitlementsError && !entitlementsData) {
    return (
      <section
        role="alert"
        className="mx-auto my-12 max-w-xl rounded-lg border border-border bg-white p-6"
      >
        <h1 className="text-xl font-semibold">Vos droits d’accès n’ont pas pu être vérifiés</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Réessayez pour retrouver la version de l’annonce incluse dans votre offre.
        </p>
        <button
          type="button"
          className="mt-5 rounded-md bg-brand-navy px-4 py-2 text-white"
          onClick={() => void retryEntitlements()}
        >
          Réessayer
        </button>
      </section>
    );
  }
  if (authLoading || entitlementsLoading || !accessReady || isLoading) {
    return <SaleDetailSkeleton />;
  }
  if (error) throw error;
  if (!sale && preview) {
    return (
      <SalePublicPreview
        saleId={id}
        preview={preview}
        returnTo={returnTo}
        requestedHash={requestedHash}
      />
    );
  }
  if (!sale) return <SaleNotFoundComponent />;

  return discovery ? (
    <DiscoverySaleDetailView sale={sale} returnTo={returnTo} />
  ) : (
    <AnalysisSaleDetailView
      sale={sale}
      returnTo={returnTo}
      adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
    />
  );
}
