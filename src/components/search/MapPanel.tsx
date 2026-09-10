"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import mapboxgl from "mapbox-gl";
import type {
  CircleLayerSpecification,
  GeoJSONSource,
  LngLatBoundsLike,
  MapLayerMouseEvent,
  MapMouseEvent,
  SymbolLayerSpecification,
} from "mapbox-gl";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import LocateFixed from "lucide-react/dist/esm/icons/locate-fixed.js";
import MapIcon from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Navigation from "lucide-react/dist/esm/icons/navigation.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import { DPE_CLASSES, dpeColor, extractDpe } from "@/lib/dpe";
import { formatDate, formatPrice, formatPricePerM2, propertyTypeLabel } from "@/lib/format";
import { pricePerM2 } from "@/lib/geo";
import {
  MAPBOX_ATTRIBUTION,
  MAPBOX_COPYRIGHT_URL,
  getMapboxAccessToken,
  getMapboxStyleUrl,
  mapboxSatelliteImageUrl,
} from "@/lib/mapbox";
import {
  buildMapboxSaleFeatureCollection,
  type MapboxSaleFeatureCollection,
} from "@/lib/mapbox-sales";
import { firstPropertyImage } from "@/lib/sale-media";
import { saleDisplayTitle } from "@/lib/sale-title";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { hasCoordinates } from "@/lib/search/search-filters";
import type { ViewportBounds } from "@/lib/search/search-url-state";
import type { AuctionSale } from "@/lib/types";

const SALES_SOURCE_ID = "immojudis-sales";
const CLUSTER_LAYER_ID = "immojudis-sales-clusters";
const CLUSTER_COUNT_LAYER_ID = "immojudis-sales-cluster-count";
const SALE_POINT_LAYER_ID = "immojudis-sales-points";
const SALE_ACTIVE_LAYER_ID = "immojudis-sales-active";
const SALE_PRICE_LAYER_ID = "immojudis-sales-price";
const SALE_HIT_LAYER_ID = "immojudis-sales-hit";

const DEFAULT_MAP_CENTER: [number, number] = [1.7191, 46.7111];
const DEFAULT_MAP_ZOOM = 5.7;
const DEFAULT_MOBILE_MAP_ZOOM = 4.8;
const MIN_MAP_ZOOM = 4;
const MAX_MAP_ZOOM = 18;
const MAX_FIT_ZOOM = 13;
const EMPTY_ACTIVE_FILTER: MapboxFilter = ["==", ["get", "saleId"], "__none__"];
const FRANCE_BOUNDS: LngLatBoundsLike = [
  [-5.6, 41.0],
  [9.7, 51.5],
];
const FIT_PADDING = { top: 82, right: 70, bottom: 86, left: 70 };
const MOBILE_FIT_PADDING = { top: 88, right: 30, bottom: 120, left: 30 };

export type MapPanelProps = {
  preview?: boolean;
  showDpeLegend?: boolean;
  sales: AuctionSale[];
  hoveredSaleId: string | null;
  selectedSaleId: string | null;
  isLoading: boolean;
  searchAsMove: boolean;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string) => void;
  onViewportChange: (viewport: MapViewportChange) => void;
  onSearchAsMoveChange: (enabled: boolean) => void;
};

export type MapViewportChange = {
  bounds: ViewportBounds;
  zoom: number;
};

type MapboxMap = mapboxgl.Map;
type GeoJSONData = Parameters<GeoJSONSource["setData"]>[0];
type MapboxFilter = NonNullable<Parameters<MapboxMap["setFilter"]>[1]>;
type QueriedMapFeature = {
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
};

type PopupAccess = { preview: boolean; analysisLocked: boolean };

