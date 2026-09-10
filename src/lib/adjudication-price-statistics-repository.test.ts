import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { serverFrom } = vi.hoisted(() => ({ serverFrom: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: serverFrom },
}));

import {
  adjudicationPriceStatisticsEnabled,
  getAdjudicationPriceStatisticsForSale,
} from "@/lib/adjudication-price-statistics-repository";

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const BUILD_ID = "22222222-2222-4222-8222-222222222222";

import { bidBands } from "./adjudication-distributions";

describe("adjudication price statistics repository", () => {
  const previousFlag = process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED;
  const previousBuildId = process.env.ADJUDICATION_PRICE_STATISTICS_BUILD_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED = "true";
    delete process.env.ADJUDICATION_PRICE_STATISTICS_BUILD_ID;
  });

  afterEach(() => {
    if (previousBuildId === undefined) delete process.env.ADJUDICATION_PRICE_STATISTICS_BUILD_ID;
    else process.env.ADJUDICATION_PRICE_STATISTICS_BUILD_ID = previousBuildId;
    if (previousFlag === undefined) delete process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED;
    else process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED = previousFlag;
  });

  it("n’active la publication que pour la valeur exacte true", () => {
    expect(adjudicationPriceStatisticsEnabled("true")).toBe(true);
    expect(adjudicationPriceStatisticsEnabled("TRUE")).toBe(false);
    expect(adjudicationPriceStatisticsEnabled("1")).toBe(false);
    expect(adjudicationPriceStatisticsEnabled("")).toBe(false);
  });

  it("refuse un identifiant de retour arrière invalide avant toute lecture", async () => {
    process.env.ADJUDICATION_PRICE_STATISTICS_BUILD_ID = "invalid";
    await expect(getAdjudicationPriceStatisticsForSale(SALE_ID)).rejects.toThrow(
      "build ID is invalid",
    );
    expect(serverFrom).not.toHaveBeenCalled();
  });

  it("sélectionne uniquement le calcul approuvé épinglé, sans repli s’il est absent", async () => {
    process.env.ADJUDICATION_PRICE_STATISTICS_BUILD_ID = BUILD_ID;
    const saleQuery = fakeQuery({
      data: { tribunal_code: null, sale_venue_type: "tribunal" },
      error: null,
    });
    const nationalQuery = fakeQuery({ data: null, error: null });
    serverFrom.mockReturnValueOnce(saleQuery.query).mockReturnValueOnce(nationalQuery.query);
    await expect(getAdjudicationPriceStatisticsForSale(SALE_ID)).rejects.toThrow(
      "No reviewed national",
    );
    expect(nationalQuery.state.filters).toContainEqual(["build_id", BUILD_ID]);
    expect(serverFrom).toHaveBeenCalledTimes(2);
  });

  it("refuse une réponse qui ne correspond pas au calcul épinglé", async () => {
    process.env.ADJUDICATION_PRICE_STATISTICS_BUILD_ID = "33333333-3333-4333-8333-333333333333";
    const saleQuery = fakeQuery({
      data: { tribunal_code: null, sale_venue_type: "tribunal" },
      error: null,
    });
    const nationalQuery = fakeQuery({ data: storedRow(), error: null });
    serverFrom.mockReturnValueOnce(saleQuery.query).mockReturnValueOnce(nationalQuery.query);
    await expect(getAdjudicationPriceStatisticsForSale(SALE_ID)).rejects.toThrow("invalid scope");
    expect(serverFrom).toHaveBeenCalledTimes(2);
  });

  it("bloque avant toute lecture quand le kill switch est fermé", async () => {
    process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED = "false";

    await expect(getAdjudicationPriceStatisticsForSale(SALE_ID)).rejects.toThrow(
      "statistics are disabled",
    );
    expect(serverFrom).not.toHaveBeenCalled();
  });

  it("sert France puis le tribunal exact du même build sans exposer ses identifiants", async () => {
    process.env.ADJUDICATION_PRICE_STATISTICS_BUILD_ID = BUILD_ID;
    const saleQuery = fakeQuery({
      data: { tribunal_code: "justice_tj_1_59", sale_venue_type: "tribunal" },
      error: null,
    });
    const nationalQuery = fakeQuery({ data: storedRow(), error: null });
    const tribunalQuery = fakeQuery({
      data: storedRow({
        scope_type: "tribunal",
        court_code: "justice_tj_1_59",
        scope_label: "Tribunal judiciaire de Marseille",
        judicial_region: "Aix-en-Provence",
        sample_size: 152,
      }),
      error: null,
    });
    serverFrom
      .mockReturnValueOnce(saleQuery.query)
      .mockReturnValueOnce(nationalQuery.query)
      .mockReturnValueOnce(tribunalQuery.query);

    const response = await getAdjudicationPriceStatisticsForSale(SALE_ID);
    expect(nationalQuery.state.filters).toContainEqual(["build_id", BUILD_ID]);

    expect(response.national).toMatchObject({
      scopeType: "national",
      label: "France entière",
      sampleSize: 3_868,
      reliability: "extended",
    });
    expect(response.tribunal).toMatchObject({
      scopeType: "tribunal",
      courtCode: "justice_tj_1_59",
      reliability: "extended",
    });
    expect(serverFrom).toHaveBeenNthCalledWith(1, "auction_sales");
    expect(serverFrom).toHaveBeenNthCalledWith(2, "published_adjudication_price_statistics");
    expect(serverFrom).toHaveBeenNthCalledWith(3, "published_adjudication_price_statistics");
    expect(tribunalQuery.state.filters).toEqual(
      expect.arrayContaining([
        ["build_id", BUILD_ID],
        ["scope_type", "tribunal"],
        ["court_code", "justice\\_tj\\_1\\_59"],
      ]),
    );
    expect(JSON.stringify(response)).not.toContain(BUILD_ID);
    expect(nationalQuery.state.selected).not.toMatch(/court_id|statistics_hash|manifest/i);
  });

  it("conserve les repères France sans substituer un autre tribunal", async () => {
    const saleQuery = fakeQuery({
      data: { tribunal_code: "justice_tj_missing", sale_venue_type: "tribunal" },
      error: null,
    });
    const nationalQuery = fakeQuery({ data: storedRow(), error: null });
    const tribunalQuery = fakeQuery({ data: null, error: null });
    serverFrom
      .mockReturnValueOnce(saleQuery.query)
      .mockReturnValueOnce(nationalQuery.query)
      .mockReturnValueOnce(tribunalQuery.query);

    const response = await getAdjudicationPriceStatisticsForSale(SALE_ID);

    expect(response.national.sampleSize).toBe(3_868);
    expect(response.tribunal).toBeNull();
  });

  it("transmet les enrichissements validés sans les colonnes internes", async () => {
    const distribution = {
      sampleSize: 3868,
      hammerPriceMiddle50Eur: { p25: 67750, p75: 225250.75 },
      ratioMiddle50: { p25: 1.17, p75: 3.1 },
      bidDistribution: bidBands.map((band, index) => ({
        band,
        count: index === 0 ? 3868 : 0,
        share: index === 0 ? 1 : 0,
      })),
    };
    serverFrom
      .mockReturnValueOnce(
        fakeQuery({ data: { tribunal_code: "missing", sale_venue_type: "tribunal" }, error: null })
          .query,
      )
      .mockReturnValueOnce(
        fakeQuery({
          data: storedRow({ extra_statistics: { distribution, propertyTypes: [] } }),
          error: null,
        }).query,
      )
      .mockReturnValueOnce(fakeQuery({ data: null, error: null }).query);
    const response = await getAdjudicationPriceStatisticsForSale(SALE_ID);
    expect(response.national.distribution).toEqual(distribution);
    expect(response.national.propertyTypes).toEqual([]);
    expect(JSON.stringify(response)).not.toContain("extra_statistics");
  });

  it("conserve le repli national lorsque le rattachement exact reste non résolu", async () => {
    serverFrom
      .mockReturnValueOnce(
        fakeQuery({ data: { tribunal_code: null, sale_venue_type: "tribunal" }, error: null })
          .query,
      )
      .mockReturnValueOnce(fakeQuery({ data: storedRow(), error: null }).query)
      .mockReturnValueOnce(
        fakeQuery({
          data: {
            tribunal_code: null,
            tribunal: null,
            sale_venue_type: "tribunal",
            sale_verification_status: "pending",
          },
          error: null,
        }).query,
      )
      .mockReturnValueOnce(fakeQuery({ data: null, error: null }).query);
    const response = await getAdjudicationPriceStatisticsForSale(SALE_ID);
    expect(response.national.sampleSize).toBe(3868);
    expect(response.tribunal).toBeNull();
  });

  it("réutilise une affectation officielle lorsque la vente n’a pas de code direct", async () => {
    const initialSaleQuery = fakeQuery({
      data: { tribunal_code: null, sale_venue_type: "tribunal" },
      error: null,
    });
    const nationalQuery = fakeQuery({ data: storedRow(), error: null });
    const resolverSaleQuery = fakeQuery({
      data: {
        tribunal_code: null,
        tribunal: "Tribunal judiciaire de Marseille",
        sale_venue_type: "tribunal",
        sale_verification_status: "pending",
      },
      error: null,
    });
    const assignmentQuery = fakeQuery({
      data: { court_code: "justice_tj_1_59" },
      error: null,
    });
    const tribunalQuery = fakeQuery({
      data: storedRow({
        scope_type: "tribunal",
        court_code: "justice_tj_1_59",
        scope_label: "Tribunal judiciaire de Marseille",
        judicial_region: "Aix-en-Provence",
        sample_size: 152,
      }),
      error: null,
    });
    serverFrom
      .mockReturnValueOnce(initialSaleQuery.query)
      .mockReturnValueOnce(nationalQuery.query)
      .mockReturnValueOnce(resolverSaleQuery.query)
      .mockReturnValueOnce(assignmentQuery.query)
      .mockReturnValueOnce(tribunalQuery.query);

    const response = await getAdjudicationPriceStatisticsForSale(SALE_ID);

    expect(response.tribunal?.courtCode).toBe("justice_tj_1_59");
    expect(serverFrom).toHaveBeenNthCalledWith(4, "auction_sale_competent_court_assignments");
    expect(assignmentQuery.state.filters).toContainEqual(["auction_sale_id", SALE_ID]);
  });

  it("classe une ligne Supabase invalide comme indisponibilité interne", async () => {
    const saleQuery = fakeQuery({
      data: { tribunal_code: null, sale_venue_type: "tribunal" },
      error: null,
    });
    const nationalQuery = fakeQuery({
      data: storedRow({ median_hammer_price_eur: null }),
      error: null,
    });
    serverFrom.mockReturnValueOnce(saleQuery.query).mockReturnValueOnce(nationalQuery.query);

    await expect(getAdjudicationPriceStatisticsForSale(SALE_ID)).rejects.toMatchObject({
      name: "AdjudicationPriceStatisticsUnavailableError",
    });
  });
});

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    build_id: BUILD_ID,
    scope_type: "national",
    court_code: null,
    scope_label: "France entière",
    judicial_region: null,
    period_start: "2023-09-07",
    period_end: "2026-09-07",
    sample_size: 3_868,
    median_hammer_to_starting_ratio: "1.9383",
    above_starting_rate: "0.893485",
    at_least_double_rate: "0.485264",
    median_hammer_price_eur: "126000",
    median_starting_price_eur: "55000",
    methodology_version: "licitor_canonical_price_statistics_v1",
    source_name: "licitor",
    built_at: "2026-09-07T12:00:00.000Z",
    reviewed_at: "2026-09-07T13:00:00.000Z",
    ...overrides,
  };
}

function fakeQuery(result: { data: unknown; error: { message: string } | null }) {
  const state: {
    selected: string;
    filters: Array<[string, unknown]>;
    orders: Array<[string, { ascending?: boolean } | undefined]>;
    limit: number | null;
  } = { selected: "", filters: [], orders: [], limit: null };
  const query: Record<string, unknown> = {};
  query.select = vi.fn((columns: string) => {
    state.selected = columns;
    return query;
  });
  query.eq = vi.fn((column: string, value: unknown) => {
    state.filters.push([column, value]);
    return query;
  });
  query.ilike = vi.fn((column: string, value: unknown) => {
    state.filters.push([column, value]);
    return query;
  });
  query.order = vi.fn((column: string, options?: { ascending?: boolean }) => {
    state.orders.push([column, options]);
    return query;
  });
  query.limit = vi.fn((count: number) => {
    state.limit = count;
    return query;
  });
  query.maybeSingle = vi.fn(async () => result);
  query.then = (resolve: (value: typeof result) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { query, state };
}
