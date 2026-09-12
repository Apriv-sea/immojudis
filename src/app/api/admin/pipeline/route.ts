import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const client = supabaseAdmin as unknown as SupabaseClient;
async function authorize(request: Request) {
  const context = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
  if (!context.isAdmin) throw new Error("Forbidden: accès administrateur requis");
}
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Supervision indisponible";
  return NextResponse.json(
    { error: message },
    {
      status: message.startsWith("Unauthorized")
        ? 401
        : message.startsWith("Forbidden")
          ? 403
          : error instanceof z.ZodError
            ? 400
            : 500,
    },
  );
}
export async function GET(request: Request) {
  try {
    await authorize(request);
    const results = await Promise.all([
      client.from("auction_source_state").select("*").order("source_name"),
      client.from("auction_pipeline_control").select("*").single(),
      client
        .from("auction_pipeline_observations")
        .select("source_name,observed_at,metrics")
        .order("observed_at", { ascending: false })
        .limit(11),
      client
        .from("operational_alerts")
        .select("alert_key,status,details,notification_status,notification_event,last_seen_at")
        .like("alert_key", "pipeline.%")
        .order("last_seen_at", { ascending: false }),
      client.rpc("pipeline_usage_summary"),
    ]);
    for (const result of results) if (result.error) throw new Error(result.error.message);
    return NextResponse.json(
      {
        sources: results[0].data,
        control: results[1].data,
        observations: results[2].data,
        alerts: results[3].data,
        usage: results[4].data,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    await authorize(request);
    const input = z
      .object({ source: z.string().min(1).max(60), enabled: z.boolean() })
      .strict()
      .parse(await request.json());
    const { data, error } = await client
      .from("auction_source_state")
      .update({
        enabled: input.enabled,
        suspension_reason: input.enabled ? null : "Suspendue depuis l’administration",
        updated_at: new Date().toISOString(),
      })
      .eq("source_name", input.source)
      .select("source_name,enabled")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: "Source inconnue" }, { status: 404 });
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
