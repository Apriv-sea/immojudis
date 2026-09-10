import dynamic from "next/dynamic";
import type * as React from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import { SearchDraft } from "./search-page-state";
import { SaleTypeFilter } from "./SaleTypeFilter";
import { saleTypeFilterLabel } from "@/lib/sale-types";
export function SearchHeader({
  search,
  draft,
  setDraft,
  displayCount,
  loadedCount,
  filteredCount,
  activeFiltersCount,
  mapListFollowsViewport,
  isLoading,
  isCountLoading,
  isFetching,
  geocoding,
  filtersOpen,
  savingAlert,
  alertsLocked,
  exportingCsv,
  csvExportLocked,
  wideMap,
  onFiltersOpenChange,
  onReset,
  onSaveSearch,
  onExportCsv,
  onSortChange,
  onToggleLayout,
}: {
  search: SalesSearchParams;
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  displayCount: number;
  loadedCount: number;
  filteredCount: number;
  activeFiltersCount: number;
  mapListFollowsViewport: boolean;
  isLoading: boolean;
  isCountLoading: boolean;
  isFetching: boolean;
  geocoding: boolean;
  filtersOpen: boolean;
  savingAlert: boolean;
  alertsLocked: boolean;
  exportingCsv: boolean;
  csvExportLocked: boolean;
  wideMap: boolean;
  onFiltersOpenChange: (open: boolean) => void;
  onReset: () => void;
  onSaveSearch: () => void;
  onExportCsv: () => void;
  onSortChange: (sort: SearchSortKey) => void;
  onToggleLayout: () => void;
}) {
  return (
    <header className="top-0 z-40 border-b border-[#132238]/10 bg-[#fbfdff] shadow-[0_10px_30px_rgba(19,34,56,0.12)] lg:sticky">
      <div className="bg-[#071a31] text-white">
        <div className="px-3 py-3 sm:px-5 lg:px-6">
          <div className="grid gap-3 lg:grid-cols-[max-content_minmax(20rem,1fr)_auto] lg:items-center">
            <div className="flex min-w-0 items-center gap-4">
              <div className="font-display text-[2rem] font-semibold leading-none tracking-normal text-white sm:text-[2.25rem]">
                Immo<span className="text-[#c98d45]">judis</span>
              </div>
              <div className="hidden h-8 w-px bg-white/20 sm:block" aria-hidden />
              <div className="min-w-0">
                <h1 className="text-base font-semibold text-white">Ventes immobilières</h1>
                <p className="mt-0.5 hidden text-xs font-medium text-white/62 sm:block">
                  Tribunal, notaire et ventes domaniales
                </p>
              </div>
            </div>

            <SearchInput
              value={draft.query}
              onChange={(value) => setDraft((current) => ({ ...current, query: value }))}
            />

            <div className="flex shrink-0 items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] lg:pb-0 [&::-webkit-scrollbar]:hidden">
              <SaveSearchButton saving={savingAlert} locked={alertsLocked} onClick={onSaveSearch} />
              <CsvExportButton
                exporting={exportingCsv}
                locked={csvExportLocked}
                onClick={onExportCsv}
              />
              <LayoutToggle wideMap={wideMap} onToggle={onToggleLayout} />
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-[#132238]/10 bg-white/96 px-3 py-2.5 backdrop-blur-xl sm:px-5 lg:px-6">
        <div className="mb-3 border-b border-[#132238]/10 pb-3">
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
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <FilterBar
            draft={draft}
            setDraft={setDraft}
            activeFiltersCount={activeFiltersCount}
            filtersOpen={filtersOpen}
            onFiltersOpenChange={onFiltersOpenChange}
            onReset={onReset}
          />

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <SortDropdown sort={search.sort ?? "relevance"} onChange={onSortChange} />
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-[#55626f]">
              <HeaderStatusPill>
                {isLoading || isCountLoading ? "Chargement" : displayCount.toLocaleString("fr-FR")}{" "}
                {mapListFollowsViewport ? "dans la carte" : "ventes"}
              </HeaderStatusPill>
              <HeaderStatusPill>
                {loadedCount.toLocaleString("fr-FR")}{" "}
                {mapListFollowsViewport ? "points carte" : "chargées"}
              </HeaderStatusPill>
              {filteredCount !== loadedCount ? (
                <HeaderStatusPill>
                  {filteredCount.toLocaleString("fr-FR")} affichées
                </HeaderStatusPill>
              ) : null}
              {isFetching && !isLoading ? (
                <HeaderStatusPill tone="teal">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Mise à jour
                </HeaderStatusPill>
              ) : null}
              {geocoding ? (
                <HeaderStatusPill tone="teal">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Géocodage
                </HeaderStatusPill>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

export function HeaderStatusPill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "teal";
}) {
  return (
    <span
      className={`inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2.5 ${
        tone === "teal"
          ? "border-[#b8ddd5] bg-[#eefaf3] text-[#0f766e]"
          : "border-[#d9e4ec] bg-white text-[#55626f]"
      }`}
    >
      {children}
    </span>
  );
}

export function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative min-w-0 flex-1">
      <span className="sr-only">Rechercher par région, département, ville ou code postal</span>
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667482]" />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Région, département, ville, code postal..."
        autoComplete="off"
        className="h-11 rounded-md border-white/25 bg-white pl-10 pr-3 text-[15px] font-semibold text-[#132238] shadow-[0_10px_24px_rgba(0,0,0,0.18)] focus-visible:ring-[#c98d45]"
      />
    </label>
  );
}

export function FilterBar({
  draft,
  setDraft,
  activeFiltersCount,
  filtersOpen,
  onFiltersOpenChange,
  onReset,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  activeFiltersCount: number;
  filtersOpen: boolean;
  onFiltersOpenChange: (open: boolean) => void;
  onReset: () => void;
}) {
  return (
    <div
      className="flex min-w-0 gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Filtres de recherche"
    >
      <InlineTextFilter
        label="Ville"
        icon={MapPin}
        value={draft.city}
        placeholder="Bordeaux"
        onChange={(value) => setDraft((current) => ({ ...current, city: value }))}
      />
      {!draft.saleType || draft.saleType === "tribunal" ? (
        <InlineTextFilter
          label="Tribunal"
          icon={Landmark}
          value={draft.tribunal}
          placeholder="TJ Bordeaux"
          onChange={(value) => setDraft((current) => ({ ...current, tribunal: value }))}
        />
      ) : null}
      <PriceFilter draft={draft} setDraft={setDraft} />
      <BedsBathsFilter draft={draft} setDraft={setDraft} />
      <HomeTypeFilter draft={draft} setDraft={setDraft} />
      <button
        type="button"
        onClick={() => onFiltersOpenChange(!filtersOpen)}
        aria-label="Filtres avancés"
        aria-expanded={filtersOpen}
        title="Filtres avancés"
        className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[#cbd5df] bg-white px-3 text-sm font-bold text-[#132238] shadow-sm transition-colors hover:border-[#0f766e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]"
      >
        <SlidersHorizontal className="h-4 w-4" />
        Plus
        {activeFiltersCount > 0 ? (
          <span className="rounded-full bg-[#0f766e] px-1.5 py-0.5 text-[10px] text-white">
            {activeFiltersCount}
          </span>
        ) : null}
      </button>
      {activeFiltersCount > 0 ? (
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[#ead8c5] bg-[#fffaf2] px-3 text-sm font-bold text-[#8a5b24] transition-colors hover:border-[#c98d45] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c98d45]"
        >
          <RotateCcw className="h-4 w-4" />
          Réinitialiser
        </button>
      ) : null}
    </div>
  );
}

export function InlineTextFilter({
  label,
  icon: Icon,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative inline-flex h-10 min-w-[10.5rem] shrink-0 items-center rounded-md border border-[#cbd5df] bg-white shadow-sm focus-within:ring-2 focus-within:ring-[#0f766e]">
      <Icon className="ml-3 h-4 w-4 text-[#667482]" />
      <span className="sr-only">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-sm font-bold text-[#132238] outline-none placeholder:text-[#667482]"
      />
    </label>
  );
}

export function PriceFilter({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <div className="inline-flex h-10 shrink-0 items-center overflow-hidden rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <span className="px-3 text-sm font-bold text-[#132238]">Prix</span>
      <input
        aria-label="Prix minimum"
        inputMode="numeric"
        value={draft.minPrice}
        onChange={(event) => setDraft((current) => ({ ...current, minPrice: event.target.value }))}
        placeholder="min"
        className="h-full w-20 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
      <input
        aria-label="Prix maximum"
        inputMode="numeric"
        value={draft.maxPrice}
        onChange={(event) => setDraft((current) => ({ ...current, maxPrice: event.target.value }))}
        placeholder="max"
        className="h-full w-20 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
    </div>
  );
}

export function BedsBathsFilter({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <div className="inline-flex h-10 shrink-0 items-center overflow-hidden rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <span className="px-3 text-sm font-bold text-[#132238]">Pièces</span>
      <input
        aria-label="Nombre minimum de chambres"
        inputMode="numeric"
        value={draft.minBeds}
        onChange={(event) => setDraft((current) => ({ ...current, minBeds: event.target.value }))}
        placeholder="ch."
        className="h-full w-16 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
      <input
        aria-label="Nombre minimum de salles de bain"
        inputMode="numeric"
        value={draft.minBaths}
        onChange={(event) => setDraft((current) => ({ ...current, minBaths: event.target.value }))}
        placeholder="sdb"
        className="h-full w-16 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
    </div>
  );
}

export function HomeTypeFilter({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <label className="relative inline-flex h-10 shrink-0 items-center rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <Building2 className="ml-3 h-4 w-4 text-[#667482]" />
      <span className="sr-only">Type de bien</span>
      <select
        value={draft.homeTypes[0] ?? "all"}
        onChange={(event) =>
          setDraft((current) => ({
            ...current,
            homeTypes: event.target.value === "all" ? [] : [event.target.value],
          }))
        }
        className="h-full cursor-pointer appearance-none bg-transparent py-0 pl-2 pr-9 text-sm font-bold text-[#132238] outline-none"
      >
        <option value="all">Tous biens</option>
        {HOME_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-[#667482]" />
    </label>
  );
}

export function SortDropdown({
  sort,
  onChange,
}: {
  sort: SearchSortKey;
  onChange: (sort: SearchSortKey) => void;
}) {
  return (
    <label className="relative inline-flex h-10 shrink-0 items-center rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <ArrowUpDown className="ml-3 h-4 w-4 text-[#667482]" />
      <span className="sr-only">Tri</span>
      <select
        value={sort}
        onChange={(event) => onChange(event.target.value as SearchSortKey)}
        className="h-full cursor-pointer appearance-none bg-transparent py-0 pl-2 pr-9 text-sm font-bold text-[#132238] outline-none"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-[#667482]" />
    </label>
  );
}

export function SaveSearchButton({
  saving,
  locked,
  onClick,
}: {
  saving: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md bg-[#c98d45] px-3 text-sm font-extrabold text-[#132238] shadow-sm transition-colors hover:bg-[#d69d58] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c98d45] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {saving ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : locked ? (
        <LockKeyhole className="h-4 w-4" />
      ) : (
        <Bell className="h-4 w-4" />
      )}
      {locked ? "Alertes Analyse" : "Enregistrer"}
    </button>
  );
}

export function CsvExportButton({
  exporting,
  locked,
  onClick,
}: {
  exporting: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={exporting}
      title={locked ? "Export CSV réservé au plan Analyse" : "Exporter les résultats en CSV"}
      className={`inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-extrabold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60 ${
        locked
          ? "border-[#d6e0dc] bg-white text-[#667482]"
          : "border-[#0f766e] bg-white text-[#0f766e] hover:bg-[#eefaf3]"
      }`}
    >
      {exporting ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      CSV
    </button>
  );
}

export function LayoutToggle({ wideMap, onToggle }: { wideMap: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="hidden h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[#cbd5df] bg-white px-3 text-sm font-bold text-[#132238] shadow-sm transition-colors hover:border-[#0f766e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] lg:inline-flex"
      aria-label={wideMap ? "Afficher plus de résultats" : "Afficher plus de carte"}
      title={wideMap ? "Afficher plus de résultats" : "Afficher plus de carte"}
    >
      <LayoutPanelLeft className="h-4 w-4" />
      Vue
    </button>
  );
}

export function ResultsSummary({
  search,
  displayCount,
  loadedCount,
  filteredCount,
  hasLocalFilters,
  mapListFollowsViewport,
  mapViewport,
  isLoading,
  geocoding,
}: {
  search: SalesSearchParams;
  displayCount: number;
  loadedCount: number;
  filteredCount: number;
  hasLocalFilters: boolean;
  mapListFollowsViewport: boolean;
  mapViewport: MapViewportChange | null;
  isLoading: boolean;
  geocoding: boolean;
}) {
  const location = search.city || search.department || search.tribunal || search.query || "France";
  const sortLabel =
    SORT_OPTIONS.find((option) => option.value === (search.sort ?? "relevance"))?.label ??
    "Pertinence";

  return (
    <div className="border-b border-[#132238]/10 bg-[#fbfdff] px-4 py-3 backdrop-blur sm:px-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-extrabold leading-tight text-[#132238]">
            {isLoading
              ? "Recherche des dossiers"
              : `${displayCount.toLocaleString("fr-FR")} ventes trouvées`}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-bold text-[#667482]">
            <span>
              {mapListFollowsViewport
                ? "zone visible sur la carte"
                : hasLocalFilters
                  ? `${location} · filtres locaux actifs`
                  : `${location} · ${search.saleType ? saleTypeFilterLabel(search.saleType).toLowerCase() : "tous types de ventes"}`}
            </span>
            <span aria-hidden>·</span>
            <span>tri {sortLabel.toLowerCase()}</span>
            <span aria-hidden>·</span>
            <span>
              {loadedCount.toLocaleString("fr-FR")}{" "}
              {mapListFollowsViewport ? "points carte" : "chargés"}
            </span>
            {filteredCount !== loadedCount ? (
              <>
                <span aria-hidden>·</span>
                <span>{filteredCount.toLocaleString("fr-FR")} affichés</span>
              </>
            ) : null}
            {mapListFollowsViewport && mapViewport ? (
              <>
                <span aria-hidden>·</span>
                <span>zoom {mapViewport.zoom}</span>
              </>
            ) : null}
          </div>
        </div>
        {search.viewport || mapListFollowsViewport || geocoding ? (
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            {mapListFollowsViewport ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[#cbded8] bg-[#eefaf3] px-2.5 py-1 text-[#0f766e]">
                <Map className="h-3.5 w-3.5" />
                liste liée à la carte
              </span>
            ) : null}
            {search.viewport ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[#cbded8] bg-[#eefaf3] px-2.5 py-1 text-[#0f766e]">
                <Map className="h-3.5 w-3.5" />
                URL bbox active
              </span>
            ) : null}
            {geocoding ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[#cbded8] bg-[#eefaf3] px-2.5 py-1 text-[#0f766e]">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                géocodage
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
