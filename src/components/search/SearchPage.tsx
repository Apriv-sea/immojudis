"use client";

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
import { useSaleComparison } from "@/hooks/use-sale-comparison";
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
import { Footer, MapPanelSkeleton, MobileMapToggle, MoreFiltersModal } from "./SearchFilters";
import { ResultsSummary, SearchHeader } from "./SearchHeader";
import { SearchResultsList, SearchStatisticsPanel } from "./SearchResults";
import { SaleComparisonBar } from "./SaleComparisonBar";
import {
  SearchDraft,
  buildAlertName,
  buildSearchStatistics,
  downloadBlob,
  draftToSearch,
  emptySearchDraft,
  searchStatisticsFromServer,
  searchToDraft,
  stableUrlRecord,
  useMediaQuery,
  watchedZoneInputFromSearch,
} from "./search-page-state";

const LazyMapPanel = dynamic(() => import("./MapPanel").then((mod) => mod.MapPanel), {
  ssr: false,
  loading: () => <MapPanelSkeleton />,
});

export function SearchPage({ search }: { search: SalesSearchParams }) {
  const navigate = useNavigate({ from: "/sales" });
  const currentLocation = useLocation();
  const { user, loading: authLoading } = useAuth();
  const isPreview = !user;
  const searchRef = useRef(search);
  const viewportTimerRef = useRef<number | null>(null);
  const [hoveredSaleId, setHoveredSaleId] = useState<string | null>(null);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  const [mapViewport, setMapViewport] = useState<MapViewportChange | null>(null);
  const deferredMapViewport = useDeferredValue(mapViewport);
  const [wideMap, setWideMap] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mobileMapOpen, setMobileMapOpen] = useState(Boolean(search.map));
  const [savingAlert, setSavingAlert] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [dpeExplorerOpen, setDpeExplorerOpen] = useState(false);
  const [draft, setDraft] = useState<SearchDraft>(() => searchToDraft(search));
  const latestSearchDraftRef = useRef<SearchDraft>(searchToDraft(search));
  const firstSearchDraftSync = useRef(true);
  const firstDraftSync = useRef(true);
  const [center, setCenter] = useState<GeoPoint | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const page = search.page ?? 1;
  const pageSize = search.limit ?? DEFAULT_SEARCH_LIMIT;
  const pageOffset = (page - 1) * pageSize;

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  useEffect(() => {
    setMobileMapOpen(Boolean(search.map));
  }, [search.map]);

  const draftSignature = useMemo(() => JSON.stringify(draft), [draft]);
  const searchDraftSignature = useMemo(() => JSON.stringify(searchToDraft(search)), [search]);

  useEffect(() => {
    latestSearchDraftRef.current = searchToDraft(search);
  }, [search]);

  useEffect(() => {
    if (firstSearchDraftSync.current) {
      firstSearchDraftSync.current = false;
      return;
    }

    setDraft(latestSearchDraftRef.current);
  }, [searchDraftSignature]);

  useEffect(() => {
    if (firstDraftSync.current) {
      firstDraftSync.current = false;
      return;
    }

    const timeout = window.setTimeout(() => {
      const nextSearch = draftToSearch(draft, searchRef.current);
      const currentRecord = salesSearchToUrlRecord(searchRef.current);
      const nextRecord = salesSearchToUrlRecord(nextSearch);
      if (stableUrlRecord(currentRecord) === stableUrlRecord(nextRecord)) return;
      navigate({ search: nextRecord, replace: true });
    }, 320);

    return () => window.clearTimeout(timeout);
  }, [draft, draftSignature, navigate]);

  useEffect(() => {
    if (!search.aroundAddress) {
      setCenter(null);
      return;
    }

    let cancelled = false;
    setGeocoding(true);
    geocodeAddress(search.aroundAddress).then((point) => {
      if (cancelled) return;
      setCenter(point);
      setGeocoding(false);
    });

    return () => {
      cancelled = true;
    };
  }, [search.aroundAddress]);

  useEffect(
    () => () => {
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
    },
    [],
  );

  const searchKey = useMemo(() => salesSearchToUrlRecord(search), [search]);
  const searchKeySignature = useMemo(() => stableUrlRecord(searchKey), [searchKey]);
  const mapSearchKeySignature = useMemo(
    () => stableUrlRecord(salesSearchToUrlRecord({ ...search, page: undefined, limit: undefined })),
    [search],
  );
  const { data: entitlementsData, isLoading: entitlementsLoading } = useQuery({
    queryKey: ["feature-entitlements", user?.id ?? "anonymous"],
    queryFn: fetchFeatureEntitlements,
    enabled: Boolean(user) && !authLoading,
    staleTime: 5 * 60_000,
  });
  const isDiscovery = Boolean(user) && entitlementsData?.plan.hasAnalysisAccess !== true;
  const catalogReady = !authLoading && (isPreview || !entitlementsLoading);
  const comparisonScope = catalogReady
    ? `${user?.id ?? "anonymous"}:${isPreview ? "preview" : isDiscovery ? "discovery" : "analysis"}`
    : null;
  const comparison = useSaleComparison(comparisonScope);

  const {
    data: rawSales = [],
    error,
    isFetching,
    isLoading,
  } = useQuery({
    queryKey: ["sales-search", searchKeySignature, isPreview, isDiscovery],
    queryFn: () => fetchSearchResults({ search, preview: isPreview, discovery: isDiscovery }),
    enabled: catalogReady,
    staleTime: 60_000,
  });

  const { data: totalCount, isLoading: isCountLoading } = useQuery({
    queryKey: ["sales-search-count", searchKeySignature, isPreview, isDiscovery],
    queryFn: () => fetchSearchCount({ search, preview: isPreview, discovery: isDiscovery }),
    enabled: catalogReady,
    staleTime: 60_000,
  });

  const { data: rawMapSales = [], isLoading: isMapLoading } = useQuery({
    queryKey: ["sales-search-map", mapSearchKeySignature, isPreview, isDiscovery],
    queryFn: () => fetchSearchMapResults(search, { discovery: isDiscovery }),
    enabled: catalogReady && !isPreview,
    staleTime: 60_000,
  });

  const filteredSales = useMemo(
    () =>
      isPreview
        ? rawSales
        : sortClientSearchResults(
            applyClientSearchFilters(rawSales, search, center),
            search,
            center,
          ),
    [center, isPreview, rawSales, search],
  );

  const mapSales = useMemo(
    () =>
      (isPreview
        ? rawSales
        : sortClientSearchResults(
            applyClientSearchFilters(rawMapSales.length ? rawMapSales : rawSales, search, center),
            search,
            center,
          )
      )
        .filter(hasCoordinates)
        .slice(0, 300),
    [center, isPreview, rawMapSales, rawSales, search],
  );

  const mapViewportResults = useMemo(
    () => visibleSalesForMapViewport(mapSales, deferredMapViewport),
    [deferredMapViewport, mapSales],
  );

  const mapListFollowsViewport =
    !isPreview &&
    shouldMapListFollowViewport({
      isDesktop,
      mobileMapOpen,
      viewport: deferredMapViewport,
      mapSalesCount: mapSales.length,
    });
  const displayedSales = mapListFollowsViewport ? mapViewportResults.sales : filteredSales;
  const hasLocalFilters = !isPreview && hasClientOnlyFilters(search);
  const isInitialLoading = authLoading || entitlementsLoading || isLoading;
  const activeFiltersCount = countActiveSearchFilters(search);
  const searchDisplayCount = hasLocalFilters
    ? filteredSales.length
    : (totalCount ?? filteredSales.length);
  const displayCount = mapListFollowsViewport ? mapViewportResults.total : searchDisplayCount;
  const loadedCount = mapListFollowsViewport ? mapSales.length : rawSales.length;
  const filteredCount = displayedSales.length;
  const hasMore =
    !mapListFollowsViewport &&
    !hasLocalFilters &&
    totalCount != null &&
    pageOffset + rawSales.length < totalCount &&
    rawSales.length >= pageSize;
  const hasPrevious = !mapListFollowsViewport && page > 1;
  const splitClass = wideMap
    ? "lg:grid-cols-[minmax(0,1.7fr)_minmax(390px,30vw)]"
    : "lg:grid-cols-[minmax(0,1.25fr)_minmax(430px,36vw)]";
  const localSearchStatistics = useMemo(
    () => buildSearchStatistics(displayedSales),
    [displayedSales],
  );
  const statisticsLocked =
    isPreview || entitlementsData?.plan.features.salesStatistics !== "included";
  const dpeLocked = isPreview || entitlementsData?.plan.features.dpeExplorer !== "included";
  const csvExportLocked =
    isPreview || entitlementsData?.plan.features.salesCsvExport !== "included";
  const watchedZonesLocked =
    !user || !entitlementsData || entitlementsData.plan.features.watchedZones === "locked";
  const alertsLocked =
    !user || !entitlementsData || entitlementsData.plan.features.smartAlerts === "locked";
  const { data: salesStatisticsData, isFetching: salesStatisticsLoading } = useQuery({
    queryKey: ["sales-statistics", searchKeySignature],
    queryFn: () => fetchSalesStatistics({ search }),
    enabled: !statisticsLocked && !authLoading && Boolean(user),
    retry: false,
    staleTime: 2 * 60_000,
  });
  const searchStatistics = useMemo(
    () =>
      salesStatisticsData && !mapListFollowsViewport
        ? searchStatisticsFromServer(salesStatisticsData.summary)
        : localSearchStatistics,
    [localSearchStatistics, mapListFollowsViewport, salesStatisticsData],
  );
  const statisticsLoading =
    isInitialLoading || (!statisticsLocked && salesStatisticsLoading && !salesStatisticsData);
  const {
    data: dpeExplorerData,
    error: dpeExplorerError,
    isFetching: dpeExplorerLoading,
    refetch: refetchDpeExplorer,
  } = useQuery({
    queryKey: ["dpe-explorer", searchKeySignature],
    queryFn: () =>
      fetchDpeExplorer({
        department: search.department,
        city: search.city,
        propertyType: search.homeTypes?.length === 1 ? search.homeTypes[0] : undefined,
        dpeClasses: search.dpeClasses,
        includeMap: true,
        limit: 80,
      }),
    enabled: dpeExplorerOpen && !dpeLocked,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const updateSearch = useCallback(
    (patch: Partial<SalesSearchParams>) => {
      const next = mergeSalesSearch(searchRef.current, patch);
      navigate({ search: salesSearchToUrlRecord(next), replace: true });
    },
    [navigate],
  );

  const resetFilters = useCallback(() => {
    setDraft(emptySearchDraft());
    navigate({
      search: salesSearchToUrlRecord({ sort: search.sort }),
      replace: true,
    });
  }, [navigate, search.sort]);

  const loadNextPage = useCallback(() => {
    if (!hasMore || isFetching) return;
    updateSearch({ page: page + 1 });
  }, [hasMore, isFetching, page, updateSearch]);

  const loadPreviousPage = useCallback(() => {
    if (!hasPrevious || isFetching) return;
    updateSearch({ page: page - 1 });
  }, [hasPrevious, isFetching, page, updateSearch]);

  const handleMapSelect = useCallback((saleId: string) => {
    setSelectedSaleId(saleId);
    window.setTimeout(() => {
      document.getElementById(`sale-card-${saleId}`)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 40);
  }, []);

  const handleViewportChange = useCallback(
    (viewport: MapViewportChange) => {
      setMapViewport((current) =>
        current && areMapViewportsClose(current, viewport) ? current : viewport,
      );

      if (isPreview || !searchRef.current.searchAsMove) return;
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = window.setTimeout(() => {
        updateSearch({ viewport: viewport.bounds });
      }, 520);
    },
    [isPreview, updateSearch],
  );

  async function saveSearch() {
    if (!user) {
      toast.error("Connectez-vous pour enregistrer une recherche");
      return;
    }
    if (alertsLocked) {
      toast.message("Alertes réservées au plan Analyse");
      navigate({ to: "/accompagnement" });
      return;
    }
    if (activeFiltersCount === 0) {
      toast.error("Ajoutez au moins un filtre avant d'enregistrer");
      return;
    }

    if (
      !entitlementsData?.plan.hasAnalysisAccess &&
      (search.query ||
        search.occupancy ||
        search.minScore != null ||
        search.minYield != null ||
        search.minMarketDiscount != null ||
        search.dpeClasses?.length ||
        search.houseWithLand)
    ) {
      toast.error(
        "L'alerte gratuite accepte les critères publics : zone, type de vente, type de bien, budget et surface.",
      );
      return;
    }
    setSavingAlert(true);
    try {
      const watchedZoneInput = watchedZonesLocked
        ? null
        : await watchedZoneInputFromSearch(search, center);
      const watchedZoneResponse = watchedZoneInput
        ? await createWatchedZoneRequest({ data: watchedZoneInput })
        : null;

      await createAlert(user.id, {
        name: buildAlertName(search),
        department: search.department || null,
        city: search.city || null,
        property_type: search.homeTypes?.length === 1 ? search.homeTypes[0] : null,
        max_price_eur: search.maxPrice ?? null,
        min_surface_m2: search.minSqft ?? null,
        occupancy_status: search.occupancy || null,
        min_investment_score: search.minScore ?? null,
        max_price_per_m2: search.maxPricePerM2 ?? null,
        min_yield_pct: search.minYield ?? null,
        min_market_discount_pct: search.minMarketDiscount ?? null,
        dpe_classes: search.dpeClasses ?? [],
        require_house_with_land: Boolean(search.houseWithLand),
        watched_zone_id: watchedZoneResponse?.zone.id ?? null,
        advanced_criteria: {
          source: "sales_search",
          sale_type: search.saleType ?? null,
          query: search.query ?? null,
          around_address: search.aroundAddress ?? null,
          around_radius_km: search.aroundRadius ?? null,
          watched_zone_id: watchedZoneResponse?.zone.id ?? null,
        },
      });
      toast.success(
        watchedZoneResponse ? "Zone surveillée et alerte créées" : "Recherche enregistrée",
      );
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "Erreur");
    } finally {
      setSavingAlert(false);
    }
  }

  async function exportCsv() {
    if (!user) {
      toast.error("Connectez-vous pour exporter les ventes");
      return;
    }
    if (csvExportLocked) {
      toast.error("Export CSV réservé au plan Analyse");
      return;
    }

    setExportingCsv(true);
    try {
      const { blob, filename } = await exportSalesCsv({ search });
      downloadBlob(blob, filename);
      toast.success("Export CSV prêt");
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : "Export impossible");
    } finally {
      setExportingCsv(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#edf3f7] text-[#132238] [--sales-header-height:11rem] lg:[--sales-header-height:8.375rem]">
      <a
        href="#sales-results"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-[#132238] focus:shadow-lg"
      >
        Aller aux résultats
      </a>

      <SearchHeader
        search={search}
        draft={draft}
        setDraft={setDraft}
        displayCount={displayCount}
        loadedCount={loadedCount}
        filteredCount={filteredCount}
        activeFiltersCount={activeFiltersCount}
        mapListFollowsViewport={mapListFollowsViewport}
        isLoading={isInitialLoading}
        isCountLoading={isCountLoading}
        isFetching={isFetching}
        geocoding={geocoding}
        filtersOpen={filtersOpen}
        savingAlert={savingAlert}
        alertsLocked={alertsLocked}
        exportingCsv={exportingCsv}
        csvExportLocked={csvExportLocked}
        wideMap={wideMap}
        onFiltersOpenChange={setFiltersOpen}
        onReset={resetFilters}
        onSaveSearch={saveSearch}
        onExportCsv={exportCsv}
        onSortChange={(sort) => updateSearch({ sort: sort === "relevance" ? undefined : sort })}
        onToggleLayout={() => setWideMap((value) => !value)}
      />

      <div
        className={`grid min-h-[calc(100svh_-_var(--sales-header-height))] ${
          isDesktop ? splitClass : "grid-cols-1"
        }`}
      >
        <section
          id="sales-results"
          className="min-w-0 border-t border-[#132238]/10 bg-[#f8fbfd] lg:order-2 lg:border-l"
          aria-label="Résultats de recherche"
        >
          <ResultsSummary
            search={search}
            displayCount={displayCount}
            loadedCount={loadedCount}
            filteredCount={filteredCount}
            hasLocalFilters={hasLocalFilters}
            mapListFollowsViewport={mapListFollowsViewport}
            mapViewport={deferredMapViewport}
            isLoading={isInitialLoading || isCountLoading}
            geocoding={geocoding}
          />

          <SearchStatisticsPanel
            statistics={searchStatistics}
            locked={statisticsLocked}
            dpeLocked={dpeLocked}
            loading={entitlementsLoading || statisticsLoading}
            dpeExplorer={dpeExplorerData}
            dpeExplorerLoading={dpeExplorerLoading}
            dpeExplorerError={dpeExplorerError instanceof Error ? dpeExplorerError.message : null}
            dpeExplorerRequested={dpeExplorerOpen}
            onLoadDpeExplorer={() => {
              setDpeExplorerOpen(true);
              if (dpeExplorerOpen) void refetchDpeExplorer();
            }}
          />

          <SaleComparisonBar
            key={comparisonScope ?? "loading"}
            items={comparison.items}
            returnTo={currentLocation.href}
            userId={user?.id ?? null}
            onRemove={comparison.remove}
            onClear={comparison.clear}
            onRestore={comparison.replace}
          />

          <SearchResultsList
            sales={displayedSales}
            returnTo={currentLocation.href}
            locked={isPreview}
            analysisLocked={isDiscovery}
            isLoading={isInitialLoading}
            error={error}
            selectedSaleId={selectedSaleId}
            hoveredSaleId={hoveredSaleId}
            onHover={setHoveredSaleId}
            onSelect={setSelectedSaleId}
            comparedSaleIds={comparison.items.map((item) => item.id)}
            comparisonDisabled={!catalogReady}
            onToggleComparison={comparison.toggle}
          />

          <SearchPagination
            hasMore={hasMore}
            hasPrevious={hasPrevious}
            isFetching={isFetching}
            loadedCount={filteredCount}
            totalCount={mapListFollowsViewport ? displayCount : totalCount}
            mapListFollowsViewport={mapListFollowsViewport}
            page={page}
            pageSize={pageSize}
            onNext={loadNextPage}
            onPrevious={loadPreviousPage}
          />

          <Footer />
        </section>

        {isDesktop ? (
          <aside className="relative min-h-[calc(100svh_-_var(--sales-header-height))] bg-[#dfe7eb] lg:order-1">
            <div className="sticky top-[var(--sales-header-height)] h-[calc(100svh_-_var(--sales-header-height))]">
              <LazyMapPanel
                sales={mapSales}
                hoveredSaleId={hoveredSaleId}
                selectedSaleId={selectedSaleId}
                isLoading={isInitialLoading || isMapLoading}
                searchAsMove={!isPreview && Boolean(search.searchAsMove)}
                preview={isPreview}
                showDpeLegend={!dpeLocked}
                onHover={setHoveredSaleId}
                onSelect={handleMapSelect}
                onViewportChange={handleViewportChange}
                onSearchAsMoveChange={(enabled) =>
                  updateSearch({
                    searchAsMove: enabled,
                    viewport: enabled ? mapViewport?.bounds : undefined,
                  })
                }
              />
            </div>
          </aside>
        ) : null}
      </div>

      <MoreFiltersModal
        open={filtersOpen}
        draft={draft}
        setDraft={setDraft}
        activeFiltersCount={activeFiltersCount}
        onClose={() => setFiltersOpen(false)}
        onReset={resetFilters}
      />

      <MobileMapToggle
        activeFiltersCount={activeFiltersCount}
        onOpenFilters={() => setFiltersOpen(true)}
        onOpenMap={() => updateSearch({ map: true })}
      />

      <>
        {mobileMapOpen ? (
          <div className={`${entryMotion.fadeIn} fixed inset-0 z-50 bg-[#e7f4ef] lg:hidden`}>
            <div className="absolute inset-x-0 top-0 z-10 flex h-14 items-center justify-between border-b border-[#132238]/10 bg-white/95 px-3 backdrop-blur">
              <button
                type="button"
                onClick={() => updateSearch({ map: false })}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-[#d6e0dc] bg-white px-3 text-sm font-bold text-[#132238] shadow-sm"
              >
                <X className="h-4 w-4" />
                Liste
              </button>
              <span className="text-sm font-bold text-[#3d4b57]">
                {mapSales.length.toLocaleString("fr-FR")} biens sur la carte
              </span>
            </div>
            <div className="h-full pt-14">
              <LazyMapPanel
                sales={mapSales}
                hoveredSaleId={hoveredSaleId}
                selectedSaleId={selectedSaleId}
                isLoading={isInitialLoading || isMapLoading}
                searchAsMove={!isPreview && Boolean(search.searchAsMove)}
                preview={isPreview}
                showDpeLegend={!dpeLocked}
                onHover={setHoveredSaleId}
                onSelect={handleMapSelect}
                onViewportChange={handleViewportChange}
                onSearchAsMoveChange={(enabled) =>
                  updateSearch({
                    searchAsMove: enabled,
                    viewport: enabled ? mapViewport?.bounds : undefined,
                  })
                }
              />
            </div>
          </div>
        ) : null}
      </>
    </main>
  );
}
