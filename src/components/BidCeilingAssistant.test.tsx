// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BidCeilingAssistant } from "./BidCeilingAssistant";
import { EXAMPLE_SALE, EXAMPLE_MARKET_ESTIMATE } from "@/lib/example-sale";
import { bidStorageKey, parseBidHistory } from "@/lib/bid-simulation-history";

const auth = vi.hoisted(() => ({
  user: { id: "investor-a" } as { id: string } | null,
  loading: false,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/lib/client-api", () => ({ fetchPrecomputedMarketEstimate: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  auth.user = { id: "investor-a" };
  auth.loading = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderAssistant(sale = EXAMPLE_SALE) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (currentSale = sale) => (
    <QueryClientProvider client={client}>
      <BidCeilingAssistant sale={currentSale} marketEstimateOverride={EXAMPLE_MARKET_ESTIMATE} />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return { ...rendered, update: (currentSale = sale) => rendered.rerender(view(currentSale)) };
}
function save(name: string) {
  fireEvent.change(screen.getByLabelText("Nom de la simulation (facultatif)"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole("button", { name: "Enregistrer cette simulation" }));
}

describe("saved ceiling simulations", () => {
  it("keeps a short high-score sample cautious in both reliability and conditions", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <BidCeilingAssistant
          sale={EXAMPLE_SALE}
          marketEstimateOverride={{
            ...EXAMPLE_MARKET_ESTIMATE,
            sampleSize: 7,
            qualityScore: 95,
            qualityLabel: "forte",
          }}
        />
      </QueryClientProvider>,
    );
    expect(container.textContent).toContain("Fiabilité correcte");
    expect(container.textContent).toContain("Échantillon DVF exploitable avec prudence");
    expect(container.textContent).not.toContain("Référence DVF forte");
    expect(container.textContent).not.toContain("Fiabilité forte");
  });

  it("marks automatic works as unknown when a commercial surface is missing", () => {
    const onSimulationChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BidCeilingAssistant
          sale={{
            ...EXAMPLE_SALE,
            property_type: "commercial",
            title: "Magasin",
            rooms_count: 2,
            app_surface_m2: null,
            habitable_surface_m2: null,
            carrez_surface_m2: null,
          }}
          marketEstimateOverride={EXAMPLE_MARKET_ESTIMATE}
          onSimulationChange={onSimulationChange}
        />
      </QueryClientProvider>,
    );
    expect(onSimulationChange.mock.lastCall![0]).toMatchObject({ works: 0, worksKnown: false });
  });

  it("publishes the current ceiling and works after edits and reset", () => {
    const onSimulationChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BidCeilingAssistant
          sale={EXAMPLE_SALE}
          marketEstimateOverride={EXAMPLE_MARKET_ESTIMATE}
          onSimulationChange={onSimulationChange}
        />
      </QueryClientProvider>,
    );
    const initial = onSimulationChange.mock.lastCall![0];
    fireEvent.change(screen.getByLabelText("Budget travaux personnalisé"), {
      target: { value: "80000" },
    });
    const updated = onSimulationChange.mock.lastCall![0];
    expect(updated.works).toBe(80000);
    expect(updated.result.maxBid).toBeLessThan(initial.result.maxBid);
    expect(updated.saleId).toBe(EXAMPLE_SALE.id);
    expect(updated.ownerId).toBe("investor-a");
    fireEvent.click(screen.getByRole("button", { name: "Réinitialiser" }));
    expect(onSimulationChange.mock.lastCall![0].result.maxBid).toBe(initial.result.maxBid);
    expect(onSimulationChange.mock.lastCall![0].works).toBe(initial.works);
  });
  it("saves and restores a custom margin without losing the chosen percentage", () => {
    renderAssistant();
    fireEvent.click(screen.getByRole("radio", { name: "Personnalisé" }));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "19" } });
    save("Marge 19");
    const stored = parseBidHistory(
      localStorage.getItem(bidStorageKey("history", "investor-a", EXAMPLE_SALE.id)),
    );
    expect(stored[0].inputs.customSafetyDiscountPct).toBe(19);
    expect(stored[0].result.safetyDiscountPct).toBe(19);
    fireEvent.click(screen.getByRole("radio", { name: "Prudent" }));
    fireEvent.click(screen.getByRole("button", { name: "Reprendre Marge 19" }));
    expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("19");
    expect(screen.getByRole("radio", { name: "Personnalisé" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });
  it("saves two profiles, restores assumptions, survives a reload and deletes only the chosen entry", () => {
    const view = renderAssistant();
    save("Prudent initial");
    fireEvent.click(screen.getByRole("radio", { name: "Offensif" }));
    save("Offensif initial");
    const history = screen.getByRole("region", { name: "Historique des simulations" });
    expect(within(history).getAllByRole("row")).toHaveLength(3);
    const stored = parseBidHistory(
      localStorage.getItem(bidStorageKey("history", "investor-a", EXAMPLE_SALE.id)),
    );
    expect(stored).toHaveLength(2);
    expect(stored[0].result.maxBid).toBeGreaterThan(stored[1].result.maxBid);
    fireEvent.click(screen.getByRole("button", { name: "Reprendre Prudent initial" }));
    expect(screen.getByRole("radio", { name: "Prudent" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(within(history).getByRole("status").textContent).toContain("données actuelles");
    view.unmount();
    renderAssistant();
    expect(screen.getByRole("button", { name: "Reprendre Prudent initial" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Supprimer Offensif initial" }));
    expect(screen.queryByRole("button", { name: "Reprendre Offensif initial" })).toBeNull();
    expect(
      parseBidHistory(
        localStorage.getItem(bidStorageKey("history", "investor-a", EXAMPLE_SALE.id)),
      ),
    ).toHaveLength(1);
  });
  it("does not expose another account's history or reuse its draft", () => {
    const view = renderAssistant();
    fireEvent.click(screen.getByRole("radio", { name: "Offensif" }));
    save("Simulation privée A");
    auth.user = { id: "investor-b" };
    view.update();
    expect(screen.queryByRole("button", { name: "Reprendre Simulation privée A" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Prudent" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    save("Simulation privée B");
    auth.user = { id: "investor-a" };
    view.update();
    expect(screen.getByRole("button", { name: "Reprendre Simulation privée A" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reprendre Simulation privée B" })).toBeNull();
  });
  it("isolates properties and anonymous example storage", () => {
    const view = renderAssistant();
    save("Bien A");
    view.update({ ...EXAMPLE_SALE, id: "different-property" });
    expect(screen.queryByRole("button", { name: "Reprendre Bien A" })).toBeNull();
    auth.user = null;
    view.update();
    expect(screen.queryByRole("button", { name: "Reprendre Bien A" })).toBeNull();
    save("Démo anonyme");
    expect(
      parseBidHistory(
        localStorage.getItem(bidStorageKey("history", "guest-demo", EXAMPLE_SALE.id)),
      ),
    ).toHaveLength(1);
  });
  it("does not read or write a draft while identity is loading", () => {
    auth.loading = true;
    renderAssistant();
    expect(screen.getByRole("status").textContent).toContain("Chargement du simulateur");
    expect(localStorage.length).toBe(0);
  });
  it("shows storage failure without claiming that a snapshot was saved", () => {
    renderAssistant();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    save("Impossible à enregistrer");
    const history = screen.getByRole("region", { name: "Historique des simulations" });
    expect(within(history).getByRole("alert").textContent).toContain(
      "Aucune sauvegarde n’a été confirmée",
    );
    expect(within(history).getByRole("status").textContent).toBe("");
    expect(screen.queryByRole("button", { name: "Reprendre Impossible à enregistrer" })).toBeNull();
  });
});
