/**
 * GET /api/polymarket/live-board — currently-trading market per timeframe
 * for the Live Terminal page. Proxies FastAPI /v1/polymarket/live-board.
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
  return fastapiProxy(request, "/v1/polymarket/live-board");
}
