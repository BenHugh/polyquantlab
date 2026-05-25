/**
 * GET /api/polymarket/recent-trades — last N Polymarket trades for a ticker.
 * Proxies FastAPI /v1/polymarket/recent-trades.
 */
import { fastapiProxy } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return fastapiProxy(request, "/v1/polymarket/recent-trades");
}
