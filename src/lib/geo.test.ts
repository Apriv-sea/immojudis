import { afterEach, expect, it, vi } from "vitest";
import { geocodeAdministrativeArea } from "./geo";
vi.mock("@/lib/mapbox", () => ({ getMapboxAccessToken: () => "public-test-token" }));
afterEach(() => vi.unstubAllGlobals());
it("geocodes administrative areas without confusing them with streets", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      features: [{ geometry: { coordinates: [-0.6, 44.8] }, properties: { name: "Gironde" } }],
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  expect(await geocodeAdministrativeArea("Gironde")).toMatchObject({ lat: 44.8, lng: -0.6 });
  const url = new URL(fetchMock.mock.calls[0][0]);
  expect(url.searchParams.get("types")).toBe("region,district");
  expect(url.searchParams.get("q")).toBe("Gironde");
});
