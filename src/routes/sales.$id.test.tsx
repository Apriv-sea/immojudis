// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaleDetailPage } from "./sales.$id";
import { EXAMPLE_SALE } from "@/lib/example-sale";

const mocks = vi.hoisted(() => ({
  scroll: vi.fn(),
  entitlements: vi.fn(),
  sale: vi.fn(),
  preview: vi.fn(),
  authenticated: true,
  authError: null as string | null,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    session: mocks.authenticated ? { user: { id: "test" } } : null,
    loading: false,
    authError: mocks.authError,
  }),
}));
vi.mock("@/hooks/use-viewed-sales", () => ({ markSaleViewed: vi.fn() }));
vi.mock("@/lib/router-compat", () => ({ useSearch: () => ({}) }));
vi.mock("@/lib/client-api", () => ({ fetchAccessPlan: mocks.entitlements }));
vi.mock("@/lib/queries", () => ({ getSaleById: mocks.sale, getSalePreviewById: mocks.preview }));
vi.mock("@/components/SaleDetailView", () => ({
  SaleDetailSkeleton: () => <div>Chargement</div>,
  SaleNotFoundComponent: () => <div>Introuvable</div>,
}));
vi.mock("@/components/DiscoverySaleDetailView", () => ({
  DiscoverySaleDetailView: () => <div>Offre Découverte</div>,
}));
vi.mock("@/components/SimplifiedSaleDetailView", () => ({
  AnalysisSaleDetailView: () => (
    <div
      id="information-agent"
      ref={(node) => {
        if (node) node.scrollIntoView = mocks.scroll;
      }}
    >
      Analyse premium
    </div>
  ),
}));
vi.mock("@/components/SalePublicPreview", () => ({
  SalePublicPreview: () => <div>Aperçu public</div>,
}));
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.resetAllMocks();
  mocks.authenticated = true;
  mocks.authError = null;
});
describe("listing access resolution", () => {
  it("restores a deep-link anchor after asynchronous access and listing resolution", async () => {
    window.history.replaceState(null, "", "/sales/sale#information-agent");
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(mocks.scroll).toHaveBeenCalledWith({ behavior: "instant", block: "start" }),
    );
    expect(screen.getByText("Analyse premium")).toBeTruthy();
  });

  it("reuses the server preview for visitors, then fetches authorized data after login", async () => {
    mocks.authenticated = false;
    const initialData = { sale: null, preview: { ...EXAMPLE_SALE, id: "sale" } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const content = () => (
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" initialData={initialData} />
      </QueryClientProvider>
    );
    const view = render(content());
    await screen.findByText("Aperçu public");
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.sale).not.toHaveBeenCalled();
    mocks.authenticated = true;
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });
    view.rerender(content());
    await screen.findByText("Analyse premium");
    expect(mocks.sale).toHaveBeenCalledWith("sale", { discovery: false });
  });

  it("does not reuse a preview belonging to another listing", async () => {
    mocks.authenticated = false;
    mocks.preview.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage
          id="sale"
          initialData={{ sale: null, preview: { ...EXAMPLE_SALE, id: "other" } }}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("Aperçu public");
    expect(mocks.preview).toHaveBeenCalledWith("sale");
  });

  it("offers reconnection to the current listing after session rejection", async () => {
    window.history.replaceState(null, "", "/sales/sale#information-agent");
    mocks.authenticated = false;
    mocks.authError = "Session non vérifiée";
    mocks.preview.mockResolvedValue(null);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "Connexion à renouveler" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Se reconnecter" }).getAttribute("href")).toBe(
      "/login?redirect=%2Fsales%2Fsale%23information-agent",
    );
    expect(mocks.sale).not.toHaveBeenCalled();
  });

  it("only requests the public preview without a verified session", async () => {
    mocks.authenticated = false;
    mocks.preview.mockResolvedValue({ id: "sale", starting_price_eur: 30000 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    await screen.findByText("Aperçu public");
    expect(mocks.sale).not.toHaveBeenCalled();
    expect(mocks.entitlements).not.toHaveBeenCalled();
  });

  it("updates the tab title from the authorized listing and clears it when leaving", async () => {
    document.title = "Aperçu public - Immojudis";
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.sale.mockResolvedValue({
      id: "sale",
      property_type: "apartment",
      city: "Bayonne",
      starting_price_eur: 30000,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.title).toContain("Appartement Bayonne"));
    expect(document.title).toContain("30 000 €");
    view.unmount();
    expect(document.title).toBe("Aperçu public - Immojudis");
  });

  it("does not silently downgrade premium on an entitlement failure and retries", async () => {
    mocks.entitlements
      .mockRejectedValueOnce(new Error("service indisponible"))
      .mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.sale.mockResolvedValue({ id: "sale" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("droits d’accès");
    expect(screen.queryByText("Offre Découverte")).toBeNull();
    expect(mocks.sale).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(screen.getByText("Analyse premium")).toBeTruthy());
    expect(mocks.sale).toHaveBeenCalledWith("sale", { discovery: false });
  });
});

it("offers access to the selected listing when its public preview is absent", async () => {
  mocks.authenticated = false;
  mocks.preview.mockResolvedValue(null);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SaleDetailPage id="sale" />
    </QueryClientProvider>,
  );
  const link = await screen.findByRole("link", { name: "Se connecter ou créer un compte" });
  expect(link.getAttribute("href")).toBe("/login?redirect=%2Fsales%2Fsale");
  expect(screen.queryByText("Introuvable")).toBeNull();
});
