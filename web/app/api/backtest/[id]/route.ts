/**
 * GET /api/backtest/[id] — poll status / result of a submitted job.
 * Proxies to FastAPI GET /v1/backtest/{job_id}.
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
  return fastapiProxy(request, `/v1/backtest/${encodeURIComponent(id)}`);
}
