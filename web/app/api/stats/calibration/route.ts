/**
 * GET /api/stats/calibration — proxies to FastAPI /v1/stats/calibration.
 * Same auth pattern as the other dashboard proxies.
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
  return fastapiProxy(request, "/v1/stats/calibration");
}
