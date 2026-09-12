"use client";

import { ListingQualityNotice } from "@/components/ListingQualityNotice";
import { DeferredInformationRequest } from "@/components/DeferredInformationRequest";
import { ListingPhoto } from "@/components/ListingPhoto";

import { useMemo, useRef, useState } from "react";
import type { ReactNode, UIEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import { BillingActions } from "@/components/BillingActions";
import { DocumentsList } from "@/components/DocumentsList";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { riskEvidence } from "@/lib/risk-evidence";
import { listingSaleStatus, listingValuationConflict } from "@/lib/listing-evidence";
import type { BidSimulationSnapshot } from "@/components/BidCeilingAssistant";
import { useAuth } from "@/hooks/use-auth";
import { LawyerReferralButton } from "@/components/LawyerReferralButton";
import { MapboxPreviewButton } from "@/components/MapboxPreviewButton";
import { useOutcomeGraphForecast } from "@/hooks/use-outcome-graph-forecast";
import { SaleVisual } from "@/components/SaleVisual";
import { SaleProcedurePanel, SaleProcedureSummary } from "@/components/SaleProcedurePanel";
import {
  ListingActions,
  ListingOverview,
  ListingPracticalDetails,
  ListingDescription,
  ListingLocation,
} from "@/components/sale-detail/SaleListing";
import { ListingBudget } from "@/components/sale-detail/ListingBudget";
import listingStyles from "@/components/sale-detail/SaleListing.module.css";
import { fetchPrecomputedMarketEstimate } from "@/lib/client-api";
import { formatDate, formatPrice, formatPricePerM2, propertyTypeLabel } from "@/lib/format";
import type { MarketEstimate } from "@/lib/market.functions";
import { marketReferenceConfidence } from "@/lib/market-comparables-analysis";
import {
  computeRecommendedCeilings,
  computeAcquisitionCosts,
  type MarketCeilingResult,
  DEFAULT_MARKET_CEILING_SCENARIO,
  DEFAULTS,
  estimateWorksBudget,
} from "@/lib/profitability";
import { Link } from "@/lib/router-compat";
import { listingCoordinates } from "@/lib/sale-listing";
import { propertyImages } from "@/lib/sale-media";
import { saleDisplayTitle } from "@/lib/sale-title";
import {
  getSaleProcedure,
  lawyerRequirementLabel,
  participationModeLabel,
  saleIsTribunalVenue,
  saleProcedureIsConfirmed,
} from "@/lib/sale-procedure";
import { getMarketValuationSurfaces } from "@/lib/surface";
import type { AuctionSale, SaleRisk } from "@/lib/types";

const SaleTribunalHistory = dynamic(
  () => import("@/components/SaleTribunalHistory").then((module) => module.SaleTribunalHistory),
  {
    loading: () => (
      <p className="p-6 text-sm text-muted-foreground">Chargement de l’historique du tribunal…</p>
    ),
  },
);
const OutcomeForecast = dynamic(() =>
  import("@/components/OutcomeForecast").then((module) => module.OutcomeForecast),
);
const PropertyReportActions = dynamic(
  () => import("@/components/PropertyReportActions").then((module) => module.PropertyReportActions),
  {
    loading: () => (
      <p className="mt-3 text-sm text-muted-foreground">Chargement des actions du rapport…</p>
    ),
  },
);
const BidCeilingAssistant = dynamic(
  () => import("@/components/BidCeilingAssistant").then((module) => module.BidCeilingAssistant),
  { loading: () => <div className="h-80 animate-pulse rounded-lg bg-muted" /> },
);
const PhotoCarouselDialog = dynamic(
  () => import("@/components/PhotoCarouselDialog").then((module) => module.PhotoCarouselDialog),
  { ssr: false },
);

type SaleDetailProps = {
  sale: AuctionSale;
  marketEstimateOverride?: MarketEstimate | null;
  returnTo?: string;
  backLabel?: string;
  publicDemo?: boolean;
  adjudicationStatisticsEnabled?: boolean;
};

export function AnalysisSaleDetailView({
  sale,
  marketEstimateOverride = null,
  returnTo = "/sales",
  backLabel = "Retour aux ventes",
  publicDemo = false,
  adjudicationStatisticsEnabled = false,
}: SaleDetailProps) {
  return (
    <SimplifiedSaleDetailView
      sale={sale}
      marketEstimateOverride={marketEstimateOverride}
      returnTo={returnTo}
      backLabel={backLabel}
      publicDemo={publicDemo}
      adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      access="analysis"
    />
  );
}

export function FreeSaleDetailView({ sale, returnTo = "/sales" }: SaleDetailProps) {
  return <SimplifiedSaleDetailView sale={sale} returnTo={returnTo} access="discovery" />;
}

function SimplifiedSaleDetailView({
  sale,
  marketEstimateOverride = null,
  returnTo,
  backLabel = "Retour aux ventes",
  publicDemo = false,
  adjudicationStatisticsEnabled = false,
  access,
}: SaleDetailProps & { access: "discovery" | "analysis" }) {
  const [calculationOpen, setCalculationOpen] = useState(false);
  const [simulation, setSimulation] = useState<BidSimulationSnapshot | null>(null);
  const { user, loading: authLoading } = useAuth();
  const valuationConflict = listingValuationConflict(sale);
  const activeSimulation =
    !valuationConflict &&
    !authLoading &&
    simulation?.saleId === sale.id &&
    simulation.ownerId === (user?.id ?? "guest-demo")
      ? simulation
      : null;
  const isTribunalSale = saleIsTribunalVenue(sale);
  const marketSurfaces = getMarketValuationSurfaces(sale);
  const surface = marketSurfaces.builtSurfaceM2;
  const marketQuery = useQuery({
    queryKey: ["precomputed-market-estimate", sale.id],
    queryFn: () => fetchPrecomputedMarketEstimate({ saleId: sale.id }),
    enabled: access === "analysis" && marketEstimateOverride == null && !valuationConflict,
    staleTime: 24 * 60 * 60_000,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" && !query.state.data.estimate ? 15_000 : false,
  });
  const marketEstimate = valuationConflict
    ? null
    : (marketEstimateOverride ?? marketQuery.data?.estimate ?? null);
  const recommendations = useMemo(
    () =>
      computeRecommendedCeilings({
        surface,
        price: Math.max(0, sale.starting_price_eur ?? 0),
        fpt: DEFAULTS.fpt,
        scenario: DEFAULT_MARKET_CEILING_SCENARIO,
        medianPricePerM2:
          isTribunalSale && marketEstimate?.actionable === true
            ? marketEstimate.medianPricePerM2
            : null,
        p25PricePerM2:
          isTribunalSale && marketEstimate?.actionable === true
            ? marketEstimate.p25PricePerM2
            : null,
        p75PricePerM2:
          isTribunalSale && marketEstimate?.actionable === true
            ? marketEstimate.p75PricePerM2
            : null,
      }),
    [isTribunalSale, marketEstimate, sale.starting_price_eur, surface],
  );
  const worksBudget = estimateWorksBudget(surface, "rafraichissement");

  return (
    <main className={listingStyles.page}>
      <div className={listingStyles.container}>
        <div className={listingStyles.topbar}>
          <Link
            href={returnTo ?? "/sales"}
            className="inline-flex min-h-10 items-center gap-2 rounded-md text-sm font-semibold text-brand-navy transition-colors hover:text-gold-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {backLabel}
          </Link>
          <ListingActions sale={sale} publicDemo={publicDemo} />
        </div>

        <div className={listingStyles.upper}>
          <PropertyIdentity key={sale.id} sale={sale} publicDemo={publicDemo} />
          <div className={listingStyles.stack}>
            <ListingPracticalDetails sale={sale} />
            <SaleProcedureSummary sale={sale} showBadge={false} />
          </div>
        </div>

        <ListingQualityNotice sale={sale} />

        <div className={listingStyles.analysisHeading}>
          <ChartNoAxesCombined className="h-6 w-6 shrink-0 text-slate-500" aria-hidden />
          <div>
            <h2 className={listingStyles.heading}>Votre analyse ImmoJudis</h2>
            <p className={listingStyles.muted}>Marché local, risques et mise plafond</p>
          </div>
        </div>

        {access === "analysis" &&
        marketEstimateOverride == null &&
        !marketEstimate &&
        (marketQuery.data?.error || marketQuery.error) ? (
          <div
            className="mt-4 flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div>
                <p className="font-semibold">Estimation de marché à compléter</p>
                <p className="mt-0.5">
                  {marketQuery.data?.error ??
                    (marketQuery.error instanceof Error
                      ? marketQuery.error.message
                      : "L’estimation est momentanément indisponible.")}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void marketQuery.refetch()}
              disabled={marketQuery.isFetching}
              className="min-h-10 shrink-0 rounded-lg border border-amber-400 bg-white px-3 font-semibold transition-colors hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60"
            >
              {marketQuery.isFetching ? "Calcul en cours…" : "Relancer l’estimation"}
            </button>
          </div>
        ) : null}

        <section id="summary" className="mt-4 scroll-mt-36">
          {valuationConflict ? (
            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-6">
              <h2 className="text-xl font-semibold">
                Estimation suspendue : données contradictoires
              </h2>
              <p className="mt-3 text-sm">{valuationConflict}</p>
              <a
                href={access === "analysis" ? "#information-agent" : "#rendez-vous"}
                className="mt-3 inline-block underline"
              >
                {access === "analysis"
                  ? "Faire vérifier les caractéristiques"
                  : "Consulter les coordonnées du dossier"}
              </a>
            </div>
          ) : access === "analysis" && isTribunalSale ? (
            <AnalysisDecisionPanel
              sale={sale}
              marketEstimate={marketEstimate}
              marketLoading={marketQuery.isLoading && marketEstimate == null}
              worksBudget={
                activeSimulation?.worksKnown === false
                  ? null
                  : (activeSimulation?.works ?? (surface == null ? null : worksBudget))
              }
              recommendedCeiling={
                (activeSimulation?.result ?? recommendations.withRefreshWorks).maxBid
              }
              ceilingAvailable={
                (activeSimulation?.result ?? recommendations.withRefreshWorks).available
              }
              onAdjust={() => setCalculationOpen(true)}
            />
          ) : access === "analysis" ? (
            <SaleSpecificBudgetNotice />
          ) : (
            <DiscoveryDecisionPanel worksBudget={surface == null ? null : worksBudget} />
          )}
        </section>

        {access === "analysis" && isTribunalSale && !publicDemo && !valuationConflict ? (
          <section
            aria-label="Sauvegarde et export du rapport"
            className="mt-4 rounded-lg border border-slate-200 bg-white p-4"
          >
            <h2 className="text-base font-semibold text-brand-navy">Conserver votre analyse</h2>
            <p className="mt-1 text-sm text-slate-600">
              Sauvegardez le rapport du dossier ou exportez-le en PDF avec le scénario courant du
              simulateur.
            </p>
            <PropertyReportActions
              saleId={sale.id}
              compact
              simulation={
                activeSimulation?.result.available ? activeSimulation.reportInput : undefined
              }
              requireSimulation
            />
          </section>
        ) : null}
      </div>

      {access === "analysis" ? (
        <AnalysisContent
          sale={sale}
          marketEstimate={marketEstimate}
          marketLoading={marketQuery.isLoading && marketEstimate == null}
          recommendations={recommendations}
          simulation={activeSimulation}
          onSimulationChange={setSimulation}
          surface={surface}
          calculationOpen={calculationOpen}
          onCalculationOpenChange={setCalculationOpen}
          publicDemo={publicDemo}
          adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
        />
      ) : (
        <>
          <div className={listingStyles.container}>
            <div className={listingStyles.lower}>
              <div className={listingStyles.stack}>
                <ListingDescription sale={sale} />
                <ListingLocation sale={sale} />
              </div>
              <ListingBudget sale={sale} />
            </div>

            <SaleProcedurePanel sale={sale} />
          </div>
          {isTribunalSale ? <SaleTribunalHistory sale={sale} /> : null}
          <DiscoveryContinuation />
        </>
      )}
    </main>
  );
}

