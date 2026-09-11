import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ insert: mocks.insert, update: mocks.update }),
  },
}));
import { startAdminScroll } from "@/lib/admin.functions";
import { collectionSourceResults } from "@/lib/admin-source-collection";

describe("manual collection includes cloud sources in the existing workflow", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "dispatch-test-token");
    vi.stubEnv("GITHUB_SCROLL_REF", "main");
    mocks.auth.mockResolvedValue({
      userId: "admin",
      isAdmin: true,
      claims: { email: "admin@example.test" },
    });
    mocks.insert.mockImplementation((payload) => ({
      select: () => ({
        limit: () =>
          Promise.resolve({
            data: [{ id: "run-test", ...payload }],
            error: null,
          }),
      }),
    }));
    mocks.update.mockReturnValue({ eq: () => Promise.resolve({ error: null }) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each(["all", "petites_affiches", "cessions_etat"])(
    "dispatches %s once with the tracked run id",
    async (source) => {
      const result = await startAdminScroll("admin-token", { source, mode: "collect" });
      expect(result.dispatched).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [, options] = vi.mocked(fetch).mock.calls[0];
      expect(JSON.parse(String(options?.body))).toMatchObject({
        ref: "main",
        inputs: {
          source,
          run_id: "run-test",
          llm_backfill: "false",
        },
      });
      expect(mocks.insert).toHaveBeenCalledTimes(1);
    },
  );

  it("denies non-admin callers before creating or dispatching a run", async () => {
    mocks.auth.mockResolvedValue({ userId: "member", isAdmin: false });
    await expect(startAdminScroll("user-token", { source: "all" })).rejects.toThrow("Forbidden");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows actual transport and errors without inventing historical transport", () => {
    expect(
      collectionSourceResults({
        scrape_coverage: {
          petites_affiches: { fetch_transport: "supabase", listings_emitted: 10, errors: 0 },
          cessions_etat: { fetch_transport: "supabase", listings_emitted: 0, errors: 1 },
          licitor: { listings_emitted: 3 },
        },
      }),
    ).toEqual([
      { source: "petites_affiches", transport: "Supabase", listings: 10, failed: false },
      { source: "cessions_etat", transport: "Supabase", listings: 0, failed: true },
      { source: "licitor", transport: "Non renseigné", listings: 3, failed: false },
    ]);
  });
});
