// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SavedAlerts } from "./SavedAlerts";
const state = vi.hoisted(() => ({ userId: "first", list: vi.fn(), update: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: state.userId }, loading: false }),
}));
vi.mock("@/lib/queries", () => ({
  getAlerts: state.list,
  updateAlert: state.update,
  deleteAlert: vi.fn(),
}));
vi.mock("@/lib/client-api", () => ({
  fetchWatchedZones: async () => ({ zones: [] }),
  deleteWatchedZone: vi.fn(),
  evaluateAlertMatches: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => {
  state.userId = "first";
  vi.clearAllMocks();
  state.list.mockImplementation(async (id: string) => [
    { id: `alert-${id}`, name: `Alerte ${id}`, is_active: true, alert_frequency: "daily" },
  ]);
  state.update.mockResolvedValue(undefined);
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = () => (
    <QueryClientProvider client={client}>
      <SavedAlerts />
    </QueryClientProvider>
  );
  return { ...render(view()), view };
}
describe("saved alert management", () => {
  it("isolates accounts and pauses only the current user's alert", async () => {
    const ui = setup();
    await screen.findByText("Alerte first");
    state.userId = "second";
    ui.rerender(ui.view());
    expect(screen.queryByText("Alerte first")).toBeNull();
    await screen.findByText("Alerte second");
    fireEvent.click(screen.getByRole("button", { name: "Mettre en pause" }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith("second", "alert-second", { is_active: false }),
    );
  });
  it("does not present a failed fetch as an empty alert list", async () => {
    state.list.mockRejectedValue(new Error("unavailable"));
    setup();
    await screen.findByRole("alert");
    expect(screen.queryByText("Aucune alerte enregistrée.")).toBeNull();
  });
});
