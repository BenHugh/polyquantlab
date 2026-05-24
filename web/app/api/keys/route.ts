/**
 * Dashboard API-key management proxy.
 *
 * The browser dashboard talks to THIS route (same-origin, Supabase
 * session cookie), which then forwards to FastAPI's internal endpoints
 * using the X-Internal-Secret. We never let the browser hit FastAPI's
 * internal namespace directly — the shared secret must stay server-side.
 *
 * Auth: the Supabase session identifies the user. We pull `email` off
 * the session and use it as the key for FastAPI's user table.
 *
 *   GET  /api/keys           — list this user's keys
 *   POST /api/keys {label?}  — mint a new key (plaintext returned ONCE)
 *
 * Single-key delete lives at /api/keys/[id] (DELETE).
 */
import { createApiKey, listApiKeys } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function requireUserEmail(): Promise<string | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return user.email;
}

export async function GET() {
  const emailOrErr = await requireUserEmail();
  if (typeof emailOrErr !== "string") return emailOrErr;
  try {
    const keys = await listApiKeys(emailOrErr);
    return NextResponse.json({ keys });
  } catch (e: any) {
    console.error("[api/keys GET]", e);
    return NextResponse.json(
      { error: "Failed to fetch keys" },
      { status: 502 }
    );
  }
}

export async function POST(req: NextRequest) {
  const emailOrErr = await requireUserEmail();
  if (typeof emailOrErr !== "string") return emailOrErr;
  let label: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    label =
      typeof body?.label === "string" && body.label.trim().length > 0
        ? body.label.trim().slice(0, 128)
        : undefined;
  } catch {
    // empty body is fine — FastAPI will default the label
  }
  try {
    const created = await createApiKey(emailOrErr, label);
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[api/keys POST]", e);
    return NextResponse.json(
      { error: "Failed to create key" },
      { status: 502 }
    );
  }
}
