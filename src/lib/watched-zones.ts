import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import type { UserWatchedZone } from "@/lib/types";
import { WATCHED_ZONE_KINDS } from "@/lib/watched-zones-shared";

type WatchedZoneRow = Database["public"]["Tables"]["user_watched_zones"]["Row"];
type WatchedZoneInsert = Database["public"]["Tables"]["user_watched_zones"]["Insert"];
type WatchedZoneUpdate = Database["public"]["Tables"]["user_watched_zones"]["Update"];

export const watchedZoneAlertDefaultsSchema = z
  .object({
    maxPriceEur: z.number().finite().min(0).nullable().optional(),
    minSurfaceM2: z.number().finite().min(0).nullable().optional(),
    minInvestmentScore: z.number().finite().min(0).max(100).nullable().optional(),
    maxPricePerM2: z.number().finite().min(0).nullable().optional(),
    minYieldPct: z.number().finite().min(0).max(100).nullable().optional(),
    minMarketDiscountPct: z.number().finite().min(0).max(100).nullable().optional(),
    dpeClasses: z.array(z.enum(["A", "B", "C", "D", "E", "F", "G"])).default([]),
    requireHouseWithLand: z.boolean().default(false),
  })
  .default({});

const watchedZoneShape = z.object({
  name: z.string().trim().min(2).max(120),
  zoneKind: z.enum(WATCHED_ZONE_KINDS).default("city"),
  department: z.string().trim().max(3).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  postalCodePrefix: z.string().trim().max(5).nullable().optional(),
  centerLat: z.number().finite().min(-90).max(90).nullable().optional(),
  centerLng: z.number().finite().min(-180).max(180).nullable().optional(),
  radiusKm: z.number().finite().min(0.1).max(200).nullable().optional(),
  alertDefaults: watchedZoneAlertDefaultsSchema.optional(),
  isActive: z.boolean().optional(),
});

export const watchedZoneInputSchema = watchedZoneShape.superRefine((value, context) => {
  if (value.zoneKind === "department" && !cleanString(value.department)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["department"],
      message: "Département requis pour une zone départementale.",
    });
  }
  if (value.zoneKind === "city" && !cleanString(value.city)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["city"],
      message: "Ville requise pour une zone communale.",
    });
  }
  if (value.zoneKind === "postal_code" && !cleanString(value.postalCodePrefix)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["postalCodePrefix"],
      message: "Préfixe postal requis pour une zone par code postal.",
    });
  }
  if (
    value.zoneKind === "radius" &&
    (value.centerLat == null || value.centerLng == null || value.radiusKm == null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["radiusKm"],
      message: "Coordonnées et rayon requis pour une zone géographique.",
    });
  }
});

export const watchedZoneUpdateSchema = watchedZoneShape.partial();

export type WatchedZoneInput = z.input<typeof watchedZoneInputSchema>;
export type WatchedZonePayload = z.output<typeof watchedZoneInputSchema>;
export type WatchedZoneUpdateInput = z.input<typeof watchedZoneUpdateSchema>;
export type WatchedZoneUpdatePayload = z.output<typeof watchedZoneUpdateSchema>;

export type WatchedZonesResponse = {
  zones: UserWatchedZone[];
  limit: number | null;
};

export type WatchedZoneResponse = {
  zone: UserWatchedZone;
  limit: number | null;
};

export async function listWatchedZones({
  auth,
  includeInactive = false,
}: {
  auth: SupabaseAuthContext;
  includeInactive?: boolean;
}): Promise<WatchedZonesResponse> {
  const plan = await resolvePlanEntitlements(auth);
  let query = auth.supabase
    .from("user_watched_zones")
    .select("*")
    .eq("user_id", auth.userId)
    .order("updated_at", { ascending: false });

  if (!includeInactive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) throw error;

  return {
    zones: (data ?? []).map(normalizeWatchedZone),
    limit: plan.limits.watchedZones,
  };
}

export async function createWatchedZone({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: WatchedZonePayload;
}): Promise<WatchedZoneResponse> {
  const plan = await assertWatchedZonesAvailable(auth);
  const existing = await maybeWatchedZoneByName(auth, input.name);
  if (existing) {
    return updateWatchedZone({ auth, zoneId: existing.id, input });
  }

  await assertWatchedZoneLimit(auth, plan.limits.watchedZones);

  const insertPayload: WatchedZoneInsert = {
    user_id: auth.userId,
    ...watchedZonePayloadToDb(input),
  };

  const { data, error } = await auth.supabase
    .from("user_watched_zones")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error) throw error;

  return {
    zone: normalizeWatchedZone(data),
    limit: plan.limits.watchedZones,
  };
}

