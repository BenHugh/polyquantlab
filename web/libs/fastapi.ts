/**
 * Server-side bridge to our FastAPI backend.
 *
 * The Next.js process and FastAPI talk over a shared-secret HTTP channel
 * (`X-Internal-Secret` header). These helpers wrap that contract so the
 * webhook + dashboard routes don't repeat fetch boilerplate.
 *
 * Important: ALL functions here MUST run on the server only. Never import
 * this file from a "use client" component — `INTERNAL_API_SECRET` and
 * `FASTAPI_BASE_URL` are not (and must not be) exposed to the browser.
 * (We'd normally add `import "server-only"` here as a build-time guard,
 * but ship-fast doesn't depend on it; route handlers + server components
 * are the only callers.)
 */

const FASTAPI_BASE_URL = process.env.FASTAPI_BASE_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

export type TierKey = "free" | "pro" | "plus" | "boost" | "premium";

export type SubscriptionStatus = "active" | "canceled" | "past_due";

export interface SyncSubscriptionPayload {
  email: string;
  tier: TierKey;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  status?: SubscriptionStatus;
  /** ISO-8601 timestamp; FastAPI parses via pydantic datetime */
  current_period_end?: string | null;
}

async function internalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!INTERNAL_API_SECRET) {
    throw new Error(
      "INTERNAL_API_SECRET is not configured — refusing to bridge to FastAPI."
    );
  }
  const url = `${FASTAPI_BASE_URL.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Secret": INTERNAL_API_SECRET,
    // Force a fresh TCP socket for every internal request. Otherwise
    // Node's `undici` pool reuses sockets that uvicorn may have already
    // closed on its end (default keep-alive timeout ~5s), giving us
    // ECONNRESET / UND_ERR_SOCKET "other side closed" mid-response.
    // Internal calls are low-volume + LAN-local, so the perf cost is
    // negligible.
    Connection: "close",
    ...((init.headers as Record<string, string>) || {}),
  };

  // Retry once on transient socket errors. undici sometimes hands back a
  // pooled socket that the server has just closed; the retry gets a
  // fresh connection. Anything other than a socket error is re-thrown.
  const SOCKET_ERROR_CODES = new Set([
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
  ]);
  const doFetch = () => fetch(url, { ...init, headers, cache: "no-store" });

  try {
    return await doFetch();
  } catch (err: unknown) {
    const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code
      || (err as { code?: string })?.code;
    if (code && SOCKET_ERROR_CODES.has(code)) {
      // Small backoff to let any half-open state settle.
      await new Promise((r) => setTimeout(r, 50));
      return doFetch();
    }
    throw err;
  }
}

/**
 * Upsert the user's tier + subscription on the FastAPI side. Called from
 * the Stripe webhook handler. Logs and swallows non-2xx errors so a
 * transient FastAPI outage doesn't poison the Stripe retry queue — Stripe
 * will already have retried the webhook itself if we return 500, and the
 * Supabase profile is the source of truth for "has_access" anyway.
 */
export async function syncSubscriptionToFastAPI(
  payload: SyncSubscriptionPayload
): Promise<void> {
  try {
    const res = await internalFetch("/v1/internal/sync-subscription", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[fastapi-bridge] sync-subscription failed: ${res.status} ${text}`
      );
    }
  } catch (e) {
    // Network error reaching FastAPI — don't crash the webhook handler.
    console.error("[fastapi-bridge] sync-subscription network error:", e);
  }
}

// ---------------------------------------------------------------------------
// API-key management (called from authenticated dashboard routes)
// ---------------------------------------------------------------------------

export interface ApiKeyRow {
  api_key_id: string;
  key_prefix: string;
  label: string | null;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function listApiKeys(email: string): Promise<ApiKeyRow[]> {
  const res = await internalFetch(
    `/v1/internal/users/${encodeURIComponent(email)}/keys`
  );
  if (!res.ok) {
    throw new Error(`listApiKeys failed: ${res.status}`);
  }
  const body = await res.json();
  return body.keys ?? [];
}

export async function createApiKey(
  email: string,
  label?: string
): Promise<{ api_key_id: string; key: string; key_prefix: string }> {
  const res = await internalFetch(
    `/v1/internal/users/${encodeURIComponent(email)}/keys`,
    {
      method: "POST",
      body: JSON.stringify({ label: label || "dashboard-created" }),
    }
  );
  if (!res.ok) {
    throw new Error(`createApiKey failed: ${res.status}`);
  }
  return res.json();
}

export async function revokeApiKey(
  email: string,
  apiKeyId: string
): Promise<void> {
  const res = await internalFetch(
    `/v1/internal/users/${encodeURIComponent(email)}/keys/${apiKeyId}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    throw new Error(`revokeApiKey failed: ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Generic data passthrough — used by the dashboard browse/backtest pages
// to fetch from FastAPI's public /v1/* endpoints on behalf of the
// Supabase-authenticated user. We send the internal secret which the
// FastAPI auth dependency treats as an "elevated" session that bypasses
// per-key rate limits (the Next.js side is already gating the user).
// ---------------------------------------------------------------------------

export async function fastapiGet<T = unknown>(
  pathWithQuery: string
): Promise<T> {
  const res = await internalFetch(pathWithQuery);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`fastapiGet ${pathWithQuery} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Forward an incoming Next.js request to a FastAPI path, preserving the
 *  query string. Used by `/api/markets/*` proxy routes — keeps them as
 *  thin one-liners.
 *
 *  If the caller has a Supabase session, pass the user's email as the
 *  optional `userEmail` argument and we forward it as X-User-Email so
 *  endpoints that need user identity (paper trading) can see it. The
 *  FastAPI side trusts this header because the only way to reach it is
 *  via the internal-secret-authenticated proxy.
 */
export async function fastapiProxy(
  request: Request,
  fastapiPath: string,
  opts?: { method?: string; userEmail?: string }
): Promise<Response> {
  // Forward the inbound URL's query string verbatim.
  const incoming = new URL(request.url);
  const target = fastapiPath + incoming.search;
  // For non-GET requests, forward the body. (GETs ignore body anyway.)
  const method = opts?.method || request.method;
  const isBodyMethod = method !== "GET" && method !== "HEAD";
  const body = isBodyMethod ? await request.text() : undefined;
  const extraHeaders: Record<string, string> = {};
  if (opts?.userEmail) extraHeaders["X-User-Email"] = opts.userEmail;
  try {
    const res = await internalFetch(target, {
      method,
      ...(body !== undefined ? { body } : {}),
      headers: extraHeaders,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "application/json",
      },
    });
  } catch (e: any) {
    console.error(`[fastapi-bridge] proxy ${target} failed:`, e);
    return new Response(
      JSON.stringify({ error: "Upstream API unavailable" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}

export interface SubscriptionView {
  email: string;
  tier: TierKey;
  tier_display: string;
  status: string;
  current_period_end?: string | null;
  limits: {
    rps: number;
    rpm: number;
    concurrent_backtests: number;
    max_market_limit: number;
    history_days: number;
    monthly_price_usd: number;
  };
}

export async function getSubscription(email: string): Promise<SubscriptionView> {
  const res = await internalFetch(
    `/v1/internal/users/${encodeURIComponent(email)}/subscription`
  );
  if (!res.ok) {
    throw new Error(`getSubscription failed: ${res.status}`);
  }
  return res.json();
}
