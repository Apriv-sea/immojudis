import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { UserAlert } from "./types";
import { assertCloudConfigured } from "./query-configuration";

// Alerts
type UserAlertInsert = Database["public"]["Tables"]["user_alerts"]["Insert"];
export type CreateAlertPayload = Omit<
  UserAlertInsert,
  "id" | "user_id" | "created_at" | "updated_at" | "last_evaluated_at" | "last_match_count"
> & {
  is_active?: boolean;
};

export async function getAlerts(userId: string): Promise<UserAlert[]> {
  if (!assertCloudConfigured()) return [];
  const { data, error } = await supabase
    .from("user_alerts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as UserAlert[];
}

export async function createAlert(userId: string, payload: CreateAlertPayload) {
  assertCloudConfigured();
  const insertPayload: UserAlertInsert = {
    user_id: userId,
    ...payload,
    is_active: payload.is_active ?? true,
    dpe_classes: payload.dpe_classes ?? [],
    require_house_with_land: payload.require_house_with_land ?? false,
    alert_frequency: payload.alert_frequency ?? "daily",
    advanced_criteria: payload.advanced_criteria ?? {},
  };
  const { error } = await supabase.from("user_alerts").insert(insertPayload);
  if (error) throw error;
}

export async function updateAlert(userId: string, alertId: string, patch: Partial<UserAlert>) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_alerts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteAlert(userId: string, alertId: string) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_alerts")
    .delete()
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) throw error;
}
