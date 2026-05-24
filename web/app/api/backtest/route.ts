/**
 * POST /api/backtest — submit a backtest job.
 *
 * Forwards the JSON body to FastAPI POST /v1/backtest (async mode by
 * default; the dashboard polls /api/backtest/[id] afterwards). The
 * internal-secret bypass on the FastAPI side means we skip the tier
 * gate, but we want the per-user tier check to still apply — so we
 * could read the user's tier from Supabase here. For Phase E2 we keep
 * it simple and trust the FastAPI gate fires for API-key callers and
 * elide it for dashboard users (effectively giving dashboard users
 * Premium-tier limits regardless of their subscription).
 *
 * TODO(phase F): lookup subscription tier and forward the user's actual
 * tier limits so the dashboard mirrors the API-key gate exactly.
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
    const res = await fetch(`${FASTAPI_BASE_URL}/v1/backtest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_API_SECRET,
      },
      body,
      cache: "no-store",
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        "Content-Type":
          res.headers.get("Content-Type") || "application/json",
      },
    });
  } catch (e: any) {
    console.error("[api/backtest POST]", e);
    return NextResponse.json(
      { error: "Upstream API unavailable" },
      { status: 502 }
    );
  }
}
