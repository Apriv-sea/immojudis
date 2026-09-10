import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { cleanSaleTitle } from "@/lib/sale-title";
import {
  buildSaleComparisonSnapshot,
  readSaleComparisonSnapshot,
  type ComparedSale,
} from "@/lib/search/sale-comparison";

type AnalysisSetRow = Database["public"]["Tables"]["user_sale_analysis_sets"]["Row"];
type AnalysisSetInsert = Database["public"]["Tables"]["user_sale_analysis_sets"]["Insert"];
type AnalysisSetUpdate = Database["public"]["Tables"]["user_sale_analysis_sets"]["Update"];
type AnalysisItemRow = Database["public"]["Tables"]["user_sale_analysis_items"]["Row"];
type AnalysisItemInsert = Database["public"]["Tables"]["user_sale_analysis_items"]["Insert"];
type AnalysisSetMetadata = Pick<
  SaleAnalysisSetPayload,
  "name" | "analysisKind" | "notes" | "assumptions" | "summarySnapshot" | "isArchived"
> & {
  id: string;
  is_archived: boolean;
};

export const SALE_ANALYSIS_KINDS = ["comparison", "watchlist", "portfolio"] as const;
export const SALE_ANALYSIS_DECISION_STATUSES = [
  "watching",
  "shortlisted",
  "bid_ready",
  "rejected",
  "won",
  "lost",
] as const;

export const saleAnalysisItemInputSchema = z.object({
  saleId: z.string().uuid(),
  decisionStatus: z.enum(SALE_ANALYSIS_DECISION_STATUSES).default("watching"),
  userMaxBidEur: z.number().finite().min(0).nullable().optional(),
  targetYieldPct: z.number().finite().min(0).max(100).nullable().optional(),
  expectedMarginPct: z.number().finite().min(-100).max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const saleAnalysisSetInputSchema = z.object({
  name: z.string().trim().min(2).max(140),
  analysisKind: z.enum(SALE_ANALYSIS_KINDS).default("comparison"),
  notes: z.string().trim().max(3000).nullable().optional(),
  assumptions: z.record(z.unknown()).default({}),
  summarySnapshot: z.record(z.unknown()).default({}),
  isArchived: z.boolean().default(false),
  items: z.array(saleAnalysisItemInputSchema).min(1).max(12),
});

export const saleAnalysisSetUpdateSchema = saleAnalysisSetInputSchema.partial().extend({
  items: z.array(saleAnalysisItemInputSchema).min(1).max(12).optional(),
});

export type SaleAnalysisItemInput = z.input<typeof saleAnalysisItemInputSchema>;
export type SaleAnalysisSetInput = z.input<typeof saleAnalysisSetInputSchema>;
export type SaleAnalysisSetPayload = z.output<typeof saleAnalysisSetInputSchema>;
export type SaleAnalysisSetUpdateInput = z.input<typeof saleAnalysisSetUpdateSchema>;
export type SaleAnalysisSetUpdatePayload = z.output<typeof saleAnalysisSetUpdateSchema>;

export type SaleAnalysisSaleSummary = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  investmentScore: number | null;
};

export type SaleAnalysisItem = Omit<AnalysisItemRow, "decision_status" | "sale_id"> & {
  sale_id: string;
  decision_status: (typeof SALE_ANALYSIS_DECISION_STATUSES)[number];
  sale: SaleAnalysisSaleSummary | null;
};

export type SaleAnalysisSummary = {
  itemCount: number;
  totalStartingPriceEur: number | null;
  totalUserMaxBidEur: number | null;
  averageInvestmentScore: number | null;
  earliestSaleDate: string | null;
  cities: string[];
};

export type SaleAnalysisSet = Omit<
  AnalysisSetRow,
  | "analysis_kind"
  | "assumptions"
  | "summary_snapshot"
  | "share_token_hash"
  | "shared_at"
  | "share_expires_at"
> & {
  analysis_kind: (typeof SALE_ANALYSIS_KINDS)[number];
  assumptions: Record<string, unknown>;
  summary_snapshot: Record<string, unknown>;
  items: SaleAnalysisItem[];
  summary: SaleAnalysisSummary;
  sharing: {
    enabled: boolean;
    sharedAt: string | null;
    expiresAt: string | null;
  };
};

export type SaleAnalysisSetListResponse = {
  sets: SaleAnalysisSet[];
  limit: number | null;
  itemLimit: number | null;
};

export type SaleAnalysisSetResponse = {
  set: SaleAnalysisSet;
  limit: number | null;
  itemLimit: number | null;
};

export type SaleComparisonShareResponse = {
  enabled: boolean;
  url: string | null;
  expiresAt: string | null;
};

export type PublicSharedSaleComparison = {
  name: string;
  items: ComparedSale[];
  sharedAt: string;
  expiresAt: string;
  updatedAt: string;
};

export async function listSaleAnalysisSets({
  auth,
  includeArchived = false,
}: {
  auth: SupabaseAuthContext;
  includeArchived?: boolean;
}): Promise<SaleAnalysisSetListResponse> {
  const plan = await resolvePlanEntitlements(auth);
  let query = auth.supabase
    .from("user_sale_analysis_sets")
    .select("*")
    .eq("user_id", auth.userId)
    .order("updated_at", { ascending: false });

  if (!includeArchived) query = query.eq("is_archived", false);

  const { data: sets, error } = await query;
  if (error) throw error;

  return {
    sets: await hydrateAnalysisSets({
      auth,
      sets: sets ?? [],
      includeAnalysis: plan.hasAnalysisAccess,
    }),
    limit: plan.limits.saleAnalysisSets,
    itemLimit: plan.limits.saleAnalysisItems,
  };
}

export async function createSaleAnalysisSet({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: SaleAnalysisSetPayload;
}): Promise<SaleAnalysisSetResponse> {
  const plan = await assertSaleAnalysisAvailable(auth, input.analysisKind);
  const preparedInput = await prepareAnalysisSetInput(input);
  assertItemLimit(preparedInput.items.length, plan.limits.saleAnalysisItems);

  const existing = await maybeAnalysisSetByName(auth, preparedInput.name);
  if (existing) {
    return updateSaleAnalysisSet({ auth, setId: existing.id, input: preparedInput });
  }

  await assertSetLimit(auth, plan.limits.saleAnalysisSets);

  const insertPayload: AnalysisSetInsert = {
    user_id: auth.userId,
    ...analysisSetPayloadToDb(preparedInput),
  };

  const { data, error } = await auth.supabase
    .from("user_sale_analysis_sets")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error) throw error;

  try {
    await replaceAnalysisItems({ auth, setId: data.id, items: preparedInput.items });
  } catch (error) {
    await auth.supabase
      .from("user_sale_analysis_sets")
      .delete()
      .eq("id", data.id)
      .eq("user_id", auth.userId);
    throw error;
  }
  const [set] = await hydrateAnalysisSets({
    auth,
    sets: [data],
    includeAnalysis: plan.hasAnalysisAccess,
  });

  return {
    set,
    limit: plan.limits.saleAnalysisSets,
    itemLimit: plan.limits.saleAnalysisItems,
  };
}

