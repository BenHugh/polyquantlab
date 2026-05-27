/**
 * GET /api/arb — live Polymarket × Binance mispricing scanner.
 *
 * Proxies FastAPI /v1/arb/live with auth. The client (ArbDashboard
 * component) polls this every ~3-5 s to refresh the opportunity list.
 *
 * Query params pass through verbatim: min_edge_pp, vol_window_sec,
 * tickers, event_types, limit. See backtest/arb_engine.py for what
 * each tunable does.
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
  return fastapiProxy(request, "/v1/arb/live");
}
