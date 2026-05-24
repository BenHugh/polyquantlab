/**
 * GET /api/candles — Binance aggTrade OHLC, proxied to FastAPI /v1/candles.
 *
 * Query params (forwarded verbatim): ticker, interval (5m/15m/1h/4h/24h),
 * start, end, limit.
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
  return fastapiProxy(request, "/v1/candles");
}
