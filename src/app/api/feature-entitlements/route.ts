import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { getPlanUsageSummary } from "@/lib/usage";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const plan = await resolvePlanEntitlements(auth);
    if (new URL(request.url).searchParams.get("scope") === "plan") {
      return NextResponse.json({ plan });
    }
    const usage = await getPlanUsageSummary({ auth, plan });
    return NextResponse.json({ plan, usage });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Accès indisponible";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
