// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapPanel, type MapPanelProps } from "./MapPanel";
import type { AuctionSale } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  token: "test-token",
  throws: false,
  handlers: new Map<string, () => void>(),
  remove: vi.fn(),
  setData: vi.fn(),
  setHtml: vi.fn(),
}));
vi.mock("@/lib/mapbox", () => ({
  getMapboxAccessToken: () => mocks.token,
  getMapboxStyleUrl: () => "test-style",
  MAPBOX_ATTRIBUTION: "Mapbox",
  MAPBOX_COPYRIGHT_URL: "https://www.mapbox.com/about/maps/",
  mapboxSatelliteImageUrl: vi.fn(),
}));
vi.mock("mapbox-gl", () => ({
  default: {
    Map: class {
      canvas = document.createElement("canvas");
      constructor() {
        if (mocks.throws) throw new Error("WebGL unavailable");
      }
      on(event: string, callback: unknown) {
        if (typeof callback === "function") mocks.handlers.set(event, callback as () => void);
      }
      getCanvas() {
        return this.canvas;
      }
      getSource() {
        return { setData: mocks.setData };
      }
      getLayer() {
        return undefined;
      }
      getBounds() {
        return null;
      }
      getZoom() {
        return 6;
      }
      fitBounds() {}
      easeTo() {}
      resize() {}
      remove() {
        mocks.remove();
      }
    },
    Popup: class {
      setLngLat() {
        return this;
      }
      setHTML(html: string) {
        mocks.setHtml(html);
        return this;
      }
      addTo() {
        return this;
      }
      remove() {}
    },
  },
}));
beforeEach(() => {
  vi.useFakeTimers();
  mocks.token = "test-token";
  mocks.throws = false;
  mocks.handlers.clear();
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function showMap(props: Partial<MapPanelProps> = {}) {
  return render(
    <MapPanel
      sales={[]}
      preview
      showDpeLegend={false}
      hoveredSaleId={null}
      selectedSaleId={null}
      isLoading={false}
      searchAsMove={false}
      onHover={vi.fn()}
      onSelect={vi.fn()}
      onViewportChange={vi.fn()}
      onSearchAsMoveChange={vi.fn()}
      {...props}
    />,
  );
}

describe("public map resilience", () => {
  it("keeps popup facts public and never presents missing analysis as low risk", () => {
    const sale = {
      id: "preview",
      title: "Private source title",
      city: "Bordeaux",
      property_type: "apartment",
      latitude: 44.84,
      longitude: -0.58,
      starting_price_eur: 90000,
      app_surface_m2: 60,
      investment_score: 85,
      media: [],
    } as unknown as AuctionSale;
    showMap({ sales: [sale], selectedSaleId: sale.id });
    act(() => mocks.handlers.get("load")?.());
    const html = mocks.setHtml.mock.calls.at(-1)?.[0];
    expect(html).toContain("Appartement à Bordeaux");
    expect(html).toContain("Position approximative");
    expect(html).toContain("Risque Analyse");
    expect(html).not.toContain("Faible");
    expect(html).not.toContain("Score 85");
    expect(html).not.toContain("Private source title");
  });
  it("replaces a stalled loading state after 12 seconds and recovers on a late load", () => {
    showMap();
    expect(screen.getByText("Chargement de la carte")).toBeTruthy();
    act(() => vi.advanceTimersByTime(12000));
    expect(screen.queryByText("Chargement de la carte")).toBeNull();
    expect(screen.getByText(/annonces restent accessibles dans la liste/)).toBeTruthy();
    act(() => mocks.handlers.get("load")?.());
    expect(screen.queryByText(/annonces restent accessibles dans la liste/)).toBeNull();
    expect(screen.getByText(/Positions approximatives/)).toBeTruthy();
    expect(screen.queryByText("DPE")).toBeNull();
  });
  it("clears the load timer on unmount", () => {
    const view = showMap();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("keeps a helpful fallback when no token is configured", () => {
    mocks.token = "";
    showMap();
    expect(screen.getByText(/continuer à consulter les annonces dans la liste/)).toBeTruthy();
    expect(screen.queryByText("Chargement de la carte")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not crash the search page when WebGL cannot start", () => {
    mocks.throws = true;
    showMap();
    expect(screen.getByText(/annonces restent accessibles dans la liste/)).toBeTruthy();
    expect(screen.queryByText("Chargement de la carte")).toBeNull();
  });
});
