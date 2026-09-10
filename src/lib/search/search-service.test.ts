import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSales, getSalesWithCoords, rpc } = vi.hoisted(() => ({
  getSales: vi.fn(),
  getSalesWithCoords: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc },
}));

vi.mock("@/lib/queries", () => ({
  getSales,
  getSalesCount: vi.fn(),
  getSalesWithCoords,
}));

import { fetchSearchCount, fetchSearchMapResults, fetchSearchResults } from "./search-service";

describe("public preview search service", () => {
  beforeEach(() => {
    getSales.mockReset();
    getSalesWithCoords.mockReset();
    rpc.mockReset();
  });

  it("maps useful public facts without copying unexpected protected fields", async () => {
    rpc.mockResolvedValue({
      data: [
        {
          id: "public-sale",
          starting_price_eur: 90000,
          total_count: 1,
          city: "Bordeaux",
          department: "33",
          property_type: "apartment",
          app_surface_m2: 60,
          sale_date: "2026-10-01T09:00:00Z",
          latitude: 44.84,
          longitude: -0.58,
          thumbnail_url: "https://example.test/property-photo.jpg",
          address: "must not leak",
          lawyer_contact: "must not leak",
          documents: [{ url: "private" }],
          investment_score: 82,
        },
      ],
      error: null,
    });
    const [sale] = await fetchSearchResults({ search: {}, preview: true });
    expect(sale).toMatchObject({
      city: "Bordeaux",
      app_surface_m2: 60,
      latitude: 44.84,
      media: [{ type: "image", url: "https://example.test/property-photo.jpg" }],
    });
    for (const key of [
      "address",
      "lawyer_contact",
      "documents",
      "investment_score",
      "thumbnail_url",
    ]) {
      expect(sale).not.toHaveProperty(key);
    }
    const { buildMapboxSaleFeatureCollection } = await import("@/lib/mapbox-sales");
    expect(buildMapboxSaleFeatureCollection([sale]).features[0].geometry.coordinates).toEqual([
      -0.58, 44.84,
    ]);
  });

  it.each([
    "javascript:alert(1)",
    "https://example.test/document.pdf",
    "https://example.test/logo.png",
  ])("rejects an unsuitable thumbnail: %s", async (thumbnail_url) => {
    rpc.mockResolvedValue({
      data: [{ id: "public-sale", total_count: 1, thumbnail_url }],
      error: null,
    });
    const [sale] = await fetchSearchResults({ search: {}, preview: true });
    expect(sale.media).toEqual([]);
  });

  it("fetches only the requested authenticated page with a real offset", async () => {
    getSales.mockResolvedValue([]);

    await fetchSearchResults({
      search: { page: 3, limit: 24, sort: "newest" },
      preview: false,
      discovery: true,
    });

    expect(getSales).toHaveBeenCalledWith(expect.any(Object), 24, "date_desc", 48, {
      discovery: true,
    });
  });

  it("preserves public classification, filters before counting and deduplicates each family separately", async () => {
    rpc.mockImplementation((_name, args) =>
      Promise.resolve({
        data: [
          {
            id: args.p_sale_venue_type,
            starting_price_eur: 120000,
            sale_venue_type: args.p_sale_venue_type,
            sale_verification_status: "pending",
            total_count: 37,
            lawyer_contact: "must not leak",
          },
        ],
        error: null,
      }),
    );
    const [items, count, tribunal] = await Promise.all([
      fetchSearchResults({ search: { saleType: "notary", page: 2 }, preview: true }),
      fetchSearchCount({ search: { saleType: "notary", page: 2 }, preview: true }),
      fetchSearchResults({ search: { saleType: "tribunal", page: 2 }, preview: true }),
    ]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview_v3",
      expect.objectContaining({ p_sale_venue_type: "notary", p_offset: 24 }),
    );
    expect(items).toEqual([
      {
        id: "notary",
        starting_price_eur: 120000,
        sale_venue_type: "notary",
        sale_verification_status: "pending",
        media: [],
      },
    ]);
    expect(count).toBe(37);
    expect(tribunal[0].sale_venue_type).toBe("tribunal");
  });

  it("excludes homepage example sales from authenticated and map results", async () => {
    const example = {
      id: "example-immojudis-nantes-maison",
      source_name: "Dossier de démonstration Immojudis",
    };
    const realSale = { id: "49deebe5-bbba-4c8a-9f4e-237a2edbae94" };
    getSales.mockResolvedValue([example, realSale]);
    getSalesWithCoords.mockResolvedValue([realSale, example]);

    await expect(fetchSearchResults({ search: {}, preview: false })).resolves.toEqual([realSale]);
    await expect(fetchSearchMapResults({})).resolves.toEqual([realSale]);
  });

  it("excludes homepage example sales from anonymous preview results", async () => {
    rpc.mockResolvedValue({
      data: [
        {
          id: "example-immojudis-bordeaux-t2",
          starting_price_eur: 92_000,
          total_count: 2,
        },
        {
          id: "49deebe5-bbba-4c8a-9f4e-237a2edbae94",
          starting_price_eur: 135_000,
          total_count: 2,
        },
      ],
      error: null,
    });

    await expect(fetchSearchResults({ search: {}, preview: true })).resolves.toEqual([
      { id: "49deebe5-bbba-4c8a-9f4e-237a2edbae94", starting_price_eur: 135_000, media: [] },
    ]);
  });

  it("deduplicates the preview request and sends expanded region departments", async () => {
    rpc.mockResolvedValue({
      data: [{ id: "sale-33", starting_price_eur: 120_000, total_count: 7 }],
      error: null,
    });

    const search = { query: "Nouvelle-Aquitaine" };
    const [items, count] = await Promise.all([
      fetchSearchResults({ search, preview: true }),
      fetchSearchCount({ search, preview: true }),
    ]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview_v3",
      expect.objectContaining({
        p_departments: expect.arrayContaining(["33", "Gironde", "64", "Pyrénées-Atlantiques"]),
        p_keywords: null,
        p_postal_code: null,
      }),
    );
    expect(items).toEqual([{ id: "sale-33", starting_price_eur: 120_000, media: [] }]);
    expect(count).toBe(7);
  });

  it("sends a postal code as an exact preview filter", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await fetchSearchResults({ search: { query: "33000" }, preview: true });

    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview_v3",
      expect.objectContaining({
        p_departments: null,
        p_keywords: null,
        p_postal_code: "33000",
      }),
    );
  });

  it("paginates preview RPC results without reloading earlier rows", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await fetchSearchResults({ search: { page: 4, limit: 12 }, preview: true });

    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview_v3",
      expect.objectContaining({ p_limit: 12, p_offset: 36 }),
    );
  });

  it("normalizes an accent-insensitive city query into keyword terms", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await fetchSearchResults({ search: { query: "Nîmes centre" }, preview: true });

    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview_v3",
      expect.objectContaining({ p_keywords: ["nimes", "centre"] }),
    );
  });

  it("allows public surface and room filters but never sends protected analysis or exact-location filters", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await fetchSearchResults({
      search: {
        minSqft: 80,
        minBeds: 3,
        occupancy: "vacant",
        minScore: 70,
        viewport: { north: 45, south: 44, east: 1, west: 0 },
      },
      preview: true,
    });

    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview_v3",
      expect.objectContaining({
        p_min_surface: 80,
        p_min_bedrooms: 3,
        p_occupancy_status: null,
        p_min_score: null,
        p_north: null,
        p_south: null,
        p_east: null,
        p_west: null,
      }),
    );
  });
});
