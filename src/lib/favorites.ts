import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { featureAccess, featureIncluded, type FeatureAccess, type PlanCode } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { DETAIL_VIEW, SALE_LIST_COLUMNS } from "@/lib/queries";
import { recordFeatureUsageEvent } from "@/lib/usage";
import type { AuctionSale } from "@/lib/types";

type FavoriteRow = Database["public"]["Tables"]["user_favorites"]["Row"];

export const favoriteSaleInputSchema = z.object({
  saleId: z.string().uuid(),
});

export type FavoriteSaleInput = z.input<typeof favoriteSaleInputSchema>;
export type FavoriteSalePayload = z.output<typeof favoriteSaleInputSchema>;

export type FavoriteSale = {
  id: string;
  saleId: string;
  favoritedAt: string;
  sale: AuctionSale;
};

export type FavoriteDepartmentSummary = {
  department: string;
  count: number;
  totalStartingPriceEur: number;
};

export type FavoriteSalesSummary = {
  total: number;
  upcomingAudiences: number;
  nextAudienceAt: string | null;
  totalStartingPriceEur: number;
  averageStartingPriceEur: number | null;
  averageInvestmentScore: number | null;
  departments: FavoriteDepartmentSummary[];
};

export type FavoritePlanAccess = {
  code: PlanCode;
  label: string;
  feature: FeatureAccess;
  limit: number | null;
};

export type FavoriteSalesResponse = {
  favorites: FavoriteSale[];
  unavailableSaleIds: string[];
  summary: FavoriteSalesSummary;
  plan: FavoritePlanAccess;
};

export type FavoriteSaleMutationResponse = {
  favorite: FavoriteSale | null;
  created: boolean;
  plan: FavoritePlanAccess;
};

export type FavoriteSaleDeleteResponse = {
  ok: true;
  removed: boolean;
  plan: FavoritePlanAccess;
};

export async function listFavoriteSales({
  auth,
}: {
  auth: SupabaseAuthContext;
}): Promise<FavoriteSalesResponse> {
  const plan = await assertSaleFavoritesAvailable(auth);
  const favoriteRows = await loadFavoriteRows(auth);
  const sales = await loadSalesByIds(
    auth,
    favoriteRows.map((favorite) => favorite.sale_id),
    plan.plan,
  );
  const favorites = joinFavoriteRowsToSales(favoriteRows, sales);

  return {
    favorites,
    unavailableSaleIds: favoriteRows
      .filter((row) => !favorites.some((favorite) => favorite.saleId === row.sale_id))
      .map((row) => row.sale_id),
    summary: buildFavoriteSalesSummary(favorites),
    plan: favoritePlanAccess(plan),
  };
}

export async function addFavoriteSale({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: FavoriteSalePayload;
}): Promise<FavoriteSaleMutationResponse> {
  const plan = await assertSaleFavoritesAvailable(auth);
  const { row, created } = await insertFavoriteRow(auth, input.saleId);
  const sales = await loadSalesByIds(auth, [row.sale_id], plan.plan);
  const [favorite] = joinFavoriteRowsToSales([row], sales);

  if (created) {
    await recordFeatureUsageEvent({
      auth,
      eventKey: "sales.favorite_added",
      subjectType: "sale",
      subjectId: input.saleId,
      metadata: {
        source: "favorites_api",
      },
    });
  }

  return {
    favorite: favorite ?? null,
    created,
    plan: favoritePlanAccess(plan),
  };
}

export async function removeFavoriteSale({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: FavoriteSalePayload;
}): Promise<FavoriteSaleDeleteResponse> {
  const plan = await assertSaleFavoritesAvailable(auth);
  const { data, error } = await auth.supabase
    .from("user_favorites")
    .delete()
    .eq("user_id", auth.userId)
    .eq("sale_id", input.saleId)
    .select("*")
    .maybeSingle();

  if (error) throw error;

  if (data) {
    await recordFeatureUsageEvent({
      auth,
      eventKey: "sales.favorite_removed",
      subjectType: "sale",
      subjectId: input.saleId,
      metadata: {
        source: "favorites_api",
      },
    });
  }

  return {
    ok: true,
    removed: Boolean(data),
    plan: favoritePlanAccess(plan),
  };
}