function PropertyIdentity({
  sale,
  publicDemo = false,
}: {
  sale: AuctionSale;
  publicDemo?: boolean;
}) {
  const images = propertyImages(sale.media);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  const [mobilePhotoIndex, setMobilePhotoIndex] = useState(0);
  const mobileCarouselRef = useRef<HTMLDivElement>(null);
  const title = saleDisplayTitle(sale, propertyTypeLabel(sale.property_type));
  const address = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
  const mapLocation = listingCoordinates(sale);

  const handleMobileCarouselScroll = (event: UIEvent<HTMLDivElement>) => {
    const carousel = event.currentTarget;
    if (!carousel.clientWidth) return;
    const nextIndex = Math.round(carousel.scrollLeft / carousel.clientWidth);
    setMobilePhotoIndex(Math.min(Math.max(nextIndex, 0), images.length - 1));
  };

  const goToMobilePhoto = (nextIndex: number) => {
    const carousel = mobileCarouselRef.current;
    if (!carousel || !images.length) return;
    const clampedIndex = Math.min(Math.max(nextIndex, 0), images.length - 1);
    carousel.scrollTo({ left: clampedIndex * carousel.clientWidth, behavior: "smooth" });
    setMobilePhotoIndex(clampedIndex);
  };

  return (
    <div className="min-w-0">
      <div className={listingStyles.photo}>
        {images[0] ? (
          <>
            <div
              ref={mobileCarouselRef}
              role="region"
              aria-roledescription="carrousel"
              aria-label={`Photos de ${title}`}
              onScroll={handleMobileCarouselScroll}
              className="flex h-[clamp(15rem,65vw,22rem)] snap-x snap-mandatory scroll-smooth overflow-x-auto overscroll-x-contain bg-muted [-webkit-overflow-scrolling:touch] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
            >
              {images.map((image, index) => (
                <button
                  key={`${image.url}-${index}`}
                  type="button"
                  onClick={() => setGalleryIndex(index)}
                  className="group relative block h-full w-full max-w-full flex-none snap-start snap-always overflow-hidden bg-muted text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold"
                  aria-label={`Ouvrir la photo ${index + 1} sur ${images.length}`}
                >
                  <ListingPhoto
                    src={image.url}
                    alt={
                      index === 0
                        ? `Photo principale de ${title}`
                        : `Photo ${index + 1} de ${title}`
                    }
                    className="h-full w-full object-cover"
                    loading={index === 0 ? "eager" : "lazy"}
                    fetchPriority={index === 0 ? "high" : "low"}
                    decoding="async"
                    draggable={false}
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                </button>
              ))}
            </div>
            {images.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => goToMobilePhoto(mobilePhotoIndex - 1)}
                  disabled={mobilePhotoIndex === 0}
                  className="absolute left-3 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/70 bg-white/92 text-brand-navy shadow-lg backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:pointer-events-none disabled:opacity-35 md:hidden"
                  aria-label="Photo précédente"
                >
                  <ArrowLeft className="h-5 w-5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => goToMobilePhoto(mobilePhotoIndex + 1)}
                  disabled={mobilePhotoIndex === images.length - 1}
                  className="absolute right-3 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/70 bg-white/92 text-brand-navy shadow-lg backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:pointer-events-none disabled:opacity-35 md:hidden"
                  aria-label="Photo suivante"
                >
                  <ArrowRight className="h-5 w-5" aria-hidden />
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setGalleryIndex(0)}
              className="group relative hidden h-[360px] w-full overflow-hidden bg-muted text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold md:block"
              aria-label="Ouvrir la galerie photos"
            >
              <ListingPhoto
                src={images[0].url}
                fetchPriority="high"
                alt={`Photo principale de ${title}`}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.015]"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </button>
            {mapLocation ? (
              <div className="absolute bottom-8 left-3 z-10 md:bottom-4 md:left-4">
                <MapboxPreviewButton
                  mode="streetLevel"
                  lat={mapLocation.lat}
                  lng={mapLocation.lng}
                  label="Quartier 3D"
                  title="Vue 3D du quartier"
                  description={address || "Adresse de l'annonce"}
                  ariaLabel="Afficher la vue 3D Mapbox du quartier"
                  icon={MapPin}
                  className="inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                />
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setGalleryIndex(mobilePhotoIndex)}
              className="absolute bottom-8 right-3 z-10 inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold md:bottom-4 md:right-4"
              aria-label={`Ouvrir la galerie de ${images.length} photos`}
            >
              <Camera className="h-4 w-4" aria-hidden />
              <span className="md:hidden" aria-live="polite">
                {mobilePhotoIndex + 1} / {images.length}
              </span>
              <span className="hidden md:inline">
                {images.length} photo{images.length > 1 ? "s" : ""}
              </span>
            </button>
          </>
        ) : (
          <SaleVisual
            sale={sale}
            title={title}
            className="h-[250px] md:h-[360px] [&>span]:bottom-8 md:[&>span]:bottom-2"
            eager
          />
        )}
      </div>

      {images.length > 1 ? (
        <div className="mt-2 hidden grid-cols-3 gap-2 md:grid">
          {images.slice(1, 4).map((image, index) => (
            <button
              key={image.url}
              type="button"
              onClick={() => setGalleryIndex(index + 1)}
              className="h-20 overflow-hidden rounded-xl border border-brand-navy/10 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              aria-label={`Ouvrir la photo ${index + 2}`}
            >
              <ListingPhoto
                src={image.url}
                alt={`Photo ${index + 2} de ${title}`}
                compactFallback
                className="h-full w-full object-cover transition-transform duration-300 hover:scale-[1.03]"
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </button>
          ))}
        </div>
      ) : null}

      <ListingOverview sale={sale} publicDemo={publicDemo} />

      {galleryIndex != null ? (
        <PhotoCarouselDialog
          images={images.map((image, index) => ({
            id: `${image.url}-${index}`,
            url: image.url,
            alt: index === 0 ? `Photo principale de ${title}` : `Photo ${index + 1} de ${title}`,
            source: image.source,
          }))}
          initialIndex={galleryIndex}
          title={title}
          onClose={() => setGalleryIndex(null)}
        />
      ) : null}
    </div>
  );
}