export async function updateWatchedZone({
  auth,
  zoneId,
  input,
}: {
  auth: SupabaseAuthContext;
  zoneId: string;
  input: WatchedZoneUpdatePayload;
}): Promise<WatchedZoneResponse> {
  const plan = await assertWatchedZonesAvailable(auth);
  const existing = await requireWatchedZone(auth, zoneId);
  const next = mergeWatchedZone(existing, input);

  if (!existing.is_active && next.isActive !== false) {
    await assertWatchedZoneLimit(auth, plan.limits.watchedZones);
  }

  const updatePayload: WatchedZoneUpdate = {
    ...watchedZonePayloadToDb(watchedZoneInputSchema.parse(next)),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await auth.supabase
    .from("user_watched_zones")
    .update(updatePayload)
    .eq("id", zoneId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;

  return {
    zone: normalizeWatchedZone(data),
    limit: plan.limits.watchedZones,
  };
}

export async function deleteWatchedZone({
  auth,
  zoneId,
}: {
  auth: SupabaseAuthContext;
  zoneId: string;
}): Promise<{ ok: true }> {
  await requireWatchedZone(auth, zoneId);

  const { error: alertError } = await auth.supabase
    .from("user_alerts")
    .update({
      watched_zone_id: null,
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", auth.userId)
    .eq("watched_zone_id", zoneId);
  if (alertError) throw alertError;

  const { error } = await auth.supabase
    .from("user_watched_zones")
    .delete()
    .eq("id", zoneId)
    .eq("user_id", auth.userId);
  if (error) throw error;

  return { ok: true };
}

export function normalizeWatchedZone(row: WatchedZoneRow): UserWatchedZone {
  const parsedDefaults = watchedZoneAlertDefaultsSchema.safeParse(row.alert_defaults);
  return {
    ...row,
    alert_defaults: parsedDefaults.success ? parsedDefaults.data : {},
  };
}

async function assertWatchedZonesAvailable(auth: SupabaseAuthContext) {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "alerts.watchedZones")) {
    throw new Error("Zones surveillées réservées au plan Analyse.");
  }
  return plan;
}

async function assertWatchedZoneLimit(auth: SupabaseAuthContext, limit: number | null) {
  if (limit == null) return;

  const { count, error } = await auth.supabase
    .from("user_watched_zones")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .eq("is_active", true);
  if (error) throw error;
  if ((count ?? 0) >= limit) {
    throw new Error(`Limite de ${limit} zones surveillées actives atteinte.`);
  }
}

async function requireWatchedZone(
  auth: SupabaseAuthContext,
  zoneId: string,
): Promise<UserWatchedZone> {
  const { data, error } = await auth.supabase
    .from("user_watched_zones")
    .select("*")
    .eq("id", zoneId)
    .eq("user_id", auth.userId)
    .single();

  if (error) throw error;
  return normalizeWatchedZone(data);
}

async function maybeWatchedZoneByName(
  auth: SupabaseAuthContext,
  name: string,
): Promise<UserWatchedZone | null> {
  const { data, error } = await auth.supabase
    .from("user_watched_zones")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("name", name)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeWatchedZone(data) : null;
}

function watchedZonePayloadToDb(input: WatchedZonePayload): Omit<WatchedZoneInsert, "user_id"> {
  return {
    name: input.name,
    zone_kind: input.zoneKind,
    department: cleanString(input.department) ?? null,
    city: cleanString(input.city) ?? null,
    postal_code_prefix: cleanString(input.postalCodePrefix) ?? null,
    center_lat: input.centerLat ?? null,
    center_lng: input.centerLng ?? null,
    radius_km: input.radiusKm ?? null,
    alert_defaults: asJson(input.alertDefaults ?? {}),
    is_active: input.isActive ?? true,
  };
}

function mergeWatchedZone(
  current: UserWatchedZone,
  patch: WatchedZoneUpdatePayload,
): WatchedZonePayload {
  return {
    name: patch.name ?? current.name,
    zoneKind: patch.zoneKind ?? current.zone_kind,
    department: patch.department !== undefined ? patch.department : current.department,
    city: patch.city !== undefined ? patch.city : current.city,
    postalCodePrefix:
      patch.postalCodePrefix !== undefined ? patch.postalCodePrefix : current.postal_code_prefix,
    centerLat: patch.centerLat !== undefined ? patch.centerLat : current.center_lat,
    centerLng: patch.centerLng !== undefined ? patch.centerLng : current.center_lng,
    radiusKm: patch.radiusKm !== undefined ? patch.radiusKm : current.radius_km,
    alertDefaults:
      patch.alertDefaults !== undefined
        ? patch.alertDefaults
        : watchedZoneAlertDefaultsSchema.parse(current.alert_defaults),
    isActive: patch.isActive !== undefined ? patch.isActive : current.is_active,
  };
}

function cleanString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function asJson(value: unknown): Json {
  return value as Json;
}
