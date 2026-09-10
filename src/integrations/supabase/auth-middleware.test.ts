import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getClaims: vi.fn(), from: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getClaims: mocks.getClaims }, from: mocks.from }),
}));
import { requireSupabaseAuthContext } from "./auth-middleware";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "fixture-key");
});
afterEach(() => vi.unstubAllEnvs());
it("normalizes a thrown expired JWT error before querying account rights", async () => {
  mocks.getClaims.mockRejectedValue(new Error("JWT has expired"));
  await expect(requireSupabaseAuthContext("expired-fixture")).rejects.toThrow(
    "Unauthorized: Invalid token",
  );
  expect(mocks.from).not.toHaveBeenCalled();
});
it("rejects errors returned by the SDK before querying account rights", async () => {
  mocks.getClaims.mockResolvedValue({ data: null, error: new Error("Invalid JWT") });
  await expect(requireSupabaseAuthContext("invalid-fixture")).rejects.toThrow(
    "Unauthorized: Invalid token",
  );
  expect(mocks.from).not.toHaveBeenCalled();
});
it("uses the verified subject to read the account's current rights", async () => {
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "verified-user" } }, error: null });
  const eq = vi.fn().mockReturnValue({
    maybeSingle: vi
      .fn()
      .mockResolvedValue({ data: { account_tier: "premium", user_role: "user" }, error: null }),
  });
  mocks.from.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) });
  const result = await requireSupabaseAuthContext("valid-fixture");
  expect(eq).toHaveBeenCalledWith("user_id", "verified-user");
  expect(result).toMatchObject({ userId: "verified-user", accountTier: "premium", isAdmin: false });
});