export function joinFavoriteRowsToSales(
  favoriteRows: Array<Pick<FavoriteRow, "id" | "sale_id" | "created_at">>,
  sales: AuctionSale[],
): FavoriteSale[] {
  const salesById = new Map(sales.map((sale) => [sale.id, sale]));
  return favoriteRows.flatMap((favorite) => {
    const sale = salesById.get(favorite.sale_id);
    if (!sale) return [];
    return [
      {
        id: favorite.id,
        saleId: favorite.sale_id,
        favoritedAt: favorite.created_at,
        sale,
      },
    ];
  });
}

export function buildFavoriteSalesSummary(
  favorites: FavoriteSale[],
  now = new Date(),
): FavoriteSalesSummary {
  const prices = favorites
    .map((favorite) => favorite.sale.starting_price_eur)
    .filter((price): price is number => typeof price === "number" && Number.isFinite(price));
  const scores = favorites
    .map((favorite) => favorite.sale.investment_score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  const upcomingDates = favorites
    .map((favorite) => favorite.sale.sale_date)
    .filter((date): date is string => typeof date === "string" && Date.parse(date) >= now.getTime())
    .sort((a, b) => Date.parse(a) - Date.parse(b));

  return {
    total: favorites.length,
    upcomingAudiences: upcomingDates.length,
    nextAudienceAt: upcomingDates[0] ?? null,
    totalStartingPriceEur: sum(prices),
    averageStartingPriceEur: average(prices),
    averageInvestmentScore: average(scores),
    departments: buildDepartmentSummary(favorites),
  };
}

async function assertSaleFavoritesAvailable(auth: SupabaseAuthContext) {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "sales.favorites")) {
    throw new Error("Favoris réservés au plan Analyse.");
  }
  return plan;
}

async function loadFavoriteRows(auth: SupabaseAuthContext): Promise<FavoriteRow[]> {
  const { data, error } = await auth.supabase
    .from("user_favorites")
    .select("*")
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

async function loadSalesByIds(
  auth: SupabaseAuthContext,
  saleIds: string[],
  plan: PlanCode,
): Promise<AuctionSale[]> {
  const ids = [...new Set(saleIds)].filter(Boolean);
  if (!ids.length) return [];

  const { data, error } = await auth.supabase
    .from(plan === "analyse" ? DETAIL_VIEW : ("v_auction_sales_discovery" as typeof DETAIL_VIEW))
    .select(SALE_LIST_COLUMNS)
    .in("id", ids);
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

async function insertFavoriteRow(
  auth: SupabaseAuthContext,
  saleId: string,
): Promise<{ row: FavoriteRow; created: boolean }> {
  const { data, error } = await auth.supabase
    .from("user_favorites")
    .insert({
      user_id: auth.userId,
      sale_id: saleId,
    })
    .select("*")
    .maybeSingle();

  if (!error && data) {
    return { row: data, created: true };
  }

  if (error && !isDuplicateFavoriteError(error)) throw error;

  const existing = await loadFavoriteRow(auth, saleId);
  if (!existing) {
    throw error ?? new Error("Favori introuvable après insertion.");
  }

  return { row: existing, created: false };
}

async function loadFavoriteRow(
  auth: SupabaseAuthContext,
  saleId: string,
): Promise<FavoriteRow | null> {
  const { data, error } = await auth.supabase
    .from("user_favorites")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("sale_id", saleId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

function favoritePlanAccess(plan: {
  plan: PlanCode;
  label: string;
  limits: { favoriteSales: number | null };
}): FavoritePlanAccess {
  return {
    code: plan.plan,
    label: plan.label,
    feature: featureAccess(plan.plan, "sales.favorites"),
    limit: plan.limits.favoriteSales,
  };
}

function buildDepartmentSummary(favorites: FavoriteSale[]): FavoriteDepartmentSummary[] {
  const departments = new Map<string, FavoriteDepartmentSummary>();
  for (const favorite of favorites) {
    const department = favorite.sale.department?.trim() || "Non renseigné";
    const current =
      departments.get(department) ??
      ({
        department,
        count: 0,
        totalStartingPriceEur: 0,
      } satisfies FavoriteDepartmentSummary);
    current.count += 1;
    current.totalStartingPriceEur += favorite.sale.starting_price_eur ?? 0;
    departments.set(department, current);
  }

  return [...departments.values()].sort(
    (a, b) => b.count - a.count || a.department.localeCompare(b.department),
  );
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((sum(values) / values.length) * 10) / 10;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function isDuplicateFavoriteError(error: { code?: string; message?: string }): boolean {
  return error.code === "23505" || /duplicate|unique/i.test(error.message ?? "");
}
