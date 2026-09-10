// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FavoriteButton } from "./FavoriteButton";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "alice" } as { id: string } | null, loading: false },
  read: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/router-compat", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/client-api", () => ({
  addFavoriteSale: mocks.add,
  removeFavoriteSale: mocks.remove,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const query = { select: () => query, eq: () => query, maybeSingle: mocks.read };
      return query;
    },
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.auth.user = { id: "alice" };
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = () => (
    <QueryClientProvider client={client}>
      <FavoriteButton saleId="sale" />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return { rerender: () => rendered.rerender(view()) };
}

describe("favorite account isolation", () => {
  it("ignores a previous account's delayed lookup after switching accounts", async () => {
    let resolveAlice!: (value: unknown) => void;
    mocks.read
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAlice = resolve;
          }),
      )
      .mockResolvedValueOnce({ data: null, error: null });
    const view = setup();
    mocks.auth.user = { id: "bob" };
    view.rerender();
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => resolveAlice({ data: { sale_id: "sale" }, error: null }));
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
  });

  it("does not apply an old account's mutation result to the next account", async () => {
    let resolveAdd!: () => void;
    mocks.read.mockResolvedValue({ data: null, error: null });
    mocks.add.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const view = setup();
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button"));
    mocks.auth.user = { id: "bob" };
    view.rerender();
    await act(async () => resolveAdd());
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
    mocks.auth.user = null;
    view.rerender();
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
  });
});