function AnalysisDecisionPanel({
  sale,
  marketEstimate,
  marketLoading,
  worksBudget,
  recommendedCeiling,
  ceilingAvailable,
  onAdjust,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
  worksBudget: number | null;
  recommendedCeiling: number;
  ceilingAvailable: boolean;
  onAdjust: () => void;
}) {
  const ceiling = ceilingAvailable ? recommendedCeiling : null;
  const marketValue = marketEstimate?.estimatedValueEur ?? null;
  const markers = comparisonMarkerPositions({
    start: sale.starting_price_eur,
    ceiling,
    market: marketValue,
  });

  return (
    <aside className="rounded-[20px] border border-slate-200 bg-white p-5 sm:p-7 lg:p-8">
      <h2 className="text-center text-2xl font-semibold text-brand-navy sm:text-3xl">
        Votre mise plafond recommandée
      </h2>
      <div className="mt-5 text-center text-[clamp(2rem,7vw,3.5rem)] font-bold leading-tight text-brand-navy">
        {ceiling != null ? formatPrice(ceiling) : "À compléter"}
      </div>

      <div className="mt-6 rounded-lg border border-gold/45 bg-[#fff8ef] p-4 sm:p-5">
        <div className="flex items-start gap-4">
          <Wrench className="mt-1 h-8 w-8 shrink-0 text-gold-soft" aria-hidden />
          <div>
            <p className="font-display text-2xl font-semibold leading-tight text-gold-soft sm:text-3xl">
              Travaux inclus : {worksBudget == null ? "À chiffrer" : formatPrice(worksBudget)}
            </p>
            <p className="mt-1 text-sm text-brand-navy/68 sm:text-base">
              Budget retenu dans votre scénario ; ajustable dans le simulateur.
            </p>
          </div>
        </div>
      </div>

      <p className="mt-5 text-center text-sm leading-relaxed text-brand-navy/76 sm:text-base">
        Plafond indicatif selon les hypothèses de marché, de frais et de travaux. Il ne garantit pas
        votre marge.
      </p>
      {getMarketValuationSurfaces(sale).builtSurfaceEstimated && (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          Calcul provisoire : {getMarketValuationSurfaces(sale).builtSurfaceAssumption}. Faites
          confirmer la surface avant de retenir ce plafond.
        </p>
      )}
      {ceiling != null && sale.starting_price_eur != null && ceiling < sale.starting_price_eur ? (
        <p
          role="status"
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm font-semibold text-amber-950"
        >
          Ce scénario donne un plafond inférieur à la mise à prix de{" "}
          {formatPrice(sale.starting_price_eur)}. Vos hypothèses ne permettent pas d’enchérir au
          prix de départ.
        </p>
      ) : null}
      {marketEstimate?.estimatedValueLowEur != null &&
      marketEstimate?.estimatedValueHighEur != null ? (
        <p className="mt-3 text-center text-sm text-slate-600">
          Fourchette de valeur estimée : {formatPrice(marketEstimate.estimatedValueLowEur)} –{" "}
          {formatPrice(marketEstimate.estimatedValueHighEur)}. Elle décrit l’incertitude de
          l’estimation, pas le prix d’adjudication attendu.
        </p>
      ) : null}

      <div className="mt-7">
        <dl className="grid grid-cols-3 gap-2 text-center">
          {markers.map((marker) => (
            <div key={marker.label}>
              <dt className="text-[11px] font-semibold text-brand-navy/70 sm:text-xs">
                {marker.label}
              </dt>
              <dd
                className={`mt-1 font-display text-lg font-medium sm:text-2xl ${
                  marker.label === "Mise plafond" ? "text-gold-soft" : "text-brand-navy"
                }`}
              >
                {marker.value == null
                  ? marker.label === "Valeur estimée" && marketLoading
                    ? "Calcul…"
                    : "À compléter"
                  : formatPrice(marker.value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-8 grid gap-3 sm:grid-cols-[1fr_auto]">
        <a
          href="#calculation"
          onClick={onAdjust}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-gold-soft px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
        >
          <Target className="h-4 w-4" aria-hidden />
          Ajuster mes hypothèses
        </a>
        <a
          href="#why-this-ceiling"
          className="inline-flex min-h-12 items-center justify-center px-4 py-3 text-sm font-semibold text-gold-soft underline decoration-gold/45 underline-offset-8 hover:text-gold"
        >
          Voir le calcul
        </a>
      </div>
    </aside>
  );
}

function SaleSpecificBudgetNotice() {
  return (
    <div className={listingStyles.card}>
      <h3 className="text-lg font-semibold">Un chiffrage adapté à cette vente</h3>
      <p className={`${listingStyles.muted} mt-2`}>
        Le calcul automatique de mise plafond utilise un modèle de frais de vente au tribunal. Pour
        cette vente, vérifiez les frais auprès de l’organisateur et renseignez vos propres
        hypothèses dans le simulateur de budget.
      </p>
      <a href="#budget" className={`${listingStyles.textLink} mt-2`}>
        Préparer mon budget <ArrowRight className="h-4 w-4" aria-hidden />
      </a>
    </div>
  );
}

function DiscoveryDecisionPanel({ worksBudget }: { worksBudget: number | null }) {
  return (
    <aside className="rounded-lg border border-brand-navy/12 bg-white p-5 shadow-[0_22px_60px_rgba(72,104,132,0.14)] sm:p-7 lg:p-8">
      <h2 className="font-display text-3xl font-medium text-brand-navy sm:text-4xl">
        L'essentiel, gratuitement
      </h2>
      <p className="mt-6 font-display text-2xl font-medium text-brand-navy">Travaux estimés :</p>
      <div className="mt-1 font-display text-6xl font-medium leading-none text-gold-soft sm:text-7xl">
        {worksBudget == null ? "À chiffrer" : formatPrice(worksBudget)}
      </div>
      <p className="mt-4 text-sm leading-relaxed text-brand-navy/72 sm:text-base">
        Enveloppe globale de rafraîchissement. Le détail des postes est réservé à l'offre Analyse.
      </p>

      <div className="my-6 h-px bg-brand-navy/12" />

      <div className="rounded-lg border border-gold/35 bg-[#fffaf4] p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-1 h-6 w-6 shrink-0 text-brand-navy" aria-hidden />
          <div>
            <h3 className="font-display text-2xl font-semibold leading-tight text-brand-navy sm:text-3xl">
              Ne confondez pas mise à prix et bon prix
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-brand-navy/76 sm:text-base">
              Le prix de départ peut être supérieur au niveau du marché. Immojudis calcule la mise
              plafond indicative selon les hypothèses retenues pour la vente.
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3 rounded-md border border-gold/55 bg-white px-4 py-3">
          <LockKeyhole className="h-5 w-5 shrink-0 text-brand-navy/65" aria-hidden />
          <div>
            <p className="text-sm font-medium text-brand-navy">Mise plafond avec travaux</p>
            <p className="font-display text-2xl font-semibold text-gold-soft">
              Réservée à l'offre Analyse
            </p>
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-brand-navy/66">
          Estimation du bien · ventes comparables · détail du calcul · annuaire d'avocats
        </p>
        <BillingActions
          hideHelper
          className={`mt-5 [&>button]:w-full ${listingStyles.discoveryBilling}`}
        />
        <p className="mt-3 text-center text-xs font-medium text-brand-navy/75">
          30 jours · paiement unique · sans abonnement
        </p>
      </div>
    </aside>
  );
}

function comparisonMarkerPositions({
  start,
  ceiling,
  market,
}: {
  start: number | null;
  ceiling: number | null;
  market: number | null;
}) {
  const values = [start, ceiling, market].filter((value): value is number => value != null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = Math.max(1, max - min);
  const position = (value: number | null, fallback: number) =>
    value == null ? fallback : 8 + ((value - min) / span) * 84;

  return [
    { label: "Mise à prix", value: start, position: position(start, 8) },
    { label: "Mise plafond", value: ceiling, position: position(ceiling, 50) },
    { label: "Valeur estimée", value: market, position: position(market, 92) },
  ];
}

function DiscoveryContinuation() {
  return (
    <section className="mx-auto max-w-[1460px] px-4 pb-16 sm:px-6 lg:px-8">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="flex min-h-16 items-center gap-3 rounded-lg border border-brand-navy/12 bg-white px-5 py-4 shadow-sm">
          <Camera className="h-5 w-5 text-gold-soft" aria-hidden />
          <span className="font-display text-xl font-semibold text-brand-navy">Photos du bien</span>
          <CheckCircle2 className="ml-auto h-5 w-5 text-[#2f855a]" aria-hidden />
        </div>
        <Link
          to="/accompagnement"
          className="flex min-h-16 items-center gap-3 rounded-lg border border-gold/35 bg-[#fff9f1] px-5 py-4 text-brand-navy/65 shadow-sm transition-colors hover:border-gold hover:text-brand-navy"
        >
          <LockKeyhole className="h-5 w-5" aria-hidden />
          <span className="font-display text-xl font-semibold">
            Analyse complète réservée à l'offre Analyse
          </span>
          <ArrowRight className="ml-auto h-5 w-5" aria-hidden />
        </Link>
      </div>
    </section>
  );
}

type Recommendations = ReturnType<typeof computeRecommendedCeilings>;

function AnalysisContent({
  sale,
  marketEstimate,
  marketLoading,
  recommendations,
  surface,
  calculationOpen,
  onCalculationOpenChange,
  publicDemo,
  adjudicationStatisticsEnabled,
  simulation,
  onSimulationChange,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
  recommendations: Recommendations;
  surface: number | null;
  calculationOpen: boolean;
  onCalculationOpenChange: (open: boolean) => void;
  publicDemo: boolean;
  adjudicationStatisticsEnabled: boolean;
  simulation: BidSimulationSnapshot | null;
  onSimulationChange: (snapshot: BidSimulationSnapshot) => void;
}) {
  const { user } = useAuth();
  const valuationConflict = listingValuationConflict(sale);
  const tribunalSale = saleIsTribunalVenue(sale);
  const forecastQuery = useOutcomeGraphForecast(
    sale.id,
    !publicDemo && tribunalSale && !valuationConflict,
  );
  const showTribunalHistory = !publicDemo && tribunalSale;
  const hasVerifiedForecast =
    !publicDemo &&
    tribunalSale &&
    !valuationConflict &&
    forecastQuery.data?.forecast.status === "ready";
  const navigationItems = [
    ["#summary", "Synthèse"],
    ["#risks", "Risques & pièces"],
    ["#budget-analysis", "Budget"],
    ["#market", "Marché"],
    ...(showTribunalHistory ? [["#tribunal-history", "Historique"]] : []),
    ["#participation", "Démarches"],
    ["#lawyer", "Contacts"],
  ];

  return (
    <>
      <nav
        aria-label="Sections de l’annonce"
        className="sticky top-16 z-30 border-y border-brand-navy/10 bg-white/95 shadow-sm backdrop-blur"
      >
        <div className="mx-auto flex max-w-5xl justify-between overflow-x-auto px-4 sm:px-6">
          {navigationItems.map(([href, label]) => (
            <a
              key={href}
              href={href}
              onFocus={(event) =>
                event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })
              }
              className="whitespace-nowrap border-b-2 border-transparent px-3 py-4 text-sm font-semibold text-brand-navy/68 transition-colors hover:border-gold hover:text-brand-navy sm:px-4"
            >
              {label}
            </a>
          ))}
        </div>
      </nav>

      <RisksAndDocuments sale={sale} />
      <section
        id="documents"
        aria-label="Pièces du dossier"
        className="mx-auto max-w-[1260px] scroll-mt-36 px-4 pb-8 sm:px-6 lg:px-8"
      >
        <details className="group mt-4 rounded-lg border border-brand-navy/12 bg-white shadow-sm">
          <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-5 sm:px-7">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
              <FileText className="h-5 w-5" aria-hidden />
            </span>
            <span>
              <span className="block font-display text-2xl font-semibold text-brand-navy">
                Consulter les pièces du dossier
              </span>
              <span className="mt-1 block text-sm text-brand-navy/62">
                {collectSaleDocuments(sale).length > 0
                  ? "Consultez les pièces jointes ; vérifiez leur nature et leur date."
                  : "Aucune pièce attachée à cette annonce pour le moment."}
              </span>
            </span>
            <ChevronDown className="ml-auto h-5 w-5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-brand-navy/10 px-5 py-3 sm:px-7">
            {collectSaleDocuments(sale).length > 0 ? (
              <DocumentsList documents={collectSaleDocuments(sale)} />
            ) : (
              <a
                href="#information-agent"
                className="inline-flex min-h-11 items-center text-sm font-medium text-brand-navy underline underline-offset-4"
              >
                Demander les pièces du dossier
              </a>
            )}
          </div>
        </details>
      </section>

      <section
        id="budget-analysis"
        aria-label="Budget et hypothèses"
        className="mx-auto max-w-[1260px] scroll-mt-36 px-4 py-8 sm:px-6 lg:px-8"
      >
        {tribunalSale && !valuationConflict ? (
          <details
            id="calculation"
            open={calculationOpen}
            className="group scroll-mt-36 rounded-lg border border-brand-navy/12 bg-white shadow-sm"
            onToggle={(event) => onCalculationOpenChange(event.currentTarget.open)}
          >
            <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-5 sm:px-7">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
                <Target className="h-5 w-5" aria-hidden />
              </span>
              <span>
                <span className="block font-display text-2xl font-semibold text-brand-navy">
                  Ajuster les hypothèses
                </span>
                <span className="mt-1 block text-sm text-brand-navy/62">
                  Travaux, profil de marge, frais et prix de marché au m².
                </span>
              </span>
              <ChevronDown className="ml-auto h-5 w-5 transition-transform group-open:rotate-180" />
            </summary>
            <div hidden={!calculationOpen}>
              <div className="border-t border-brand-navy/10 p-4 sm:p-7">
                <BidCeilingAssistant
                  sale={sale}
                  marketEstimateOverride={marketEstimate}
                  onSimulationChange={onSimulationChange}
                />
              </div>
            </div>
          </details>
        ) : null}
        <div className="mt-8">
          {tribunalSale && !valuationConflict ? (
            <CeilingExplanation
              recommendations={recommendations}
              surface={surface}
              resultOverride={simulation?.result}
              worksOverride={simulation?.works}
            />
          ) : (
            <ListingBudget sale={sale} />
          )}
        </div>
      </section>
      <section
        aria-label="Comparables de marché"
        className="border-y border-brand-navy/10 bg-[#f4f6f9]"
      >
        <div className="mx-auto max-w-[1260px] px-4 py-8 sm:px-6 lg:px-8">
          <MarketEvidence marketEstimate={marketEstimate} marketLoading={marketLoading} />
        </div>
      </section>
      {hasVerifiedForecast ? <OutcomeForecast forecastQuery={forecastQuery} /> : null}
      {showTribunalHistory && valuationConflict ? (
        <section
          id="tribunal-history"
          className="mx-auto max-w-[1260px] scroll-mt-36 px-4 py-8 sm:px-6 lg:px-8"
        >
          <h2 className="text-2xl font-semibold">Historique des enchères</h2>
          <p className="mt-3">
            Le type de bien doit être confirmé avant de sélectionner un historique comparable.
          </p>
        </section>
      ) : showTribunalHistory ? (
        <SaleTribunalHistory sale={sale} premium={adjudicationStatisticsEnabled} />
      ) : null}
      <div className={listingStyles.container}>
        <div className={listingStyles.lower}>
          <ListingDescription sale={sale} />
          <ListingLocation sale={sale} />
        </div>
        <SaleProcedurePanel sale={sale} />
      </div>
      <div className="border-b border-brand-navy/10 bg-[#eef7ff]">
        <div className="mx-auto max-w-[1260px] px-4 py-8 sm:px-6 lg:px-8">
          <DeferredInformationRequest
            key={`${sale.id}-${user?.id ?? "anonymous"}`}
            sale={sale}
            previewOnly={publicDemo}
          />
        </div>
      </div>
      <LawyerSection sale={sale} />
    </>
  );
}

function CeilingExplanation({
  recommendations,
  surface,
  resultOverride,
  worksOverride,
}: {
  recommendations: Recommendations;
  surface: number | null;
  resultOverride?: MarketCeilingResult;
  worksOverride?: number;
}) {
  const result = resultOverride ?? recommendations.withRefreshWorks;
  const works = worksOverride ?? recommendations.refreshWorksBudget;
  const ceilingCosts = computeAcquisitionCosts({
    price: result.maxBid,
    works,
    fpt: result.simulated.fpt,
  });
  const marketBase = result.available
    ? Math.round(result.marketReferencePricePerM2 * Math.max(0, surface ?? 0))
    : null;
  const safetyMargin =
    marketBase != null ? Math.round(marketBase * (result.safetyDiscountPct / 100)) : null;
  const rows = [
    ["Référence de marché du scénario", marketBase],
    ["Marge de sécurité", safetyMargin == null ? null : -safetyMargin],
    [
      "Frais estimés au plafond",
      result.available ? -Math.round(ceilingCosts.acquisitionFeesTotal) : null,
    ],
    ["Travaux inclus", -works],
  ] as const;

  return (
    <div id="why-this-ceiling" className="min-w-0 scroll-mt-36 lg:pr-10">
      <h2 className="font-display text-4xl font-medium text-brand-navy sm:text-5xl">
        Pourquoi {result.available ? formatPrice(result.maxBid) : "ce plafond"} ?
      </h2>
      <dl className="mt-7 border-y border-brand-navy/18">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-4 border-b border-brand-navy/12 py-3.5 last:border-b-0"
          >
            <dt className="text-sm font-medium text-brand-navy sm:text-base">{label}</dt>
            <dd
              className={`font-display text-xl font-semibold sm:text-2xl ${
                value != null && value < 0 ? "text-gold-soft" : "text-brand-navy"
              }`}
            >
              {value == null ? "À compléter" : signedPrice(value)}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-4 border-t border-brand-navy/50 py-5">
          <dt className="font-display text-2xl font-semibold text-brand-navy">
            Mise plafond recommandée
          </dt>
          <dd className="font-display text-3xl font-semibold text-brand-navy sm:text-4xl">
            {result.available ? formatPrice(result.maxBid) : "À compléter"}
          </dd>
        </div>
      </dl>
      <p className="mt-6 max-w-2xl text-sm leading-relaxed text-brand-navy/70 sm:text-base">
        Calcul selon les hypothèses du simulateur. Les frais sont estimés au prix plafond ; les
        arrondis peuvent produire un léger écart avec le total affiché.
      </p>
    </div>
  );
}

function signedPrice(value: number) {
  if (value < 0) return `− ${formatPrice(Math.abs(value))}`;
  return formatPrice(value);
}

function MarketEvidence({
  marketEstimate,
  marketLoading,
}: {
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
}) {
  const usesAddressHistory = marketEstimate?.comparableMode === "address_history";
  const comparables = usesAddressHistory
    ? (marketEstimate?.addressHistory ?? []).slice(0, 4).map((sale) => ({
        ...sale,
        distanceM: null,
        unitCount: null,
      }))
    : (marketEstimate?.recentTransactions?.slice(0, 4) ?? []);
  const usesAggregateStatistics = marketEstimate?.comparableMode === "geographic_aggregate";
  const usesParkingSales = marketEstimate?.comparableMode === "unit_sales";
  const sampleCount = usesAddressHistory
    ? (marketEstimate?.addressHistory.length ?? 0)
    : (marketEstimate?.sampleSize ?? 0);
  const sampleLabel = !marketEstimate
    ? "Échantillon indisponible"
    : usesAddressHistory
      ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} à cette adresse`
      : usesParkingSales
        ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} de stationnement`
        : usesAggregateStatistics
          ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} de référence`
          : `${sampleCount} vente${sampleCount > 1 ? "s" : ""} comparable${sampleCount > 1 ? "s" : ""}`;

  return (
    <div
      id="market"
      className="min-w-0 scroll-mt-36 border-t border-brand-navy/18 pt-8 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0"
    >
      <h2 className="font-display text-4xl font-medium text-brand-navy sm:text-5xl">
        Marché local
      </h2>
      <dl className="mt-7 grid gap-4">
        <MarketFact
          icon={<BadgeEuro className="h-5 w-5" />}
          label="Valeur estimée"
          value={
            marketEstimate?.estimatedValueEur
              ? formatPrice(marketEstimate.estimatedValueEur)
              : marketLoading
                ? "Calcul…"
                : "À compléter"
          }
        />
        <MarketFact
          icon={<ChartNoAxesCombined className="h-5 w-5" />}
          label={sampleLabel}
          value={
            marketEstimate?.medianUnitPriceEur
              ? `Médiane ${formatPrice(marketEstimate.medianUnitPriceEur)} / place`
              : marketEstimate?.medianPricePerM2
                ? `Médiane ${formatPricePerM2(marketEstimate.medianPricePerM2)}`
                : "Échantillon à compléter"
          }
        />
        <MarketFact
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Solidité des références"
          value={marketReferenceConfidence(marketEstimate).confidenceLabel}
        />
      </dl>

      {marketEstimate && (
        <div className="mt-5 space-y-2 text-sm leading-relaxed text-brand-navy/75">
          <p>
            Source : {marketEstimate.source} · Période de recherche : {marketEstimate.yearsBack} ans
            {usesAddressHistory
              ? " · Historique de la parcelle à cette adresse"
              : usesAggregateStatistics
                ? ` · Échelle ${aggregateScopeLabel(marketEstimate.geographyLevel)}`
                : ` · Rayon de recherche : ${marketEstimate.radiusM} m`}
            .
          </p>
          <p>
            Ce niveau décrit les données disponibles. Il ne garantit ni le prix de revente, ni
            l’état du bien, ni le résultat des enchères.
          </p>
          {usesAddressHistory && (
            <p>
              Repli sur l’historique d’adresse faute de comparables proches. Ces transactions
              peuvent concerner des lots différents ; elles ne prouvent pas une vente antérieure de
              ce logement.
            </p>
          )}
          {marketEstimate.qualityWarnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5" aria-label="Limites des données de marché">
              {marketEstimate.qualityWarnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {comparables.length ? (
        <div className="mt-7 rounded-2xl border border-slate-200 bg-white p-5">
          <h3 className="text-lg font-semibold">
            {usesAddressHistory
              ? "Historique des ventes à cette adresse"
              : "Ventes de référence à proximité"}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Transactions DVF · ces prix ne constituent pas des résultats d’adjudication.
          </p>
          <ul
            className="mt-4 divide-y divide-slate-200"
            aria-label={usesAddressHistory ? "Historique d’adresse" : "Comparables de marché"}
          >
            {comparables.map((item, index) => (
              <li
                key={`${item.date}-${item.totalPrice}-${index}`}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4"
              >
                <div>
                  <p className="text-sm font-semibold">
                    {usesParkingSales
                      ? `${item.unitCount ?? 1} place${(item.unitCount ?? 1) > 1 ? "s" : ""}`
                      : item.surface != null && item.surface > 0
                        ? `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(item.surface)} m²`
                        : "Surface non renseignée"}
                    {item.distanceM != null ? (
                      <span className="font-normal text-slate-500"> · à {item.distanceM} m</span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{formatDate(item.date)}</p>
                </div>
                <p className="text-lg font-bold">{formatPrice(item.totalPrice)}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-7 border-y border-brand-navy/12 py-5 text-sm leading-relaxed text-brand-navy/64">
          {usesAggregateStatistics
            ? `Estimation indicative fondée sur la médiane DVF à l’échelle ${aggregateScopeLabel(marketEstimate?.geographyLevel)}. Les ventes détaillées apparaîtront dès qu’un échantillon local homogène sera disponible.`
            : "Les ventes comparables seront affichées ici dès qu'un échantillon homogène est disponible."}
        </p>
      )}
    </div>
  );
}

function aggregateScopeLabel(level: MarketEstimate["geographyLevel"]): string {
  if (level === "commune") return "de la commune";
  if (level === "epci") return "de l’intercommunalité";
  return "du département";
}

function MarketFact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3">
      <span className="text-gold-soft" aria-hidden>
        {icon}
      </span>
      <dt className="text-sm font-medium text-brand-navy sm:text-base">{label}</dt>
      <dd className="text-right text-sm font-semibold text-brand-navy sm:text-base">{value}</dd>
    </div>
  );
}

function RisksAndDocuments({ sale }: { sale: AuctionSale }) {
  const risks = sale.risks ?? [];
  const documents = collectSaleDocuments(sale);
  const rows = [
    ...risks.map((risk) => riskRow(risk)),
    {
      key: "documents",
      icon: <FileText className="h-5 w-5" />,
      label: "Pièces du dossier à consulter",
      source: "Vérifiez notamment le cahier des conditions de vente",
      status:
        documents.length > 0
          ? `${documents.length} pièce(s) consultable(s)`
          : "Aucune pièce attachée",
      complete: documents.length > 0,
      href: documents.length > 0 ? "#documents" : "#information-agent",
      action: documents.length > 0 ? "Consulter les pièces" : "Demander les pièces manquantes",
    },
  ];

  return (
    <section id="risks" className="scroll-mt-36 border-b border-brand-navy/10 bg-white">
      <div className="mx-auto max-w-[1260px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <h2 className="font-display text-4xl font-medium text-brand-navy sm:text-5xl">
          Les points à sécuriser avant la vente
        </h2>
        <div className="mt-7 divide-y divide-brand-navy/12 border-y border-brand-navy/14">
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_13rem] sm:items-center sm:gap-5"
            >
              <div className="flex items-center gap-3 font-semibold text-brand-navy">
                <span className="text-gold-soft" aria-hidden>
                  {row.icon}
                </span>
                {row.label}
              </div>
              <div className="space-y-2 pl-8 text-sm text-brand-navy/75 sm:pl-0">
                <div>{row.source}</div>
                <a
                  href={row.href}
                  className="inline-block font-medium text-brand-navy underline underline-offset-4"
                >
                  {row.action}
                </a>
              </div>
              <div
                className={`flex items-center gap-2 pl-8 text-sm font-medium sm:pl-0 ${
                  row.complete ? "text-[#237a4b]" : "text-[#9a5d15]"
                }`}
              >
                {row.complete ? (
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                ) : (
                  <CircleAlert className="h-4 w-4" aria-hidden />
                )}
                {row.status}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function riskRow(risk: SaleRisk) {
  const evidence = riskEvidence(risk);
  const renderProof = (proof: (typeof evidence.proofs)[number], index: number) => (
    <div key={index}>
      {proof.url ? (
        <a
          href={proof.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4"
        >
          {proof.label} (nouvel onglet)
        </a>
      ) : (
        <span>{proof.label}</span>
      )}
      {proof.page != null && <span> · page {proof.page}</span>}
      {proof.excerpt && (
        <blockquote className="mt-1 border-l-2 border-brand-navy/20 pl-3">
          {proof.excerpt}
        </blockquote>
      )}
    </div>
  );
  const source = (
    <div className="space-y-3">
      {renderProof(evidence.proofs[0], 0)}
      {evidence.proofs.length > 1 && (
        <details>
          <summary className="cursor-pointer font-medium underline underline-offset-4">
            Voir les {evidence.proofs.length - 1} autres extraits
          </summary>
          <div className="mt-3 space-y-3">{evidence.proofs.slice(1).map(renderProof)}</div>
        </details>
      )}
      <p>{evidence.action}</p>
    </div>
  );

  return {
    key: `${risk.risk_type}-${risk.risk_label}`,
    icon: risk.risk_type.toLowerCase().includes("work") ? (
      <Wrench className="h-5 w-5" />
    ) : (
      <CircleAlert className="h-5 w-5" />
    ),
    label: risk.risk_label,
    source,
    status: risk.severity != null && risk.severity >= 4 ? "Prioritaire" : "À vérifier",
    complete: false,
    href: "#information-agent",
    action: "Demander une confirmation",
  };
}

function LawyerSection({ sale }: { sale: AuctionSale }) {
  const procedure = getSaleProcedure(sale);
  const saleStatus = listingSaleStatus(sale);
  const isJudicial = procedure.venueType === "tribunal" && saleProcedureIsConfirmed(procedure);
  const showLawyerDirectory = isJudicial && !saleStatus;
  const organizerName = procedure.organizerName?.trim() || null;
  const hasOrganizerContact = Boolean(procedure.organizerContact?.trim());
  const isPersistedSale =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sale.id);
  const directoryHref = isPersistedSale
    ? `/avocats?saleId=${encodeURIComponent(sale.id)}&city=${encodeURIComponent(sale.city ?? "")}`
    : `/avocats?city=${encodeURIComponent(sale.city ?? "")}`;

  return (
    <section id="lawyer" className="scroll-mt-36 bg-white">
      <div className="mx-auto max-w-[1380px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div className="grid gap-7 rounded-lg border border-[#a9c9df] bg-[#eef7ff] p-6 sm:p-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(420px,1.15fr)] lg:items-center">
          <div>
            <h2 className="font-display text-3xl font-medium leading-tight text-brand-navy sm:text-4xl">
              {saleStatus
                ? saleStatus
                : isJudicial
                  ? "Prêt à enchérir ? Mandatez l’avocat compétent."
                  : "Préparez votre participation avec l’organisateur."}
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-brand-navy/70 sm:text-base">
              {saleStatus
                ? "Contactez l’organisateur pour confirmer le résultat ou les suites de la vente avant de préparer une participation."
                : isJudicial
                  ? "La représentation par avocat est obligatoire : il vérifie le dossier, reçoit votre mandat et porte les enchères."
                  : `${lawyerRequirementLabel(procedure)}. Participation ${participationModeLabel(procedure.participationMode).toLowerCase()} selon les conditions de la vente.`}
            </p>
          </div>
          <div className="rounded-lg border border-brand-navy/14 bg-white p-5 shadow-sm sm:flex sm:items-center sm:gap-5">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
              <Scale className="h-6 w-6" aria-hidden />
            </span>
            <div className="mt-3 min-w-0 flex-1 sm:mt-0">
              <p className="font-display text-2xl font-semibold text-brand-navy">
                {showLawyerDirectory
                  ? (procedure.eligibleBar ?? sale.tribunal_city ?? "Barreau compétent")
                  : (organizerName ?? "Organisateur à confirmer")}
              </p>
              <p className="mt-1 text-sm text-brand-navy/70">
                {showLawyerDirectory
                  ? "Avocats référencés par Immojudis"
                  : hasOrganizerContact
                    ? "Coordonnées mentionnées dans le dossier"
                    : "Coordonnées non renseignées"}
              </p>
            </div>
            {showLawyerDirectory ? (
              <a
                href={directoryHref}
                className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gold-soft sm:mt-0"
              >
                Voir les avocats disponibles
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
            ) : (
              <a
                href={hasOrganizerContact ? "#rendez-vous" : "#information-agent"}
                className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md bg-brand-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gold-soft sm:mt-0"
              >
                {hasOrganizerContact
                  ? "Consulter les coordonnées du dossier"
                  : "Demander les coordonnées"}
              </a>
            )}
          </div>
          {isPersistedSale && isJudicial && !saleStatus ? (
            <div className="lg:col-start-2">
              <LawyerReferralButton saleId={sale.id} className="min-h-11 w-full sm:w-auto" />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
