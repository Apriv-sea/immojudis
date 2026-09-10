import { NextResponse } from "next/server";
import { getSharedSaleComparison } from "@/lib/sale-analysis-sets";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const comparison = await getSharedSaleComparison(token);
    return NextResponse.json(comparison, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Comparaison indisponible";
    return NextResponse.json(
      { comparison: null, error: message },
      { status: message.includes("invalide") ? 400 : 404 },
    );
  }
}
