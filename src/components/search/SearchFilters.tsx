import dynamic from "next/dynamic";
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
import { mapboxStaticImageUrl } from "@/lib/mapbox";
import { firstPropertyImage, shouldRejectRenderedPropertyImage } from "@/lib/sale-media";
import { cleanSaleTitle, saleDisplayTitle } from "@/lib/sale-title";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { isNew } from "@/lib/dates";
import type { AuctionSale } from "@/lib/types";
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
import { SearchDraft, toggleValue } from "./search-page-state";
import { SaleTypeFilter } from "./SaleTypeFilter";
export function MoreFiltersModal({
  open,
  draft,
  setDraft,
  activeFiltersCount,
  onClose,
  onReset,
}: {
  open: boolean;
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  activeFiltersCount: number;
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <>
      {open ? (
        <div
          className={`${entryMotion.fadeIn} fixed inset-0 z-50 bg-[#132238]/55 p-0 backdrop-blur-sm sm:p-4`}
        >
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="Fermer les filtres"
            onClick={onClose}
          />
          <MobileFilterDrawer
            draft={draft}
            setDraft={setDraft}
            activeFiltersCount={activeFiltersCount}
            onClose={onClose}
            onReset={onReset}
          />
        </div>
      ) : null}
    </>
  );
}

