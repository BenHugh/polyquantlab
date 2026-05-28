/**
 * GET /api/arb/audit — calibration aggregate for the Verification page.
 * Proxies FastAPI /v1/arb/audit/aggregate. Honest read-only view of
 * model_ev vs realised_pnl across all logged detections.
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
  return fastapiProxy(request, "/v1/arb/audit/aggregate");
}
