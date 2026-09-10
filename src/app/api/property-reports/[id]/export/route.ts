import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { exportPropertyReportPdf } from "@/lib/property-reports";

type RouteParams = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const pdf = await exportPropertyReportPdf({ auth, reportId: id });
    const body = pdf.bytes.buffer.slice(
      pdf.bytes.byteOffset,
      pdf.bytes.byteOffset + pdf.bytes.byteLength,
    ) as ArrayBuffer;

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": pdf.contentType,
        "content-disposition": `attachment; filename="${pdf.filename}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservé") || message.startsWith("Forbidden")
        ? 403
        : 400;
    return Response.json(
      { ok: false, error: message },
      { status, headers: { "cache-control": "private, no-store", vary: "authorization" } },
    );
  }
}
