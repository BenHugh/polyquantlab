/**
 * GET /api/markets/[id]/orderbook — latest (or point-in-time) snapshot.
 * Proxies to FastAPI /v1/markets/{market_id}/orderbook[?at=ts].
 */
import { fastapiProxy } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  return fastapiProxy(
    request,
    `/v1/markets/${encodeURIComponent(id)}/orderbook`
  );
}
