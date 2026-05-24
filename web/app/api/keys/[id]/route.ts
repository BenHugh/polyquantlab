/**
 * DELETE /api/keys/[id] — soft-revoke an API key for the current user.
 *
 * The FastAPI side scopes the delete by (email, api_key_id) so a user
 * can't revoke someone else's key even if they guess the ID.
 */
import { revokeApiKey } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await revokeApiKey(user.email, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[api/keys/:id DELETE]", e);
    return NextResponse.json(
      { error: "Failed to revoke key" },
      { status: 502 }
    );
  }
}