export function MapPanel({
  preview = false,
  showDpeLegend = true,
  sales,
  hoveredSaleId,
  selectedSaleId,
  isLoading,
  searchAsMove,
  onHover,
  onSelect,
  onViewportChange,
  onSearchAsMoveChange,
}: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const popupAccessRef = useRef<PopupAccess>({ preview, analysisLocked: !showDpeLegend });
  const onHoverRef = useRef(onHover);
  const onSelectRef = useRef(onSelect);
  const onViewportChangeRef = useRef(onViewportChange);
  const salesByIdRef = useRef<Map<string, AuctionSale>>(new Map());
  const hasUserInteractedRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const accessToken = useMemo(() => getMapboxAccessToken(), []);
  const mapStyle = useMemo(() => getMapboxStyleUrl(), []);
  const featureCollection = useMemo(() => buildMapboxSaleFeatureCollection(sales), [sales]);
  const geocodedSales = useMemo(() => sales.filter(hasCoordinates), [sales]);
  const canToggleSearchAsMove = !preview && mapReady && (geocodedSales.length > 0 || searchAsMove);
  const activeId = hoveredSaleId ?? selectedSaleId;

  function markUserInteracted() {
    hasUserInteractedRef.current = true;
  }

  useEffect(() => {
    onHoverRef.current = onHover;
  }, [onHover]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    salesByIdRef.current = new Map(sales.map((sale) => [sale.id, sale]));
  }, [sales]);

  useEffect(() => {
    popupAccessRef.current = { preview, analysisLocked: !showDpeLegend };
    popupRef.current?.remove();
    popupRef.current = null;
  }, [preview, showDpeLegend]);

  useEffect(() => {
    if (!containerRef.current || !accessToken) return;

    mapboxgl.accessToken = accessToken;
    let map: MapboxMap;
    try {
      map = new mapboxgl.Map({
        accessToken,
        container: containerRef.current,
        style: mapStyle,
        center: DEFAULT_MAP_CENTER,
        zoom: defaultMapZoomForViewport(containerRef.current),
        minZoom: MIN_MAP_ZOOM,
        maxZoom: MAX_MAP_ZOOM,
        attributionControl: true,
        pitchWithRotate: false,
        dragRotate: false,
        cooperativeGestures: false,
      });
    } catch {
      setMapError("La carte n’a pas pu démarrer sur cet appareil.");
      return;
    }

    mapRef.current = map;
    const loadTimeout = window.setTimeout(() => {
      setMapError("Le chargement de la carte prend trop de temps.");
    }, 12_000);

    const emitViewport = () => {
      onViewportChangeRef.current({
        bounds: boundsFromMap(map),
        zoom: Number(map.getZoom().toFixed(2)),
      });
    };

    const handleMapError = (event: mapboxgl.ErrorEvent) => {
      if (event.error?.message) setMapError(event.error.message);
    };

    map.on("load", () => {
      window.clearTimeout(loadTimeout);
      setMapError(null);
      addSalesLayers(map, featureCollection);
      if (!hasUserInteractedRef.current) centerMapOnFrance(map, false, containerRef.current);
      emitViewport();
      setMapReady(true);
    });
    map.on("moveend", emitViewport);
    map.on("zoomend", emitViewport);
    map.on("error", handleMapError);

    const handlePointEnter = (event: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const saleId = saleIdFromFeature(event.features?.[0]);
      if (saleId) onHoverRef.current(saleId);
    };

    const handlePointLeave = () => {
      map.getCanvas().style.cursor = "";
      onHoverRef.current(null);
    };

    const handlePointClick = (event: MapLayerMouseEvent) => {
      markUserInteracted();
      const saleId = saleIdFromFeature(event.features?.[0]);
      if (!saleId) return;
      const sale = salesByIdRef.current.get(saleId);
      if (!sale || !hasCoordinates(sale)) return;
      event.preventDefault();
      onSelectRef.current(saleId);
      popupRef.current = showSalePopup(map, sale, popupRef.current, popupAccessRef.current);
    };

    const handleClusterEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };

    const handleClusterLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    const handleClusterClick = (event: MapMouseEvent) => {
      markUserInteracted();
      const features = map.queryRenderedFeatures(event.point, { layers: [CLUSTER_LAYER_ID] });
      const feature = features[0] as QueriedMapFeature | undefined;
      const clusterId = Number(feature?.properties?.cluster_id);
      if (!Number.isFinite(clusterId)) return;
      const source = map.getSource(SALES_SOURCE_ID) as GeoJSONSource | undefined;
      source?.getClusterExpansionZoom(clusterId, (error, zoom) => {
        if (error || zoom == null) return;
        const coordinates =
          feature?.geometry?.type === "Point" && Array.isArray(feature.geometry.coordinates)
            ? feature.geometry.coordinates
            : null;
        if (!coordinates) return;
        map.easeTo({
          center: [Number(coordinates[0]), Number(coordinates[1])],
          zoom: Math.min(zoom + 0.4, MAX_MAP_ZOOM),
          duration: 420,
        });
      });
    };

    map.on("mouseenter", SALE_HIT_LAYER_ID, handlePointEnter);
    map.on("mouseleave", SALE_HIT_LAYER_ID, handlePointLeave);
    map.on("click", SALE_HIT_LAYER_ID, handlePointClick);
    map.on("mouseenter", CLUSTER_LAYER_ID, handleClusterEnter);
    map.on("mouseleave", CLUSTER_LAYER_ID, handleClusterLeave);
    map.on("click", CLUSTER_LAYER_ID, handleClusterClick);

    const canvas = map.getCanvas();
    const handleDirectMapInteraction = () => markUserInteracted();
    canvas.addEventListener("pointerdown", handleDirectMapInteraction, { passive: true });
    canvas.addEventListener("wheel", handleDirectMapInteraction, { passive: true });
    canvas.addEventListener("touchstart", handleDirectMapInteraction, { passive: true });

    const observer = new ResizeObserver(() => {
      map.resize();
      emitViewport();
    });
    observer.observe(containerRef.current);

    return () => {
      window.clearTimeout(loadTimeout);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", handleDirectMapInteraction);
      canvas.removeEventListener("wheel", handleDirectMapInteraction);
      canvas.removeEventListener("touchstart", handleDirectMapInteraction);
      popupRef.current?.remove();
      popupRef.current = null;
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
    // Mapbox owns the imperative instance; data and callbacks are updated through refs/effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, mapStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(SALES_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(featureCollection as GeoJSONData);
  }, [featureCollection, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    updateActiveLayer(map, activeId);
  }, [activeId, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !selectedSaleId) return;
    const sale = salesByIdRef.current.get(selectedSaleId);
    if (!sale || !hasCoordinates(sale)) return;

    markUserInteracted();
    const zoom = Math.max(map.getZoom(), 12);
    map.easeTo({
      center: [sale.longitude, sale.latitude],
      zoom,
      duration: 360,
    });
    popupRef.current = showSalePopup(map, sale, popupRef.current, popupAccessRef.current);
  }, [mapReady, selectedSaleId, preview, showDpeLegend]);

  function zoomIn() {
    markUserInteracted();
    mapRef.current?.zoomIn({ duration: 240 });
  }

  function zoomOut() {
    markUserInteracted();
    mapRef.current?.zoomOut({ duration: 240 });
  }

  function fitVisibleSales() {
    markUserInteracted();
    const map = mapRef.current;
    if (!map) return;
    fitSalesOnMap(map, geocodedSales, true, containerRef.current);
  }

  function centerOnFrance() {
    markUserInteracted();
    const map = mapRef.current;
    if (!map) return;
    centerMapOnFrance(map, true, containerRef.current);
  }

  if (!accessToken) {
    return (
      <div className="relative h-full min-h-[28rem] overflow-hidden bg-[#dcece5]">
        <MapFallback message="La carte est indisponible. Vous pouvez continuer à consulter les annonces dans la liste." />
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[28rem] overflow-hidden bg-[#dcece5]">
      <div
        ref={containerRef}
        aria-label="Carte Mapbox des biens Immojudis"
        data-testid="mapbox-map-panel"
        className="!absolute !inset-0 !h-full !w-full"
      />

      {mapError ? (
        <MapFallback message="La carte n’a pas pu charger. Les annonces restent accessibles dans la liste." />
      ) : null}

      {!mapError && (isLoading || !mapReady) ? (
        <div className="pointer-events-none absolute inset-x-0 top-16 z-20 grid place-items-center">
          <div className="inline-flex items-center gap-2 rounded-md border border-[#cbded8] bg-white px-4 py-3 text-sm font-bold text-[#132238] shadow-lg">
            <LoaderCircle className="h-4 w-4 animate-spin text-[#0f766e]" />
            {!mapReady ? "Chargement de la carte" : "Mise à jour de la carte"}
          </div>
        </div>
      ) : null}

      {!isLoading && mapReady && geocodedSales.length === 0 ? (
        <div className="absolute left-4 top-16 z-20 max-w-xs rounded-md border border-[#cbded8] bg-white/95 p-3 text-sm font-semibold text-[#3d4b57] shadow-lg backdrop-blur">
          Aucune coordonnée disponible pour les résultats affichés.
        </div>
      ) : null}

      <div className="absolute left-4 top-4 z-30 flex max-w-[calc(100%-6rem)] flex-wrap items-center gap-2">
        {!preview ? (
          <button
            type="button"
            onClick={() => {
              if (!canToggleSearchAsMove) return;
              markUserInteracted();
              onSearchAsMoveChange(!searchAsMove);
            }}
            disabled={!canToggleSearchAsMove}
            aria-pressed={searchAsMove}
            className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-extrabold shadow-lg backdrop-blur transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c98d45] disabled:cursor-not-allowed disabled:opacity-60 ${
              searchAsMove
                ? "border-[#132238] bg-[#132238] text-white"
                : "border-[#d6e0dc] bg-white/95 text-[#132238] hover:border-[#c98d45] disabled:hover:border-[#d6e0dc]"
            }`}
          >
            <LocateFixed className="h-4 w-4" />
            {searchAsMove ? "Carte active" : "Rechercher ici"}
          </button>
        ) : (
          <span className="rounded-md border border-[#d6e0dc] bg-white/95 px-3 py-2 text-xs font-bold text-[#3d4b57] shadow-lg">
            Positions approximatives · annonces de cette page
          </span>
        )}
        <div className="hidden h-10 items-center rounded-md border border-[#d6e0dc] bg-white/95 px-3 text-xs font-bold text-[#3d4b57] shadow-lg backdrop-blur sm:inline-flex">
          {geocodedSales.length.toLocaleString("fr-FR")} {preview ? "situées" : "géocodés"}
        </div>
      </div>

      <div className="absolute right-4 top-4 z-30 flex flex-col overflow-hidden rounded-md border border-[#d6e0dc] bg-white shadow-lg">
        <MapIconButton label="Zoomer" onClick={zoomIn}>
          <Plus className="h-5 w-5" />
        </MapIconButton>
        <MapIconButton label="Dézoomer" onClick={zoomOut} separated>
          <Minus className="h-5 w-5" />
        </MapIconButton>
      </div>

      <div className="absolute right-4 top-32 z-30 flex flex-col gap-2">
        <MapControlButton icon={Navigation} label="Cadrer les biens" onClick={fitVisibleSales} />
        <MapControlButton icon={MapIcon} label="Voir la France" onClick={centerOnFrance} />
      </div>

      <div className="absolute bottom-20 left-4 z-30 max-w-[calc(100%-2rem)] rounded-md border border-[#d6e0dc] bg-white/95 px-3 py-2 text-xs font-bold text-[#3d4b57] shadow-lg backdrop-blur sm:bottom-4">
        <span className="sm:hidden">
          {featureCollection.features.length.toLocaleString("fr-FR")} points ·{" "}
          {sales.length.toLocaleString("fr-FR")} biens
        </span>
        <span className="hidden sm:inline">
          {featureCollection.features.length.toLocaleString("fr-FR")} points Mapbox ·{" "}
          {sales.length.toLocaleString("fr-FR")} dossiers chargés
        </span>
      </div>

      {showDpeLegend ? (
        <div className="absolute bottom-16 left-4 z-30 hidden rounded-md border border-[#d6e0dc] bg-white/95 px-2 py-2 shadow-lg backdrop-blur sm:block">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#667482]">
            DPE
          </div>
          <div className="flex gap-1">
            {DPE_CLASSES.map((dpeClass) => {
              const color = dpeColor(dpeClass);
              return (
                <span
                  key={dpeClass}
                  className="grid h-5 w-5 place-items-center rounded text-[10px] font-extrabold"
                  style={{ backgroundColor: color?.background, color: color?.foreground }}
                >
                  {dpeClass}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      <a
        href={MAPBOX_COPYRIGHT_URL}
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-4 right-4 z-30 hidden rounded-md border border-[#d6e0dc] bg-white/95 px-2 py-1 text-[10px] font-semibold text-[#3d4b57] shadow-lg backdrop-blur transition-colors hover:text-[#0f766e] md:inline-flex"
      >
        {MAPBOX_ATTRIBUTION}
      </a>
    </div>
  );
}

function addSalesLayers(map: MapboxMap, data: MapboxSaleFeatureCollection) {
  if (map.getSource(SALES_SOURCE_ID)) return;

  map.addSource(SALES_SOURCE_ID, {
    type: "geojson",
    data: data as GeoJSONData,
    cluster: true,
    clusterMaxZoom: 13,
    clusterRadius: 54,
    generateId: true,
  });

  const clusterLayer: CircleLayerSpecification = {
    id: CLUSTER_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": ["step", ["get", "point_count"], "#071a31", 10, "#132238", 30, "#c98d45"],
      "circle-radius": ["step", ["get", "point_count"], 18, 10, 24, 30, 30],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
      "circle-opacity": 0.96,
    },
  };

  const clusterCountLayer: SymbolLayerSpecification = {
    id: CLUSTER_COUNT_LAYER_ID,
    type: "symbol",
    source: SALES_SOURCE_ID,
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-size": 12,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(19,34,56,0.22)",
      "text-halo-width": 1,
    },
  };

  const salePointLayer: CircleLayerSpecification = {
    id: SALE_POINT_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": ["get", "markerColor"],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 13, 9, 16, 14, 20],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
      "circle-opacity": 0.98,
    },
  };

  const activeLayer: CircleLayerSpecification = {
    id: SALE_ACTIVE_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: EMPTY_ACTIVE_FILTER,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 21, 9, 28, 16, 34],
      "circle-color": "rgba(201,141,69,0.2)",
      "circle-stroke-color": "#c98d45",
      "circle-stroke-width": 2,
    },
  };

  const salePriceLayer: SymbolLayerSpecification = {
    id: SALE_PRICE_LAYER_ID,
    type: "symbol",
    source: SALES_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    layout: {
      "text-field": ["get", "priceLabel"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 9, 11, 14, 12],
      "text-anchor": "top",
      "text-offset": [0, 1.25],
      "text-allow-overlap": false,
      "text-ignore-placement": false,
      "text-optional": true,
    },
    paint: {
      "text-color": "#132238",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.4,
      "text-halo-blur": 0.2,
    },
  };

  const hitLayer: CircleLayerSpecification = {
    id: SALE_HIT_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": 24,
      "circle-color": "#132238",
      "circle-opacity": 0.01,
    },
  };

  map.addLayer(clusterLayer);
  map.addLayer(clusterCountLayer);
  map.addLayer(activeLayer);
  map.addLayer(salePointLayer);
  map.addLayer(salePriceLayer);
  map.addLayer(hitLayer);
}

function updateActiveLayer(map: MapboxMap, activeId: string | null | undefined) {
  if (!map.getLayer(SALE_ACTIVE_LAYER_ID)) return;
  const filter: MapboxFilter = activeId ? ["==", ["get", "saleId"], activeId] : EMPTY_ACTIVE_FILTER;
  map.setFilter(SALE_ACTIVE_LAYER_ID, filter);
}

function centerMapOnFrance(map: MapboxMap, animate: boolean, container: HTMLDivElement | null) {
  map.fitBounds(FRANCE_BOUNDS, {
    duration: animate ? 480 : 0,
    padding: isMobileMap(container) ? 18 : 28,
  });
}

function fitSalesOnMap(
  map: MapboxMap,
  sales: AuctionSale[],
  animate: boolean,
  container: HTMLDivElement | null,
) {
  const points = sales.filter(hasCoordinates);
  const duration = animate ? 520 : 0;
  const padding = isMobileMap(container) ? MOBILE_FIT_PADDING : FIT_PADDING;

  if (points.length === 0) {
    centerMapOnFrance(map, animate, container);
    return;
  }

  if (points.length === 1) {
    const [sale] = points;
    map.easeTo({
      center: [sale.longitude, sale.latitude],
      zoom: 12,
      duration,
    });
    return;
  }

  const bounds = new mapboxgl.LngLatBounds();
  points.forEach((sale) => bounds.extend([sale.longitude, sale.latitude]));
  map.fitBounds(bounds, {
    duration,
    maxZoom: MAX_FIT_ZOOM,
    padding,
  });
}

function boundsFromMap(map: MapboxMap): ViewportBounds {
  const bounds = map.getBounds();
  if (!bounds) {
    return { north: 51.5, south: 41, east: 9.7, west: -5.6 };
  }

  return {
    north: bounds.getNorth(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    west: bounds.getWest(),
  };
}

function saleIdFromFeature(feature: unknown) {
  const raw = (feature as QueriedMapFeature | undefined)?.properties?.saleId;
  return typeof raw === "string" && raw ? raw : null;
}

function showSalePopup(
  map: MapboxMap,
  sale: AuctionSale & { latitude: number; longitude: number },
  currentPopup: mapboxgl.Popup | null,
  access: PopupAccess,
) {
  currentPopup?.remove();
  return new mapboxgl.Popup({
    closeButton: true,
    closeOnClick: true,
    className: "immo-mapbox-popup",
    maxWidth: "340px",
    offset: 18,
  })
    .setLngLat([sale.longitude, sale.latitude])
    .setHTML(buildPopupHtml(sale, access))
    .addTo(map);
}

function buildPopupHtml(
  sale: AuctionSale & { latitude: number; longitude: number },
  access: PopupAccess,
) {
  const saleTitle = access.preview
    ? [propertyTypeLabel(sale.property_type), sale.city ? `à ${sale.city}` : null]
        .filter(Boolean)
        .join(" ")
    : saleDisplayTitle(sale);
  const dpe = extractDpe(sale);
  const dpeTheme = dpeColor(dpe.class);
  const surface = getSaleSurface(sale).value;
  const displaySurface = getDisplaySurface(sale);
  const pricePerSquareMeter = pricePerM2(sale.starting_price_eur, surface);
  const score =
    sale.investment_score == null ? "À auditer" : `${Math.round(sale.investment_score)}`;
  const riskCount = sale.risks?.length ?? 0;
  const riskLabel =
    riskCount > 1 ? `${riskCount} alertes` : riskCount === 1 ? "1 alerte" : "À vérifier";
  const imageUrl = access.preview
    ? firstPropertyImage(sale.media)
    : mapboxSatelliteImageUrl({
        lat: sale.latitude,
        lng: sale.longitude,
        zoom: 15,
        width: 420,
        height: 250,
      }) || firstPropertyImage(sale.media);
  const detailUrl = `/sales/${encodeURIComponent(sale.id)}`;
  const location = [sale.city, sale.tribunal_city ?? sale.tribunal_name]
    .filter(Boolean)
    .join(" · ");

  return `
    <article class="immo-mapbox-popup-card">
      ${
        imageUrl
          ? `<img class="immo-mapbox-popup-image" src="${escapeAttribute(
              imageUrl,
            )}" alt="" loading="lazy" decoding="async" referrerpolicy="strict-origin-when-cross-origin" />`
          : ""
      }
      <div class="immo-mapbox-popup-body">
        <strong class="immo-mapbox-popup-price">${escapeHtml(
          formatPrice(sale.starting_price_eur),
        )}</strong>
        <a class="immo-mapbox-popup-title" href="${escapeAttribute(detailUrl)}">${escapeHtml(
          saleTitle,
        )}</a>
        <p class="immo-mapbox-popup-location">${escapeHtml(location)}</p>
        <div class="immo-mapbox-popup-metrics">
          <span>${escapeHtml(displaySurface.label)}</span>
          <span>${escapeHtml(formatPricePerM2(pricePerSquareMeter))}</span>
          <span>Score ${escapeHtml(access.analysisLocked ? "Analyse" : score)}</span>
          <span>Risque ${escapeHtml(access.analysisLocked ? "Analyse" : riskLabel)}</span>
        </div>
        <div class="immo-mapbox-popup-tags">
          <span>${escapeHtml(propertyTypeLabel(sale.property_type))}</span>
          ${sale.sale_date ? `<span>${escapeHtml(formatDate(sale.sale_date))}</span>` : ""}
          ${
            !access.analysisLocked && dpe.class
              ? `<span style="background:${escapeAttribute(
                  dpeTheme?.background ?? "#eef3f5",
                )};border-color:${escapeAttribute(
                  dpeTheme?.border ?? "transparent",
                )};color:${escapeAttribute(dpeTheme?.foreground ?? "#132238")}">DPE ${escapeHtml(
                  dpe.class,
                )}</span>`
              : ""
          }
        </div>
        ${access.preview ? '<p class="immo-mapbox-popup-location">Position approximative · fiche complète avec un compte gratuit</p>' : ""}
        <a class="immo-mapbox-popup-link" href="${escapeAttribute(detailUrl)}">Voir le détail</a>
      </div>
    </article>
  `;
}

function defaultMapZoomForViewport(node: HTMLDivElement) {
  if (node.clientWidth > 0 && node.clientWidth < 640) return DEFAULT_MOBILE_MAP_ZOOM;
  return DEFAULT_MAP_ZOOM;
}

function isMobileMap(node: HTMLDivElement | null) {
  return node != null && node.clientWidth > 0 && node.clientWidth < 640;
}

function MapFallback({ message }: { message: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-[#e7f4ef]/80 px-6 text-center">
      <div className="max-w-sm rounded-md border border-[#cbded8] bg-white p-5 shadow-lg">
        <MapPin className="mx-auto h-8 w-8 text-[#0f766e]" />
        <h2 className="mt-3 text-base font-bold text-[#132238]">Carte Mapbox indisponible</h2>
        <p className="mt-2 text-sm leading-relaxed text-[#55626f]">{message}</p>
      </div>
    </div>
  );
}

function MapIconButton({
  children,
  label,
  onClick,
  separated,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  separated?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`grid h-11 w-11 cursor-pointer place-items-center text-[#132238] transition-colors hover:bg-[#f4f7f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] ${
        separated ? "border-t border-[#d6e0dc]" : ""
      }`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function MapControlButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid h-11 w-11 cursor-pointer place-items-center rounded-md border border-[#d6e0dc] bg-white text-[#132238] shadow-lg transition-colors hover:bg-[#f4f7f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]"
      aria-label={label}
      title={label}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