export async function updateSaleAnalysisSet({
  auth,
  setId,
  input,
}: {
  auth: SupabaseAuthContext;
  setId: string;
  input: SaleAnalysisSetUpdatePayload;
}): Promise<SaleAnalysisSetResponse> {
  const plan = await assertSaleAnalysisAvailable(auth);
  const existing = await requireAnalysisSet(auth, setId);
  const requestedKind = input.analysisKind ?? existing.analysisKind;
  assertAnalysisKindAvailable(plan.plan, requestedKind);
  const preparedInput = await prepareAnalysisSetUpdate(input, requestedKind);
  const next = mergeAnalysisSetMetadata(existing, preparedInput);

  if (!existing.is_archived && next.isArchived === false) {
    await assertSetLimit(auth, plan.limits.saleAnalysisSets, existing.id);
  }
  if (preparedInput.items) {
    assertItemLimit(preparedInput.items.length, plan.limits.saleAnalysisItems);
  }

  const { data, error } = await auth.supabase
    .from("user_sale_analysis_sets")
    .update({
      ...analysisSetMetadataToDb(next),
      updated_at: new Date().toISOString(),
    })
    .eq("id", setId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;
  if (preparedInput.items) {
    await replaceAnalysisItems({ auth, setId, items: preparedInput.items });
  }

  const [set] = await hydrateAnalysisSets({
    auth,
    sets: [data],
    includeAnalysis: plan.hasAnalysisAccess,
  });

  return {
    set,
    limit: plan.limits.saleAnalysisSets,
    itemLimit: plan.limits.saleAnalysisItems,
  };
}

export async function deleteSaleAnalysisSet({
  auth,
  setId,
}: {
  auth: SupabaseAuthContext;
  setId: string;
}): Promise<{ ok: true }> {
  await requireAnalysisSet(auth, setId);

  const { error } = await auth.supabase
    .from("user_sale_analysis_sets")
    .delete()
    .eq("id", setId)
    .eq("user_id", auth.userId);
  if (error) throw error;

  return { ok: true };
}

export async function enableSaleComparisonShare({
  auth,
  setId,
  origin,
}: {
  auth: SupabaseAuthContext;
  setId: string;
  origin: string;
}): Promise<SaleComparisonShareResponse> {
  await assertSaleAnalysisAvailable(auth, "comparison");
  const set = await requireAnalysisSet(auth, setId);
  if (set.analysisKind !== "comparison") {
    throw new Error("Seules les comparaisons peuvent être partagées.");
  }
  if (!readSaleComparisonSnapshot(set.summarySnapshot).length) {
    throw new Error("Cette comparaison ne contient aucun bien partageable.");
  }

  const token = randomBytes(24).toString("base64url");
  const sharedAt = new Date();
  const expiresAt = new Date(sharedAt.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
  const { error } = await supabaseAdmin
    .from("user_sale_analysis_sets")
    .update({
      share_token_hash: hashShareToken(token),
      shared_at: sharedAt.toISOString(),
      share_expires_at: expiresAt,
      updated_at: sharedAt.toISOString(),
    })
    .eq("id", setId)
    .eq("user_id", auth.userId);
  if (error) throw error;

  return {
    enabled: true,
    url: new URL(`/comparaisons/${token}`, origin).toString(),
    expiresAt,
  };
}

export async function disableSaleComparisonShare({
  auth,
  setId,
}: {
  auth: SupabaseAuthContext;
  setId: string;
}): Promise<SaleComparisonShareResponse> {
  await assertSaleAnalysisAvailable(auth, "comparison");
  await requireAnalysisSet(auth, setId);
  const { error } = await supabaseAdmin
    .from("user_sale_analysis_sets")
    .update({
      share_token_hash: null,
      shared_at: null,
      share_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", setId)
    .eq("user_id", auth.userId);
  if (error) throw error;

  return { enabled: false, url: null, expiresAt: null };
}

export async function getSharedSaleComparison(token: string): Promise<PublicSharedSaleComparison> {
  const normalizedToken = normalizeShareToken(token);
  if (!normalizedToken) throw new Error("Lien de comparaison invalide.");

  const { data, error } = await supabaseAdmin
    .from("user_sale_analysis_sets")
    .select("name,analysis_kind,summary_snapshot,shared_at,share_expires_at,updated_at")
    .eq("share_token_hash", hashShareToken(normalizedToken))
    .eq("analysis_kind", "comparison")
    .maybeSingle();
  if (error) throw error;

  const expiresAt = data?.share_expires_at;
  const sharedAt = data?.shared_at;
  const items = readSaleComparisonSnapshot(data?.summary_snapshot);
  if (
    !data ||
    !expiresAt ||
    !sharedAt ||
    new Date(expiresAt).getTime() <= Date.now() ||
    !items.length
  ) {
    throw new Error("Comparaison partagée introuvable ou expirée.");
  }

  return {
    name: data.name,
    items,
    sharedAt,
    expiresAt,
    updatedAt: data.updated_at,
  };
}

export function buildSaleAnalysisSummary(items: SaleAnalysisItem[]): SaleAnalysisSummary {
  const saleItems = items.filter((item) => item.sale);
  const startingPrices = saleItems
    .map((item) => item.sale?.startingPriceEur)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const userMaxBids = items
    .map((item) => item.user_max_bid_eur)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const scores = saleItems
    .map((item) => item.sale?.investmentScore)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const saleDates = saleItems
    .map((item) => item.sale?.saleDate)
    .filter((value): value is string => Boolean(value))
    .sort();
  const cities = Array.from(
    new Set(
      saleItems.map((item) => item.sale?.city).filter((value): value is string => Boolean(value)),
    ),
  ).slice(0, 8);

  return {
    itemCount: items.length,
    totalStartingPriceEur: sumOrNull(startingPrices),
    totalUserMaxBidEur: sumOrNull(userMaxBids),
    averageInvestmentScore: averageOrNull(scores),
    earliestSaleDate: saleDates[0] ?? null,
    cities,
  };
}

async function hydrateAnalysisSets({
  auth,
  sets,
  includeAnalysis,
}: {
  auth: SupabaseAuthContext;
  sets: AnalysisSetRow[];
  includeAnalysis: boolean;
}): Promise<SaleAnalysisSet[]> {
  if (!sets.length) return [];

  const setIds = sets.map((set) => set.id);
  const { data: items, error } = await auth.supabase
    .from("user_sale_analysis_items")
    .select("*")
    .eq("user_id", auth.userId)
    .in("analysis_set_id", setIds)
    .order("item_order", { ascending: true });
  if (error) throw error;

  const saleIds = Array.from(new Set((items ?? []).map((item) => item.sale_id)));
  const salesById = await fetchSaleSummaries(auth, saleIds, includeAnalysis);
  const itemsBySet = groupItemsBySet(items ?? [], salesById);

  return sets.map((set) => normalizeAnalysisSet(set, itemsBySet.get(set.id) ?? []));
}

function normalizeAnalysisSet(set: AnalysisSetRow, items: SaleAnalysisItem[]): SaleAnalysisSet {
  const { share_token_hash: _shareTokenHash, shared_at, share_expires_at, ...safeSet } = set;
  const shareExpiry = share_expires_at ? new Date(share_expires_at).getTime() : Number.NaN;
  return {
    ...safeSet,
    analysis_kind: normalizeAnalysisKind(set.analysis_kind),
    assumptions: normalizeJsonObject(set.assumptions),
    summary_snapshot: normalizeJsonObject(set.summary_snapshot),
    items,
    summary: buildSaleAnalysisSummary(items),
    sharing: {
      enabled: Boolean(shared_at && Number.isFinite(shareExpiry) && shareExpiry > Date.now()),
      sharedAt: shared_at,
      expiresAt: share_expires_at,
    },
  };
}

function groupItemsBySet(
  items: AnalysisItemRow[],
  salesById: Map<string, SaleAnalysisSaleSummary>,
): Map<string, SaleAnalysisItem[]> {
  const grouped = new Map<string, SaleAnalysisItem[]>();

  items.forEach((item) => {
    const normalized: SaleAnalysisItem = {
      ...item,
      decision_status: normalizeDecisionStatus(item.decision_status),
      sale: salesById.get(item.sale_id) ?? null,
    };
    grouped.set(item.analysis_set_id, [...(grouped.get(item.analysis_set_id) ?? []), normalized]);
  });

  return grouped;
}

async function fetchSaleSummaries(
  auth: SupabaseAuthContext,
  saleIds: string[],
  includeAnalysis: boolean,
): Promise<Map<string, SaleAnalysisSaleSummary>> {
  if (!saleIds.length) return new Map();

  if (!includeAnalysis) {
    const { data, error } = await supabaseAdmin
      .from("auction_sales")
      .select("id,city,department,starting_price_eur,sale_date")
      .in("id", saleIds);
    if (error) throw error;

    return new Map(
      (data ?? []).map((sale) => [
        sale.id,
        {
          id: sale.id,
          title: null,
          city: sale.city,
          department: sale.department,
          startingPriceEur: sale.starting_price_eur,
          saleDate: sale.sale_date,
          investmentScore: null,
        },
      ]),
    );
  }

  const { data, error } = await auth.supabase
    .from("auction_sales")
    .select("id,title,city,department,starting_price_eur,sale_date,investment_score")
    .in("id", saleIds);

  if (error) throw error;

  return new Map(
    (data ?? []).map((sale) => [
      sale.id,
      {
        id: sale.id,
        title: cleanSaleTitle(sale.title),
        city: sale.city,
        department: sale.department,
        startingPriceEur: sale.starting_price_eur,
        saleDate: sale.sale_date,
        investmentScore: sale.investment_score,
      },
    ]),
  );
}

async function replaceAnalysisItems({
  auth,
  setId,
  items,
}: {
  auth: SupabaseAuthContext;
  setId: string;
  items: z.output<typeof saleAnalysisItemInputSchema>[];
}) {
  const uniqueItems = dedupeItems(items);

  const { error: deleteError } = await auth.supabase
    .from("user_sale_analysis_items")
    .delete()
    .eq("analysis_set_id", setId)
    .eq("user_id", auth.userId);
  if (deleteError) throw deleteError;

  const rows: AnalysisItemInsert[] = uniqueItems.map((item, index) => ({
    analysis_set_id: setId,
    user_id: auth.userId,
    sale_id: item.saleId,
    item_order: index,
    decision_status: item.decisionStatus,
    user_max_bid_eur: item.userMaxBidEur ?? null,
    target_yield_pct: item.targetYieldPct ?? null,
    expected_margin_pct: item.expectedMarginPct ?? null,
    notes: item.notes ?? null,
  }));

  if (!rows.length) return;
  const { error } = await auth.supabase.from("user_sale_analysis_items").insert(rows);
  if (error) throw error;
}

async function assertSaleAnalysisAvailable(
  auth: SupabaseAuthContext,
  analysisKind?: (typeof SALE_ANALYSIS_KINDS)[number],
) {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "sales.multiPropertyAnalysis")) {
    throw new Error("Analyse multi-biens réservée au plan Analyse.");
  }
  if (analysisKind) assertAnalysisKindAvailable(plan.plan, analysisKind);
  return plan;
}

function assertAnalysisKindAvailable(
  plan: "decouverte" | "analyse",
  analysisKind: (typeof SALE_ANALYSIS_KINDS)[number],
) {
  if (plan === "decouverte" && analysisKind !== "comparison") {
    throw new Error("Les listes de suivi et portefeuilles sont réservés au plan Analyse.");
  }
}

async function assertSetLimit(
  auth: SupabaseAuthContext,
  limit: number | null,
  currentSetId?: string,
) {
  if (limit == null) return;

  let query = auth.supabase
    .from("user_sale_analysis_sets")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .eq("is_archived", false);
  if (currentSetId) query = query.neq("id", currentSetId);

  const { count, error } = await query;
  if (error) throw error;
  if ((count ?? 0) >= limit) {
    throw new Error(`Limite de ${limit} analyses multi-biens actives atteinte.`);
  }
}

function assertItemLimit(itemCount: number, limit: number | null) {
  if (limit != null && itemCount > limit) {
    throw new Error(`Limite de ${limit} biens par analyse atteinte.`);
  }
}

async function requireAnalysisSet(
  auth: SupabaseAuthContext,
  setId: string,
): Promise<AnalysisSetMetadata> {
  const { data, error } = await auth.supabase
    .from("user_sale_analysis_sets")
    .select("*")
    .eq("id", setId)
    .eq("user_id", auth.userId)
    .single();

  if (error) throw error;
  return {
    id: data.id,
    name: data.name,
    analysisKind: normalizeAnalysisKind(data.analysis_kind),
    notes: data.notes,
    assumptions: normalizeJsonObject(data.assumptions),
    summarySnapshot: normalizeJsonObject(data.summary_snapshot),
    isArchived: data.is_archived,
    is_archived: data.is_archived,
  };
}

async function maybeAnalysisSetByName(
  auth: SupabaseAuthContext,
  name: string,
): Promise<AnalysisSetRow | null> {
  const { data, error } = await auth.supabase
    .from("user_sale_analysis_sets")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("name", name)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

function analysisSetPayloadToDb(
  input: Pick<
    SaleAnalysisSetPayload,
    "name" | "analysisKind" | "notes" | "assumptions" | "summarySnapshot" | "isArchived"
  >,
): Omit<AnalysisSetInsert, "user_id"> {
  return {
    name: input.name,
    analysis_kind: input.analysisKind,
    notes: input.notes ?? null,
    assumptions: asJson(input.assumptions ?? {}),
    summary_snapshot: asJson(input.summarySnapshot ?? {}),
    is_archived: input.isArchived ?? false,
  };
}

function analysisSetMetadataToDb(input: AnalysisSetMetadata): AnalysisSetUpdate {
  return analysisSetPayloadToDb(input);
}

function mergeAnalysisSetMetadata(
  current: AnalysisSetMetadata,
  patch: SaleAnalysisSetUpdatePayload,
): AnalysisSetMetadata {
  return {
    id: current.id,
    name: patch.name ?? current.name,
    analysisKind: patch.analysisKind ?? current.analysisKind,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
    assumptions: patch.assumptions ?? current.assumptions,
    summarySnapshot: patch.summarySnapshot ?? current.summarySnapshot,
    isArchived: patch.isArchived !== undefined ? patch.isArchived : current.is_archived,
    is_archived: current.is_archived,
  };
}

function dedupeItems(
  items: z.output<typeof saleAnalysisItemInputSchema>[],
): z.output<typeof saleAnalysisItemInputSchema>[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.saleId)) return false;
    seen.add(item.saleId);
    return true;
  });
}

