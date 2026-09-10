import dynamic from "next/dynamic";
import { SaleProcedureBadge } from "@/components/SaleProcedurePanel";
import { getSaleProcedure, saleEventLabel } from "@/lib/sale-procedure";
import type * as React from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import entryMotion from "@/components/ui/entry-motion.module.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down.js";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import BedDouble from "lucide-react/dist/esm/icons/bed-double.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import LayoutPanelLeft from "lucide-react/dist/esm/icons/layout-panel-left.js";
import ListFilter from "lucide-react/dist/esm/icons/list-filter.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Ruler from "lucide-react/dist/esm/icons/ruler.js";
import SearchIcon from "lucide-react/dist/esm/icons/search.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useViewedSales } from "@/hooks/use-viewed-sales";
import { supabase } from "@/integrations/supabase/client";
import { Link, useLocation, useNavigate } from "@/lib/router-compat";
import {
  createWatchedZone as createWatchedZoneRequest,
  addFavoriteSale as addFavoriteSaleRequest,
  fetchDpeExplorer,
  exportSalesCsv,
  fetchFeatureEntitlements,
  fetchSalesStatistics,
  removeFavoriteSale as removeFavoriteSaleRequest,
} from "@/lib/client-api";
import { createAlert } from "@/lib/queries";
import { DPE_CLASSES, dpeColor, extractDpe, type DpeClass } from "@/lib/dpe";
import type { DpeExplorerResponse } from "@/lib/dpe-explorer";
import {
  formatDate,
  formatPrice,
  formatPricePerM2,
  occupancyLabel,
  propertyTypeLabel,
} from "@/lib/format";
import { geocodeAddress, pricePerM2, type GeoPoint } from "@/lib/geo";
import { SaleVisual } from "@/components/SaleVisual";
import { cleanSaleTitle, saleDisplayTitle } from "@/lib/sale-title";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { isNew } from "@/lib/dates";
import type { AuctionSale } from "@/lib/types";
import { MAX_COMPARED_SALES } from "@/lib/search/sale-comparison";
import type { WatchedZoneInput } from "@/lib/watched-zones";
import type { SalesStatisticsResponse } from "@/lib/sales-statistics";
import {
  DEFAULT_SEARCH_LIMIT,
  HOME_TYPE_OPTIONS,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  applyClientSearchFilters,
  compactPrice,
  countActiveSearchFilters,
  hasClientOnlyFilters,
  hasCoordinates,
  sortClientSearchResults,
} from "@/lib/search/search-filters";
import {
  areMapViewportsClose,
  shouldMapListFollowViewport,
  visibleSalesForMapViewport,
} from "@/lib/search/map-viewport-results";
import {
  mergeSalesSearch,
  salesSearchToUrlRecord,
  type SalesSearchParams,
  type SalesSearchUrlRecord,
  type SearchSortKey,
} from "@/lib/search/search-url-state";
import {
  fetchSearchCount,
  fetchSearchMapResults,
  fetchSearchResults,
} from "@/lib/search/search-service";
import type { MapViewportChange } from "./MapPanel";
import { SearchPagination } from "./SearchPagination";
import { ErrorState, ListingCardSkeleton, NoResultsState } from "./SearchFilters";
import { SearchStatistics } from "./search-page-state";
export function SearchStatisticsPanel({
  statistics,
  locked,
  dpeLocked,
  loading,
  dpeExplorer,
  dpeExplorerLoading,
  dpeExplorerError,
  dpeExplorerRequested,
  onLoadDpeExplorer,
}: {
  statistics: SearchStatistics;
  locked: boolean;
  dpeLocked: boolean;
  loading: boolean;
  dpeExplorer?: DpeExplorerResponse;
  dpeExplorerLoading: boolean;
  dpeExplorerError: string | null;
  dpeExplorerRequested: boolean;
  onLoadDpeExplorer: () => void;
}) {
  if (locked) {
    return (
      <div className="border-b border-[#132238]/10 bg-white px-4 py-4 sm:px-5">
        <h2 className="text-sm font-bold text-[#132238]">
          Repérez un bien, puis préparez votre analyse
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-[#667482]">
          Le compte gratuit ouvre la fiche et la localisation complète. Analyse ajoute les
          comparables, les risques et le calcul de votre mise plafond.
        </p>
        <Link
          to="/annonce-exemple"
          className="mt-2 inline-flex min-h-10 items-center text-sm font-bold text-[#0f766e] underline underline-offset-4"
        >
          Essayer une analyse complète sans compte
        </Link>
      </div>
    );
  }

  const items = [
    {
      label: "Prix médian",
      value: formatPrice(statistics.medianPrice),
      icon: <Building2 className="h-4 w-4" />,
    },
    {
      label: "Prix médian / m²",
      value: formatPricePerM2(statistics.medianPricePerM2),
      icon: <Ruler className="h-4 w-4" />,
    },
    {
      label: "Score moyen",
      value: statistics.averageScore == null ? "—" : `${Math.round(statistics.averageScore)}/100`,
      icon: <ShieldCheck className="h-4 w-4" />,
    },
    {
      label: "DPE repérés",
      value: statistics.dpeKnownCount.toLocaleString("fr-FR"),
      icon: <CalendarDays className="h-4 w-4" />,
      locked: dpeLocked,
    },
  ];

  return (
    <div className="border-b border-[#132238]/10 bg-white px-4 py-3 sm:px-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#132238]">
          <BarChart3 className="h-4 w-4" />
          Repères sur votre recherche
        </div>
        {locked ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-[#ead8c5] bg-[#fffaf2] px-2 py-1 text-[10px] font-bold text-[#8a5b24]">
            <LockKeyhole className="h-3 w-3" />
            Analyse
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div
            key={item.label}
            className="min-w-0 rounded-md border border-[#dce7ee] bg-[#f8fbfd] px-3 py-2"
          >
            <dt className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#667482]">
              <span className="text-[#0f766e]">{item.icon}</span>
              {item.label}
            </dt>
            <dd className="mt-0.5 text-sm font-extrabold tabular-nums text-[#132238]">
              {loading ? "…" : item.locked ? "Réservé à Analyse" : item.value}
            </dd>
          </div>
        ))}
      </dl>
      {!dpeLocked && !loading ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {DPE_CLASSES.map((dpeClass) => {
              const color = dpeColor(dpeClass);
              return (
                <span
                  key={dpeClass}
                  className="inline-flex min-h-7 items-center gap-1 rounded-md border px-2 text-xs font-bold"
                  style={{
                    backgroundColor: color?.background,
                    borderColor: color?.border,
                    color: color?.foreground,
                  }}
                >
                  {dpeClass}
                  <span className="tabular-nums">{statistics.dpeCounts[dpeClass]}</span>
                </span>
              );
            })}
            <button
              type="button"
              onClick={onLoadDpeExplorer}
              disabled={dpeExplorerLoading}
              className="ml-auto inline-flex min-h-7 items-center rounded-md border border-[#cbded8] bg-white px-2.5 text-xs font-extrabold text-[#0f766e] hover:border-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dpeExplorerLoading
                ? "Chargement DPE..."
                : dpeExplorerRequested
                  ? "Actualiser DPE"
                  : "Explorer DPE"}
            </button>
          </div>
          {dpeExplorer ? (
            <div className="mt-3 rounded-md border border-[#dce7ee] bg-white p-3">
              <div className="grid gap-2 text-xs sm:grid-cols-3">
                <DpeExplorerMetric label="DPE trouvés" value={dpeExplorer.summary.total} />
                <DpeExplorerMetric
                  label="Classes connues"
                  value={dpeExplorer.summary.knownClassCount}
                />
                <DpeExplorerMetric label="Points carte" value={dpeExplorer.summary.mapPointCount} />
              </div>
              {dpeExplorer.items.length ? (
                <div className="mt-3 divide-y divide-[#132238]/10 border-t border-[#132238]/10">
                  {dpeExplorer.items.slice(0, 3).map((item) => (
                    <div key={item.id} className="grid gap-1 py-2 text-xs sm:grid-cols-[1fr_auto]">
                      <div className="min-w-0">
                        <Link
                          className="font-bold text-[#132238] hover:text-[#0f766e]"
                          to={`/sales/${item.id}`}
                        >
                          {cleanSaleTitle(item.title) ?? "Vente judiciaire"}
                        </Link>
                        <div className="mt-0.5 text-[#667482]">
                          {[item.city, item.department, propertyTypeLabel(item.propertyType)]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                      <span className="font-extrabold text-[#0f766e]">
                        {item.dpeLabel ?? "DPE repéré"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 border-t border-[#132238]/10 pt-3 text-xs text-[#667482]">
                  Aucun DPE repéré avec ces filtres.
                </p>
              )}
            </div>
          ) : null}
          {dpeExplorerError ? (
            <p className="mt-2 text-xs font-bold text-red-700">{dpeExplorerError}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function DpeExplorerMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#667482]">{label}</div>
      <div className="mt-1 text-sm font-extrabold tabular-nums text-[#132238]">
        {value.toLocaleString("fr-FR")}
      </div>
    </div>
  );
}

export function SearchResultsList({
  sales,
  returnTo,
  locked,
  analysisLocked,
  isLoading,
  error,
  selectedSaleId,
  hoveredSaleId,
  onHover,
  onSelect,
  comparedSaleIds,
  comparisonDisabled,
  onToggleComparison,
}: {
  sales: AuctionSale[];
  returnTo: string;
  locked: boolean;
  analysisLocked: boolean;
  isLoading: boolean;
  error: Error | null;
  selectedSaleId: string | null;
  hoveredSaleId: string | null;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string | null) => void;
  comparedSaleIds: string[];
  comparisonDisabled: boolean;
  onToggleComparison: (sale: AuctionSale) => void;
}) {
  return (
    <div className="px-3 pb-24 pt-3 sm:px-5 lg:pb-6">
      {error ? <ErrorState error={error} /> : null}

      {!isLoading && sales.length === 0 && !error ? <NoResultsState /> : null}

      <div className="grid grid-cols-1 gap-3">
        {isLoading
          ? Array.from({ length: 8 }).map((_, index) => <ListingCardSkeleton key={index} />)
          : sales.map((sale, index) => (
              <ListingCard
                key={sale.id}
                sale={sale}
                returnTo={returnTo}
                locked={locked}
                analysisLocked={analysisLocked}
                active={selectedSaleId === sale.id || hoveredSaleId === sale.id}
                index={index}
                onHover={onHover}
                onSelect={onSelect}
                comparisonSelected={comparedSaleIds.includes(sale.id)}
                comparisonDisabled={
                  comparisonDisabled ||
                  (comparedSaleIds.length >= MAX_COMPARED_SALES &&
                    !comparedSaleIds.includes(sale.id))
                }
                onToggleComparison={onToggleComparison}
              />
            ))}
      </div>
    </div>
  );
}

export function ListingCard({
  sale,
  returnTo,
  locked,
  analysisLocked,
  active,
  index,
  onHover,
  onSelect,
  comparisonSelected = false,
  comparisonDisabled = false,
  onToggleComparison,
}: {
  sale: AuctionSale;
  returnTo: string;
  locked: boolean;
  analysisLocked: boolean;
  active: boolean;
  index: number;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string | null) => void;
  comparisonSelected?: boolean;
  comparisonDisabled?: boolean;
  onToggleComparison?: (sale: AuctionSale) => void;
}) {
  const displaySurface = getDisplaySurface(sale);
  const surface = getSaleSurface(sale).value;
  const { isViewed } = useViewedSales();
  const premiumLocked = locked || analysisLocked;
  const viewed = !locked && isViewed(sale.id);
  const fresh = !locked && isNew(sale.created_at);
  const title = locked
    ? `${propertyTypeLabel(sale.property_type)}${sale.city ? ` à ${sale.city}` : ""}`
    : saleDisplayTitle(sale);
  const location = locked
    ? [sale.city, sale.department].filter(Boolean).join(" · ")
    : [sale.address, sale.city, sale.department ? `(${sale.department})` : null]
        .filter(Boolean)
        .join(", ");
  const beds = sale.bedrooms_count ?? sale.rooms_count;
  const baths = sale.bathrooms_count;
  const riskCount = premiumLocked ? 0 : (sale.risks?.length ?? 0);
  const ppm = premiumLocked ? null : pricePerM2(sale.starting_price_eur, surface);
  const dpe = premiumLocked ? null : extractDpe(sale);
  const dpeTheme = dpeColor(dpe?.class);
  const procedure = getSaleProcedure(sale);
  const organizerLabel = locked
    ? "Fiche complète avec un compte gratuit"
    : procedure.venueType === "tribunal" && sale.tribunal_city
      ? `TJ ${sale.tribunal_city}`
      : (procedure.venueName ?? procedure.organizerName ?? "Organisateur à confirmer");
  const score = premiumLocked ? null : sale.investment_score;
  const scoreLabel = premiumLocked
    ? "Analyse"
    : score == null
      ? "À auditer"
      : `${Math.round(score)}`;
  const riskLabel = premiumLocked
    ? "Analyse"
    : riskCount > 1
      ? `${riskCount} alertes`
      : riskCount === 1
        ? "1 alerte"
        : "Faible";
  const riskTone =
    premiumLocked || riskCount > 1
      ? "text-[#8a5b00]"
      : riskCount === 1
        ? "text-[#9c642b]"
        : "text-[#0f766e]";

  return (
    <article
      onMouseEnter={() => onHover(sale.id)}
      onMouseLeave={() => onHover(null)}
      onFocusCapture={() => onHover(sale.id)}
      onBlurCapture={() => onHover(null)}
      style={{ "--entry-delay": `${Math.min(index * 25, 180)}ms` } as React.CSSProperties}
      className={`${entryMotion.riseIn} group relative grid h-full overflow-hidden rounded-md border bg-white shadow-[0_2px_8px_rgba(19,34,56,0.08)] transition duration-200 sm:grid-cols-[9.5rem_1fr] xl:grid-cols-[10.5rem_1fr] ${
        active
          ? "border-[#c98d45] shadow-[0_0_0_2px_rgba(201,141,69,0.22),0_14px_36px_rgba(19,34,56,0.14)]"
          : "border-[#d8e0e7] hover:border-[#c98d45] hover:shadow-md"
      } ${viewed ? "opacity-75" : ""}`}
    >
      <Link
        id={`sale-card-${sale.id}`}
        to="/sales/$id"
        params={{ id: sale.id }}
        search={{ from: returnTo }}
        onClick={() => onSelect(sale.id)}
        className="absolute inset-0 z-10 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0f766e]"
        aria-label={`Voir ${title}`}
      />
      <div className="relative aspect-[1.35] overflow-hidden bg-[#edf2f5] sm:aspect-auto sm:min-h-[12.25rem]">
        <ListingImage sale={sale} locked={false} title={title} />
        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          {locked ? (
            <ListingBadge tone="navy" icon={LockKeyhole}>
              Aperçu gratuit
            </ListingBadge>
          ) : analysisLocked ? (
            <ListingBadge tone="cream" icon={LockKeyhole}>
              Analyse verrouillée
            </ListingBadge>
          ) : fresh ? (
            <ListingBadge tone="teal">Nouveau</ListingBadge>
          ) : null}
          {sale.sale_date ? (
            <ListingBadge tone="cream">{formatDate(sale.sale_date)}</ListingBadge>
          ) : null}
        </div>
        {viewed ? (
          <span className="absolute right-3 top-3 rounded-md bg-white/95 px-2 py-1 text-[11px] font-bold text-[#55626f] shadow-sm">
            Vu
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#667482]">
              Mise à prix
            </div>
            <div className="mt-0.5 text-[22px] font-extrabold leading-tight text-[#132238]">
              {formatPrice(sale.starting_price_eur)}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-sm font-bold text-[#132238]">
              <MapPin className="h-4 w-4 shrink-0 text-[#0f766e]" />
              <span className="truncate">{location || "Localisation à préciser"}</span>
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            <ShareButton sale={sale} />
            <CompactFavoriteButton saleId={sale.id} locked={premiumLocked} />
          </div>
        </div>

        <div className="mt-2 min-w-0">
          <div className="mb-2">
            <SaleProcedureBadge sale={sale} />
          </div>
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-[#3d4b57]">
            {title}
          </h3>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-bold text-[#3d4b57]">
          <Metric icon={Landmark} label={organizerLabel} />
          <Metric
            icon={CalendarDays}
            label={
              locked
                ? formatDate(sale.sale_date)
                : `${saleEventLabel(procedure.venueType)} ${formatDate(sale.sale_date)}`
            }
          />
          <Metric
            icon={Ruler}
            label={displaySurface.value != null ? displaySurface.label : "Surface n.c."}
          />
          <Metric icon={BedDouble} label={beds != null ? `${beds} ch.` : "Ch. n.c."} />
        </div>

        <div
          className={`relative mt-3 grid grid-cols-3 overflow-hidden rounded-md border border-[#e2e8ee] bg-[#fbfdff] text-xs ${
            premiumLocked ? "select-none" : ""
          }`}
        >
          <ListingSignal
            label="Dossier"
            value={premiumLocked ? "Analyse" : "Vérifié"}
            tone={premiumLocked ? "text-[#8a5b24]" : "text-[#0f766e]"}
          />
          <ListingSignal label="Score" value={scoreLabel} tone="text-[#0f766e]" />
          <ListingSignal label="Risque" value={riskLabel} tone={riskTone} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[#667482]">
          {locked ? (
            <span>Compte gratuit : fiche et adresse · Analyse : calculs et pièces</span>
          ) : analysisLocked ? (
            <>
              <span className="rounded-md bg-[#f0f5f8] px-2 py-1">
                {propertyTypeLabel(sale.property_type)}
              </span>
              <span className="rounded-md border border-dashed border-[#c98d45] bg-[#fffaf2] px-2 py-1 text-[#8a5b24]">
                Analyse détaillée avec l’offre Analyse
              </span>
            </>
          ) : (
            <>
              <span className="rounded-md bg-[#f0f5f8] px-2 py-1">
                {propertyTypeLabel(sale.property_type)}
              </span>
              <span className="rounded-md bg-[#f0f5f8] px-2 py-1">
                {occupancyLabel(sale.occupancy_status)}
              </span>
              {ppm != null ? (
                <span className="rounded-md bg-[#f0f5f8] px-2 py-1">
                  {Math.round(ppm).toLocaleString("fr-FR")} €/m²
                </span>
              ) : null}
              {dpe?.class ? (
                <span
                  className="rounded-md border px-2 py-1 font-extrabold"
                  style={{
                    backgroundColor: dpeTheme?.background,
                    borderColor: dpeTheme?.border,
                    color: dpeTheme?.foreground,
                  }}
                >
                  DPE {dpe.class}
                </span>
              ) : null}
            </>
          )}
        </div>

        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
          <span className="line-clamp-1 text-[11px] font-bold text-[#8b949e]">
            {locked
              ? "Immojudis"
              : analysisLocked
                ? "Sources et preuves réservées au plan Analyse"
                : `Source ${sale.source_name || sale.primary_source || "publique"}${
                    sale.tribunal_city ? ` · ${sale.tribunal_city}` : ""
                  }`}
          </span>
          <div className="flex items-center gap-2">
            {onToggleComparison ? (
              <button
                type="button"
                aria-label={`Comparer ${title}`}
                aria-pressed={comparisonSelected}
                disabled={comparisonDisabled}
                title={
                  comparisonDisabled
                    ? "Retirez un bien de la sélection pour en ajouter un autre."
                    : undefined
                }
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleComparison(sale);
                }}
                className={`relative z-20 min-h-11 rounded-md border px-3 text-xs font-extrabold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0f766e] disabled:cursor-not-allowed disabled:opacity-50 ${comparisonSelected ? "border-[#0f766e] bg-[#e1f1ec] text-[#0f766e]" : "border-[#cbd5df] bg-white text-[#132238] hover:bg-[#f4faf8]"}`}
              >
                {comparisonSelected ? "Sélectionné ✓" : "Comparer"}
              </button>
            ) : null}
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#f4f7f9] px-2 py-1 text-[11px] font-extrabold text-[#132238]">
              Voir le détail
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

export function ListingImage({
  sale,
  locked,
  title,
}: {
  sale: AuctionSale;
  locked: boolean;
  title: string;
}) {
  return (
    <SaleVisual
      sale={sale}
      title={title}
      locked={locked}
      preferPhoto
      mapWidth={512}
      mapHeight={384}
    />
  );
}

export function ListingBadge({
  children,
  tone,
  icon: Icon,
}: {
  children: React.ReactNode;
  tone: "navy" | "teal" | "cream";
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const toneClass =
    tone === "teal"
      ? "bg-[#0f766e] text-white"
      : tone === "cream"
        ? "bg-[#fffaf2] text-[#8a5b24]"
        : "bg-[#132238] text-white";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-extrabold uppercase tracking-normal shadow-sm ${toneClass}`}
    >
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {children}
    </span>
  );
}

export function Metric({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-[#f3f7fa] px-2 py-1">
      <Icon className="h-3.5 w-3.5 shrink-0 text-[#0f766e]" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function ListingSignal({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <span className="min-w-0 border-r border-[#e2e8ee] px-2 py-2 last:border-r-0">
      <span className="block text-[9px] font-bold uppercase tracking-[0.08em] text-[#8b949e]">
        {label}
      </span>
      <span className={`mt-0.5 block truncate font-extrabold ${tone}`}>{value}</span>
    </span>
  );
}

export function ShareButton({ sale }: { sale: AuctionSale }) {
  async function share(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/sales/${sale.id}`
        : `/sales/${sale.id}`;

    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: saleDisplayTitle(sale, "Vente Immojudis"), url });
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        toast.success("Lien copié");
      }
    } catch {
      toast.error("Partage impossible");
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      className="relative z-20 grid h-8 w-8 cursor-pointer place-items-center rounded-full text-[#132238] transition-colors hover:bg-[#eef2f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]"
      aria-label="Partager cette vente"
    >
      <Share2 className="h-5 w-5" />
    </button>
  );
}

export function CompactFavoriteButton({ saleId, locked }: { saleId: string; locked: boolean }) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isFavorite, setIsFavorite] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user || locked) {
      setIsFavorite(false);
      return;
    }

    supabase
      .from("user_favorites")
      .select("sale_id")
      .eq("user_id", user.id)
      .eq("sale_id", saleId)
      .maybeSingle()
      .then(({ data }) => setIsFavorite(Boolean(data)));
  }, [locked, saleId, user]);

  async function toggle(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (loading) return;
    if (locked) {
      navigate({ to: "/accompagnement" });
      return;
    }
    if (!user) {
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "/sales";
      navigate({ to: "/login", search: { redirect } });
      return;
    }

    setBusy(true);
    try {
      if (isFavorite) {
        await removeFavoriteSaleRequest({ saleId });
        setIsFavorite(false);
      } else {
        await addFavoriteSaleRequest({ data: { saleId } });
        setIsFavorite(true);
      }
      queryClient.invalidateQueries({ queryKey: ["favorites", user.id] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={locked ? undefined : isFavorite}
      aria-label={
        locked
          ? "Favoris réservés au plan Analyse"
          : isFavorite
            ? "Ne plus suivre cette vente"
            : "Suivre cette vente"
      }
      className="relative z-20 grid h-8 w-8 cursor-pointer place-items-center rounded-full text-[#132238] transition-colors hover:bg-[#eef2f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {locked ? (
        <LockKeyhole className="h-4 w-4 text-[#8a5b24]" />
      ) : (
        <Heart className={`h-5 w-5 ${isFavorite ? "fill-[#c2410c] text-[#c2410c]" : ""}`} />
      )}
    </button>
  );
}