export function MobileFilterDrawer({
  draft,
  setDraft,
  activeFiltersCount,
  onClose,
  onReset,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  activeFiltersCount: number;
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-labelledby="more-filters-title"
      className="relative ml-auto flex h-full w-full max-w-3xl flex-col overflow-hidden bg-white shadow-2xl sm:rounded-md"
    >
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-[#132238]/10 px-4">
        <div>
          <h2 id="more-filters-title" className="text-base font-extrabold text-[#132238]">
            Filtres avancés
          </h2>
          <p className="text-xs font-semibold text-[#667482]">
            {activeFiltersCount.toLocaleString("fr-FR")} filtre actif
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-10 w-10 cursor-pointer place-items-center rounded-md border border-[#d6e0dc] bg-white transition-colors hover:bg-[#f4f7f9]"
          aria-label="Fermer"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mb-5">
          <SaleTypeFilter
            value={draft.saleType}
            onChange={(saleType) =>
              setDraft((current) => ({
                ...current,
                saleType,
                tribunal: !saleType || saleType === "tribunal" ? current.tribunal : "",
              }))
            }
          />
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <AdvancedGroup title="Localisation">
            <FilterField label="Département">
              <Input
                value={draft.department}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, department: event.target.value }))
                }
                placeholder="33 ou Gironde"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Autour de">
              <Input
                value={draft.aroundAddress}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    aroundAddress: event.target.value,
                    aroundRadius:
                      event.target.value && !current.aroundRadius ? "15" : current.aroundRadius,
                  }))
                }
                placeholder="Adresse, ville ou tribunal"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Rayon km">
              <Input
                inputMode="numeric"
                value={draft.aroundRadius}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, aroundRadius: event.target.value }))
                }
                placeholder="15"
                className="h-10 bg-white"
              />
            </FilterField>
          </AdvancedGroup>

          <AdvancedGroup title="Prix et surface">
            <FilterField label="Surface minimum">
              <Input
                inputMode="numeric"
                value={draft.minSqft}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, minSqft: event.target.value }))
                }
                placeholder="60"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Surface maximum">
              <Input
                inputMode="numeric"
                value={draft.maxSqft}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxSqft: event.target.value }))
                }
                placeholder="180"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Prix/m² max">
              <Input
                inputMode="numeric"
                value={draft.maxPricePerM2}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxPricePerM2: event.target.value }))
                }
                placeholder="3500"
                className="h-10 bg-white"
              />
            </FilterField>
          </AdvancedGroup>

          <AdvancedGroup title="Statut et analyse">
            <FilterField label="Occupation">
              <select
                value={draft.occupancy || "all"}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    occupancy: event.target.value === "all" ? "" : event.target.value,
                  }))
                }
                className="form-input h-10 w-full cursor-pointer bg-white text-sm"
              >
                <option value="all">Toutes</option>
                <option value="free">Libre</option>
                <option value="occupied">Occupé</option>
                <option value="rented">Loué</option>
              </select>
            </FilterField>
            <FilterField label="Score min">
              <Input
                inputMode="numeric"
                value={draft.minScore}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, minScore: event.target.value }))
                }
                placeholder="70"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Rendement min">
              <Input
                inputMode="numeric"
                value={draft.minYield}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, minYield: event.target.value }))
                }
                placeholder="5"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Décote min">
              <Input
                inputMode="numeric"
                value={draft.minMarketDiscount}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, minMarketDiscount: event.target.value }))
                }
                placeholder="30"
                className="h-10 bg-white"
              />
            </FilterField>
            <label className="flex cursor-pointer items-center gap-3 rounded-md border border-[#d6e0dc] bg-[#f8fbfd] px-3 py-2 text-sm font-bold text-[#132238]">
              <input
                type="checkbox"
                checked={draft.houseWithLand}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, houseWithLand: event.target.checked }))
                }
                className="h-4 w-4 accent-[#0f766e]"
              />
              Maison avec terrain
            </label>
            <div>
              <span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.12em] text-[#667482]">
                DPE
              </span>
              <div className="flex flex-wrap gap-1.5">
                {DPE_CLASSES.map((dpeClass) => (
                  <DpeChipToggle
                    key={dpeClass}
                    dpeClass={dpeClass}
                    active={draft.dpeClasses.includes(dpeClass)}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        dpeClasses: toggleValue(current.dpeClasses, dpeClass),
                      }))
                    }
                  />
                ))}
              </div>
            </div>
          </AdvancedGroup>

          <AdvancedGroup title="Mots-clés et statut">
            <FilterField label="Mots-clés">
              <Input
                value={draft.keywords}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, keywords: event.target.value }))
                }
                placeholder="jardin, garage, occupé..."
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Année de construction">
              <Input
                inputMode="numeric"
                value={draft.yearBuilt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, yearBuilt: event.target.value }))
                }
                placeholder="1990"
                className="h-10 bg-white"
              />
            </FilterField>
            <label className="flex cursor-pointer items-center gap-3 rounded-md border border-[#d6e0dc] bg-[#f8fbfd] px-3 py-2 text-sm font-bold text-[#132238]">
              <input
                type="checkbox"
                checked={draft.openHouse}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, openHouse: event.target.checked }))
                }
                className="h-4 w-4 accent-[#0f766e]"
              />
              Visite disponible
            </label>
          </AdvancedGroup>
        </div>

        <AdvancedGroup title="Types de biens" className="mt-5">
          <div className="flex flex-wrap gap-2">
            {HOME_TYPE_OPTIONS.map((option) => (
              <ChipToggle
                key={option.value}
                active={draft.homeTypes.includes(option.value)}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    homeTypes: toggleValue(current.homeTypes, option.value),
                  }))
                }
              >
                {option.label}
              </ChipToggle>
            ))}
          </div>
        </AdvancedGroup>

        <AdvancedGroup title="Statuts" className="mt-5">
          <div className="flex flex-wrap gap-2">
            {STATUS_OPTIONS.map((option) => (
              <ChipToggle
                key={option.value}
                active={draft.status.includes(option.value)}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    status: toggleValue(current.status, option.value),
                  }))
                }
              >
                {option.label}
              </ChipToggle>
            ))}
          </div>
        </AdvancedGroup>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-[#132238]/10 p-4 sm:flex-row sm:justify-between">
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-[#ead8c5] bg-[#fffaf2] px-4 text-sm font-bold text-[#8a5b24] transition-colors hover:border-[#c98d45]"
        >
          <RotateCcw className="h-4 w-4" />
          Réinitialiser
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 cursor-pointer items-center justify-center rounded-md bg-[#132238] px-4 text-sm font-bold text-white transition-colors hover:bg-[#1f3657]"
        >
          Afficher les résultats
        </button>
      </div>
    </aside>
  );
}

export function AdvancedGroup({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <h3 className="mb-3 text-sm font-extrabold text-[#132238]">{title}</h3>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

export function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1">
      <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[#667482]">
        {label}
      </span>
      {children}
    </label>
  );
}

export function ChipToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] ${
        active
          ? "border-[#0f766e] bg-[#0f766e] text-white"
          : "border-[#d6e0dc] bg-white text-[#132238] hover:border-[#0f766e]"
      }`}
    >
      {children}
    </button>
  );
}

export function DpeChipToggle({
  active,
  dpeClass,
  onClick,
}: {
  active: boolean;
  dpeClass: DpeClass;
  onClick: () => void;
}) {
  const color = dpeColor(dpeClass);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex h-9 min-w-9 cursor-pointer items-center justify-center rounded-md border px-2 text-sm font-extrabold transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]"
      style={{
        backgroundColor: active ? color?.background : "#ffffff",
        borderColor: color?.border,
        color: active ? color?.foreground : "#132238",
      }}
    >
      {dpeClass}
    </button>
  );
}

export function MobileMapToggle({
  activeFiltersCount,
  onOpenFilters,
  onOpenMap,
}: {
  activeFiltersCount: number;
  onOpenFilters: () => void;
  onOpenMap: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-2 gap-2 border-t border-[#132238]/10 bg-white/95 p-2 shadow-[0_-14px_34px_rgba(19,34,56,0.12)] backdrop-blur lg:hidden">
      <button
        type="button"
        onClick={onOpenFilters}
        className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-md px-3 text-sm font-extrabold text-[#132238] transition-colors hover:bg-[#f4f7f9]"
      >
        <ListFilter className="h-4 w-4" />
        Filtres
        {activeFiltersCount > 0 ? (
          <span className="rounded-full bg-[#0f766e] px-1.5 py-0.5 text-[10px] text-white">
            {activeFiltersCount}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        onClick={onOpenMap}
        className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-md bg-[#132238] px-4 text-sm font-extrabold text-white transition-colors hover:bg-[#1f3657]"
      >
        <Map className="h-4 w-4" />
        Carte
      </button>
    </div>
  );
}

export function NoResultsState() {
  return (
    <div className="rounded-md border border-[#d8dee4] bg-white p-10 text-center shadow-sm">
      <SearchIcon className="mx-auto h-8 w-8 text-[#0f766e]" />
      <h2 className="mt-4 text-xl font-extrabold text-[#132238]">Aucun dossier trouvé</h2>
      <p className="mt-2 text-sm font-medium text-[#55626f]">
        Aucune annonce référencée ne correspond à ces critères pour le moment. Essayez un autre type
        de vente, une autre zone ou élargissez votre budget.
      </p>
    </div>
  );
}

export function ErrorState({ error }: { error: Error }) {
  return (
    <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
      {error.message || "Erreur de chargement des résultats"}
    </div>
  );
}

export function ListingCardSkeleton() {
  return (
    <div className="grid overflow-hidden rounded-md border border-[#d8dee4] bg-white shadow-sm sm:grid-cols-[12.5rem_1fr]">
      <Skeleton className="aspect-[1.5] w-full rounded-none bg-[#eef2f4] sm:aspect-auto sm:min-h-[13rem]" />
      <div className="space-y-3 p-4">
        <div className="flex justify-between gap-3">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-7 w-1/2 bg-[#eef2f4]" />
            <Skeleton className="h-4 w-3/4 bg-[#eef2f4]" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-8 rounded-full bg-[#eef2f4]" />
            <Skeleton className="h-8 w-8 rounded-full bg-[#eef2f4]" />
          </div>
        </div>
        <Skeleton className="h-4 w-full bg-[#eef2f4]" />
        <Skeleton className="h-4 w-4/5 bg-[#eef2f4]" />
        <Skeleton className="h-5 w-24 bg-[#eef2f4]" />
      </div>
    </div>
  );
}

export function MapPanelSkeleton() {
  return (
    <div className="grid h-full min-h-[28rem] place-items-center bg-[#e7f4ef]">
      <div className="inline-flex items-center gap-2 rounded-md border border-[#cbded8] bg-white px-4 py-3 text-sm font-bold text-[#132238] shadow-lg">
        <LoaderCircle className="h-4 w-4 animate-spin text-[#0f766e]" />
        Chargement de la carte
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-[#132238]/10 px-4 py-8 text-xs font-semibold text-[#667482] sm:px-5">
      Les informations doivent être vérifiées dans les pièces officielles avant toute décision
      d’enchère.
    </footer>
  );
}
