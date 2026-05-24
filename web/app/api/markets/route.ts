/**
 * GET /api/markets — proxies to FastAPI /v1/markets/resolved.
 *
 * The browser dashboard talks to this same-origin route; we forward to
 * FastAPI using the internal-secret so the user doesn't need to mint a
 * key just to browse. Supported query params are passed through (FastAPI
 * validates them): event_type, ticker, since, until, limit.
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
  return fastapiProxy(request, "/v1/markets/resolved");
}
