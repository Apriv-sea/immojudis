import * as Popover from "@radix-ui/react-popover";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpDown,
  Bell,
  Building2,
  ChevronDown,
  Download,
  LayoutPanelLeft,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Search as SearchIcon,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/router-compat";
import { HOME_TYPE_OPTIONS, SORT_OPTIONS } from "@/lib/search/search-filters";
import { resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";
import type { SalesSearchParams, SearchSortKey } from "@/lib/search/search-url-state";
import type { MapViewportChange } from "./MapPanel";
import type { SearchDraft } from "./search-page-state";
import { SaleTypeFilter } from "./SaleTypeFilter";
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
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const header = headerRef.current;
    const main = header?.closest("main");
    if (!header || !main) return;
    const update = () =>
      main.style.setProperty("--sales-header-height", `${header.getBoundingClientRect().height}px`);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return (
    <header
      ref={headerRef}
      className="sales-header sticky top-0 z-40 border-b border-[#132238]/10 bg-white"
    >
      <div className="flex items-center justify-between gap-4 border-b border-[#132238]/10 px-4 py-3 lg:px-8">
        <Link to="/" className="font-display text-3xl font-semibold text-[#132238]">
          Immo<span className="text-[#9c642b]">judis</span>
        </Link>
        <nav
          aria-label="Navigation du catalogue"
          className="flex items-center gap-5 text-sm font-medium"
        >
          <Link
            to="/sales"
            aria-current="page"
            className="hidden border-b-2 border-[#c98d45] py-2 sm:block"
          >
            Annonces
          </Link>
          <Link to="/favoris" className="py-2">
            Favoris
          </Link>
          <Link to="/comparaisons" className="py-2">
            Comparaisons
          </Link>
        </nav>
        <div className="hidden lg:flex gap-2">
          <CsvExportButton
            exporting={exportingCsv}
            locked={csvExportLocked}
            onClick={onExportCsv}
          />
          <LayoutToggle wideMap={wideMap} onToggle={onToggleLayout} />
        </div>
      </div>
      <div className="px-4 py-3 lg:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <GeographicSearch draft={draft} setDraft={setDraft} />
          <div className="hidden lg:flex flex-wrap items-center gap-2">
            <HomeTypeFilter draft={draft} setDraft={setDraft} />
            <PriceFilter draft={draft} setDraft={setDraft} />
            <DateFilter draft={draft} setDraft={setDraft} />
          </div>
          <button
            type="button"
            aria-label="Filtres avancés"
            aria-expanded={filtersOpen}
            onClick={() => onFiltersOpenChange(!filtersOpen)}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[#cbd5df] px-3 text-sm font-medium"
          >
            <SlidersHorizontal className="h-4 w-4" />
            <span className="hidden sm:inline">Tous les filtres</span>
            <span className="sm:hidden">Filtres</span>
            {activeFiltersCount > 0 && (
              <span className="rounded-full bg-[#132238] px-2 py-0.5 text-xs text-white">
                {activeFiltersCount}
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label="Créer une alerte"
            title="Créer une alerte"
            onClick={onSaveSearch}
            disabled={savingAlert}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-[#132238] text-white xl:hidden"
          >
            <Bell className="h-4 w-4" />
          </button>
          <div className="hidden xl:block">
            <SaveSearchButton saving={savingAlert} locked={alertsLocked} onClick={onSaveSearch} />
          </div>
        </div>
        <div className="mt-3 hidden items-center justify-between gap-3 lg:flex">
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
          {activeFiltersCount > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="min-h-11 shrink-0 text-sm underline underline-offset-4"
            >
              Réinitialiser
            </button>
          )}
        </div>
        {(draft.city || draft.query || draft.department) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              aria-label="Retirer la localisation"
              onClick={() => setDraft((c) => ({ ...c, city: "", query: "", department: "" }))}
              className="inline-flex min-h-9 items-center gap-2 rounded-full bg-[#fff7eb] px-3 text-[#80501e]"
            >
              <MapPin className="h-3 w-3" />
              {draft.city || draft.query || draft.department}
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {isFetching && !isLoading && (
          <p role="status" className="sr-only">
            Mise à jour des résultats
          </p>
        )}
      </div>
    </header>
  );
}

export function GeographicSearch({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  const selected = draft.city || draft.query || draft.department;
  const [value, setValue] = useState(selected);
  const [open, setOpen] = useState(false);
  useEffect(() => setValue(selected), [selected]);
  const scope = resolveFrenchGeoSearch(value);
  const kind =
    scope.kind === "text"
      ? "Ville"
      : scope.kind === "region"
        ? "Région"
        : scope.kind === "department"
          ? "Département"
          : "Code postal";
  function apply() {
    const text = value.trim();
    setDraft((c) => ({
      ...c,
      city: scope.kind === "text" ? text : "",
      query: scope.kind !== "text" ? text : "",
      department: "",
    }));
    setOpen(false);
  }
  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      className="relative flex min-w-0 basis-0 flex-1 items-center gap-1 rounded-md border border-[#cbd5df] bg-white focus-within:ring-2 focus-within:ring-[#c98d45] sm:basis-auto sm:flex-1"
    >
      <SearchIcon className="ml-3 h-5 w-5 shrink-0" />
      <input
        aria-label="Ville, département ou région"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        placeholder="Ville, département ou région"
        autoComplete="off"
        className="h-11 w-full min-w-0 bg-transparent px-2 text-sm outline-none"
      />
      <button
        type="submit"
        aria-label="Rechercher la localisation"
        className="mr-1 grid h-10 w-10 shrink-0 place-items-center rounded hover:bg-[#eef3f8]"
      >
        <SearchIcon className="h-4 w-4" />
      </button>
      {open && value.trim() && value !== selected && (
        <div className="absolute inset-x-0 top-full z-50 mt-2 rounded-md border bg-white p-2 shadow-lg">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={apply}
            className="w-full rounded px-3 py-3 text-left text-sm hover:bg-[#eef3f8]"
          >
            <strong>{value}</strong>
            <span className="ml-2 text-[#526170]">{kind}</span>
          </button>
        </div>
      )}
    </form>
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
      <span className="px-3 text-sm font-bold text-[#132238]">Mise à prix</span>
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
      <span className="px-3 text-sm font-bold text-[#132238]">Chambres / bains</span>
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
  preview = false,
  hasCenter = false,
  sort,
  onChange,
}: {
  preview?: boolean;
  hasCenter?: boolean;
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
        {SORT_OPTIONS.filter(
          (option) =>
            !(preview && option.value === "beds_desc") &&
            (option.value !== "distance" || hasCenter),
        ).map((option) => (
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
      className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md bg-[#132238] px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#263c58] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c98d45] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {saving ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : locked ? (
        <LockKeyhole className="h-4 w-4" />
      ) : (
        <Bell className="h-4 w-4" />
      )}
      {locked ? "Créer une alerte · Analyse" : "Créer une alerte"}
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
  hasLocalFilters,
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
  const location = search.city || search.department || search.query || "France entière";
  return (
    <div className="px-4 py-3 sm:px-5" aria-live="polite">
      <h1 className="font-display text-2xl font-semibold">Ventes immobilières</h1>
      <p className="mt-1 text-sm text-[#526170]">
        {isLoading
          ? "Recherche en cours…"
          : `${displayCount.toLocaleString("fr-FR")} annonce${displayCount === 1 ? "" : "s"}`}
        {" · "}
        {search.viewport ? "Zone sélectionnée" : location}
        {hasLocalFilters ? " · filtres sur la page affichée" : ""}
        {geocoding ? " · localisation en cours" : ""}
      </p>
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
    <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border border-[#cbd5df] px-3">
      <Icon className="h-4 w-4 shrink-0" />
      <span className="sr-only">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
      />
    </label>
  );
}

export function DateRangeFields({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-sm">
        À partir du
        <input
          type="date"
          aria-label="Date de vente minimum"
          value={draft.minSaleDate}
          max={draft.maxSaleDate || undefined}
          onChange={(e) =>
            setDraft((c) => ({
              ...c,
              minSaleDate: e.target.value,
              maxSaleDate: c.maxSaleDate && e.target.value > c.maxSaleDate ? "" : c.maxSaleDate,
            }))
          }
          className="h-11 min-w-0 rounded border px-2"
        />
      </label>
      <label className="grid gap-1 text-sm">
        Jusqu’au
        <input
          type="date"
          aria-label="Date de vente maximum"
          value={draft.maxSaleDate}
          min={draft.minSaleDate || undefined}
          onChange={(e) =>
            setDraft((c) => ({
              ...c,
              maxSaleDate: e.target.value,
              minSaleDate: c.minSaleDate && e.target.value < c.minSaleDate ? "" : c.minSaleDate,
            }))
          }
          className="h-11 min-w-0 rounded border px-2"
        />
      </label>
      <button
        type="button"
        className="min-h-9 text-sm underline"
        onClick={() => setDraft((c) => ({ ...c, minSaleDate: "", maxSaleDate: "" }))}
      >
        Effacer les dates
      </button>
    </div>
  );
}
export function DateFilter(props: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger className="inline-flex h-10 items-center gap-2 rounded-md border border-[#cbd5df] px-3 text-sm font-medium">
        <CalendarDays className="h-4 w-4" />
        Date de vente{props.draft.minSaleDate || props.draft.maxSaleDate ? " · 1" : ""}
        <ChevronDown className="h-4 w-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-64 rounded-md border bg-white p-4 shadow-lg"
        >
          <DateRangeFields {...props} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
