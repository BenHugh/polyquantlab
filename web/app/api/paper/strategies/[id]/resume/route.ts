/** PATCH /api/paper/strategies/[id]/resume — resume a paused strategy. */
import { fastapiProxy } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  return fastapiProxy(
    request,
    `/v1/paper/strategies/${encodeURIComponent(id)}/resume`,
    { method: "PATCH", userEmail: user.email }
  );
}
