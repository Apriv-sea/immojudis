// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertNotificationCenter } from "./AlertNotificationCenter";
const state = vi.hoisted(() => ({
  userId: "first" as string | null,
  list: vi.fn(),
  preferences: vi.fn(),
  entitlements: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: state.userId ? { id: state.userId } : null, loading: false }),
}));
vi.mock("@/lib/client-api", () => ({
  fetchAlertNotifications: state.list,
  fetchFeatureEntitlements: state.entitlements,
  fetchNotificationPreferences: state.preferences,
  updateAlertNotification: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}));
vi.mock("@/lib/router-compat", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.userId = "first";
  state.list.mockResolvedValue({ notifications: [] });
  state.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
  state.preferences.mockResolvedValue({ preferences: { alertEmailEnabled: true } });
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = () => (
    <QueryClientProvider client={client}>
      <AlertNotificationCenter />
    </QueryClientProvider>
  );
  return { ...render(view()), view, client };
}
describe("notification panel", () => {
  it("loads preferences only on opening and forbids email for Discovery", async () => {
    setup();
    await waitFor(() => expect(state.list).toHaveBeenCalledOnce());
    expect(state.preferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const checkbox = await screen.findByRole("checkbox");
    await waitFor(() => expect(state.preferences).toHaveBeenCalledOnce());
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("reports fetch errors without presenting an empty inbox", async () => {
    state.list.mockRejectedValue(new Error("offline"));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Aucune alerte")).toBeNull();
  });
  it("closes the previous account panel immediately on account change", async () => {
    const ui = setup();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await screen.findByRole("dialog");
    state.userId = "second";
    ui.rerender(ui.view());
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(ui.client.getQueryData(["alert-notifications", "second"])).toEqual({
        notifications: [],
      }),
    );
    state.userId = null;
    ui.rerender(ui.view());
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
  });
});
