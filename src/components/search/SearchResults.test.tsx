// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { ListingCard, SearchResultsList, SearchStatisticsPanel } from "./SearchResults";
import { buildSearchStatistics } from "./search-page-state";

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("@/hooks/use-viewed-sales", () => ({ useViewedSales: () => ({ isViewed: () => false }) }));
vi.mock("@/lib/router-compat", () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: { id: string };
    children: ReactNode;
  }) => (
    <a href={params ? to.replace("$id", params.id) : to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/SaleVisual", () => ({
  SaleVisual: ({ locked, title }: { locked: boolean; title: string }) => (
    <div>{locked ? "Visuel réservé" : `Visuel : ${title}`}</div>
  ),
}));
afterEach(cleanup);

describe("useful public discovery", () => {
  it("selects directly from the card without navigating and only disables unselected cards at the limit", () => {
    const sales = ["a", "b", "c", "d"].map(
      (id) =>
        ({
          id,
          city: id,
          property_type: "apartment",
          media: [],
        }) as unknown as AuctionSale,
    );
    const onSelect = vi.fn();
    const onToggleComparison = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchResultsList
          sales={sales}
          returnTo="/sales"
          locked
          analysisLocked
          isLoading={false}
          error={null}
          selectedSaleId={null}
          hoveredSaleId={null}
          onHover={vi.fn()}
          onSelect={onSelect}
          comparedSaleIds={["a", "b", "c"]}
          comparisonDisabled={false}
          onToggleComparison={onToggleComparison}
        />
      </QueryClientProvider>,
    );
    const selected = screen.getByRole("button", { name: "Comparer Appartement à a" });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(selected);
    expect(onToggleComparison).toHaveBeenCalledWith(sales[0]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Comparer Appartement à d" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows listing facts and honest upgrade labels without fake scores", () => {
    const sale = {
      id: "sale-public",
      city: "Bordeaux",
      department: "33",
      property_type: "apartment",
      starting_price_eur: 90000,
      sale_date: "2026-10-01T09:00:00Z",
      app_surface_m2: 60,
      app_surface_kind: "habitable",
      rooms_count: 3,
      bedrooms_count: 2,
      sale_venue_type: "tribunal",
      media: [],
    } as unknown as AuctionSale;
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingCard
          sale={sale}
          returnTo="/sales"
          locked
          analysisLocked={false}
          active={false}
          index={0}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "Appartement à Bordeaux" })).toBeTruthy();
    expect(screen.getByText("Bordeaux · 33")).toBeTruthy();
    expect(screen.getByText(/60\s*m²/)).toBeTruthy();
    expect(screen.getAllByText(/oct/i).length).toBeGreaterThan(0);
    for (const text of [
      "Visuel réservé",
      "Localisation réservée",
      "Date réservée",
      "78/100",
      "8 pièces",
      "3 alertes",
    ]) {
      expect(container.textContent).not.toContain(text);
    }
    expect(container.querySelector('[class*="blur-"]')).toBeNull();
    expect(screen.getByText(/Compte gratuit : fiche et adresse/)).toBeTruthy();
  });

  it("offers a working example instead of fabricated statistics", () => {
    const { container } = render(
      <SearchStatisticsPanel
        statistics={buildSearchStatistics([])}
        locked
        dpeLocked
        loading={false}
        dpeExplorerLoading={false}
        dpeExplorerError={null}
        dpeExplorerRequested={false}
        onLoadDpeExplorer={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: "Essayer une analyse complète sans compte" })
        .getAttribute("href"),
    ).toBe("/annonce-exemple");
    expect(container.textContent).not.toContain("148 000");
    expect(container.textContent).not.toContain("76/100");
    expect(container.querySelector('[class*="blur-"]')).toBeNull();
  });
});