function normalizeAnalysisKind(value: string): (typeof SALE_ANALYSIS_KINDS)[number] {
  return SALE_ANALYSIS_KINDS.includes(value as (typeof SALE_ANALYSIS_KINDS)[number])
    ? (value as (typeof SALE_ANALYSIS_KINDS)[number])
    : "comparison";
}

function normalizeDecisionStatus(value: string): (typeof SALE_ANALYSIS_DECISION_STATUSES)[number] {
  return SALE_ANALYSIS_DECISION_STATUSES.includes(
    value as (typeof SALE_ANALYSIS_DECISION_STATUSES)[number],
  )
    ? (value as (typeof SALE_ANALYSIS_DECISION_STATUSES)[number])
    : "watching";
}

function normalizeJsonObject(value: Json): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sumOrNull(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0));
}

function averageOrNull(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function asJson(value: unknown): Json {
  return value as Json;
}

async function prepareAnalysisSetInput(
  input: SaleAnalysisSetPayload,
): Promise<SaleAnalysisSetPayload> {
  const items = dedupeItems(input.items);
  if (input.analysisKind !== "comparison") return { ...input, items };

  return {
    ...input,
    items,
    summarySnapshot: asRecord(await buildCanonicalComparisonSnapshot(items)),
  };
}

async function prepareAnalysisSetUpdate(
  input: SaleAnalysisSetUpdatePayload,
  analysisKind: (typeof SALE_ANALYSIS_KINDS)[number],
): Promise<SaleAnalysisSetUpdatePayload> {
  if (!input.items) {
    return analysisKind === "comparison" ? { ...input, summarySnapshot: undefined } : input;
  }

  const items = dedupeItems(input.items);
  return {
    ...input,
    items,
    ...(analysisKind === "comparison"
      ? { summarySnapshot: asRecord(await buildCanonicalComparisonSnapshot(items)) }
      : {}),
  };
}

async function buildCanonicalComparisonSnapshot(
  items: z.output<typeof saleAnalysisItemInputSchema>[],
) {
  const saleIds = items.map((item) => item.saleId);
  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select(
      "id,city,department,property_type,sale_venue_type,sale_date,starting_price_eur,app_surface_m2,app_surface_kind,rooms_count,bedrooms_count,bathrooms_count,status",
    )
    .in("id", saleIds)
    .in("status", ["upcoming", "unknown"]);
  if (error) throw error;

  const byId = new Map((data ?? []).map((sale) => [sale.id, sale]));
  const missing = saleIds.filter((saleId) => !byId.has(saleId));
  if (missing.length) throw new Error("Certains biens à comparer sont introuvables ou expirés.");

  const comparedSales: ComparedSale[] = saleIds.map((saleId) => {
    const sale = byId.get(saleId)!;
    return {
      id: sale.id,
      city: sale.city,
      department: sale.department,
      propertyType: sale.property_type,
      venueType: canonicalSaleVenueType(sale.sale_venue_type),
      saleDate: sale.sale_date,
      startingPriceEur: sale.starting_price_eur,
      surfaceM2: sale.app_surface_m2,
      surfaceKind: sale.app_surface_kind,
      rooms: sale.rooms_count,
      bedrooms: sale.bedrooms_count,
      bathrooms: sale.bathrooms_count,
    };
  });

  return buildSaleComparisonSnapshot(comparedSales);
}

function canonicalSaleVenueType(value: string | null): ComparedSale["venueType"] {
  if (value === "tribunal" || value === "notary" || value === "state" || value === "online") {
    return value;
  }
  return "unknown";
}

function normalizeShareToken(value: string): string | null {
  const token = value.trim();
  return /^[A-Za-z0-9_-]{32}$/.test(token) ? token : null;
}

function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
