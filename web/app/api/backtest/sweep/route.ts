/**
 * POST /api/backtest/sweep — proxy to FastAPI POST /v1/backtest/sweep.
 *
 * Same shape as /api/backtest but the FastAPI side enqueues a `run_sweep_job`
 * instead of `run_backtest_job`. Result is fetched via the existing
 * GET /api/backtest/[id] poll (single state machine for both kinds — the
 * payload carries `kind: "sweep"` so the dashboard knows what to render).
 */
import { createClient } from "@/libs/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FASTAPI_BASE_URL =
  process.env.FASTAPI_BASE_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!INTERNAL_API_SECRET) {
    return NextResponse.json(
      { error: "Server misconfigured: INTERNAL_API_SECRET unset" },
      { status: 500 }
    );
  }

  const body = await request.text();
  try {
    const res = await fetch(`${FASTAPI_BASE_URL}/v1/backtest/sweep`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_API_SECRET,
        // Force fresh socket; same rationale as libs/fastapi.ts.
        Connection: "close",
      },
      body,
      cache: "no-store",
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "application/json",
      },
    });
  } catch (e: any) {
    console.error("[api/backtest/sweep POST]", e);
    return NextResponse.json(
      { error: "Upstream API unavailable" },
      { status: 502 }
    );
  }
}
