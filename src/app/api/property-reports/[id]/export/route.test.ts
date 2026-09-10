import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), exportPdf: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "fixture-token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/property-reports", () => ({ exportPropertyReportPdf: mocks.exportPdf }));
import { POST } from "./route";
const request = () =>
  new Request("http://localhost/api/property-reports/fixture/export", { method: "POST" });
const params = { params: Promise.resolve({ id: "fixture" }) };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ userId: "user" });
});
it("returns 403 and prevents caching when the plan does not include PDF export", async () => {
  mocks.exportPdf.mockRejectedValue(new Error("Export PDF réservé au plan Analyse."));
  const response = await POST(request(), params);
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("authorization");
  expect(await response.json()).toEqual({
    ok: false,
    error: "Export PDF réservé au plan Analyse.",
  });
});
it("returns 401 without invoking export when authentication fails", async () => {
  mocks.auth.mockRejectedValue(new Error("Unauthorized: Invalid token"));
  expect((await POST(request(), params)).status).toBe(401);
  expect(mocks.exportPdf).not.toHaveBeenCalled();
});
it("preserves PDF bytes for an entitled owner", async () => {
  mocks.exportPdf.mockResolvedValue({
    bytes: new Uint8Array([37, 80, 68, 70]),
    contentType: "application/pdf",
    filename: "rapport.pdf",
  });
  const response = await POST(request(), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
});
