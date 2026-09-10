import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), plan: vi.fn(), usage: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "test-token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/usage", () => ({ getPlanUsageSummary: mocks.usage }));
afterEach(() => vi.resetAllMocks());

describe("feature entitlements scope", () => {
  it("returns verified access without querying unused usage counters", async () => {
    mocks.auth.mockResolvedValue({ userId: "verified" });
    mocks.plan.mockResolvedValue({ hasAnalysisAccess: false });
    const response = await GET(new Request("http://localhost/api/feature-entitlements?scope=plan"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan: { hasAnalysisAccess: false } });
    expect(mocks.auth).toHaveBeenCalledWith("test-token");
    expect(mocks.plan).toHaveBeenCalledWith({ userId: "verified" });
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it("preserves usage counters for the complete response", async () => {
    mocks.auth.mockResolvedValue({ userId: "verified" });
    mocks.plan.mockResolvedValue({ hasAnalysisAccess: true });
    mocks.usage.mockResolvedValue({ limits: [] });
    const response = await GET(new Request("http://localhost/api/feature-entitlements"));
    expect(await response.json()).toEqual({
      plan: { hasAnalysisAccess: true },
      usage: { limits: [] },
    });
    expect(mocks.usage).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid identity before reading the plan", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized"));
    const response = await GET(new Request("http://localhost/api/feature-entitlements?scope=plan"));
    expect(response.status).toBe(401);
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled();
  });
});
