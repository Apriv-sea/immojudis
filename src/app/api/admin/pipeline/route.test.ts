import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
import { GET, PATCH } from "./route";
beforeEach(() => vi.resetAllMocks());
it("does not read privileged pipeline data for a non-admin", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: false });
  expect((await GET(new Request("https://example.test/api/admin/pipeline"))).status).toBe(403);
  expect(mocks.from).not.toHaveBeenCalled();
});
it("rejects unknown mutation fields before any database update", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: true });
  const response = await PATCH(
    new Request("https://example.test/api/admin/pipeline", {
      method: "PATCH",
      body: JSON.stringify({ source: "licitor", enabled: true, suspended_until: null }),
    }),
  );
  expect(response.status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
});
it("pause does not erase an access refusal cooldown", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: true });
  const update = vi.fn();
  mocks.from.mockReturnValue({ update });
  update.mockReturnValue({
    eq: () => ({
      select: () => ({
        maybeSingle: async () => ({ data: { source_name: "licitor", enabled: false } }),
      }),
    }),
  });
  const response = await PATCH(
    new Request("https://example.test/api/admin/pipeline", {
      method: "PATCH",
      body: JSON.stringify({ source: "licitor", enabled: false }),
    }),
  );
  expect(response.status).toBe(200);
  expect(update.mock.calls[0][0].enabled).toBe(false);
  expect(update.mock.calls[0][0]).not.toHaveProperty("suspended_until");
});
