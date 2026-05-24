import ButtonAccount from "@/components/ButtonAccount";
import ApiKeysClient from "@/components/ApiKeysClient";
import { getSubscription, listApiKeys } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * API-key dashboard.
 *
 * Server-rendered first paint: we already have the Supabase user from
 * the parent dashboard layout, so we can pull the user's tier + key
 * list straight from FastAPI before sending HTML to the browser. The
 * interactive bits (create / revoke / copy-once) live in the client
 * component.
 *
 * Errors from FastAPI are treated as "no data yet" rather than 500ing
 * the page — a stale FastAPI shouldn't take down the dashboard.
 */
export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ upgraded?: string }>;
}) {
  const { upgraded } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    redirect("/signin");
  }

  let initialKeys: Awaited<ReturnType<typeof listApiKeys>> = [];
  let subscription: Awaited<ReturnType<typeof getSubscription>> | null = null;
  try {
    [initialKeys, subscription] = await Promise.all([
      listApiKeys(user.email),
      getSubscription(user.email),
    ]);
  } catch (e) {
    console.error("[api-keys page] FastAPI fetch failed:", e);
  }

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-3xl mx-auto space-y-8">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-3xl md:text-4xl font-extrabold">API Keys</h1>
          <ButtonAccount />
        </div>

        {upgraded === "1" && (
          <div className="alert alert-success">
            <span>
              Welcome aboard — your plan is active. Mint a key below to
              start hitting the API.
            </span>
          </div>
        )}

        {subscription && (
          <div className="rounded-lg border border-base-300 bg-base-200 p-4 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold">Plan:</span>
              <span className="badge badge-primary">
                {subscription.tier_display}
              </span>
              {subscription.tier === "free" && (
                <a className="link link-hover text-xs" href="/#pricing">
                  Upgrade →
                </a>
              )}
            </div>
            <div className="opacity-70">
              {subscription.limits.rps} req/sec · {subscription.limits.rpm}{" "}
              req/min · {subscription.limits.concurrent_backtests} concurrent
              backtests · up to {subscription.limits.max_market_limit} markets
              per backtest
            </div>
          </div>
        )}

        <ApiKeysClient initialKeys={initialKeys} />

        <details className="text-sm opacity-80">
          <summary className="cursor-pointer">How to use your key</summary>
          <pre className="mt-2 rounded bg-base-300 p-3 overflow-x-auto">{`curl -H "Authorization: Bearer YOUR_KEY" \\
  https://api.polyquantlab.com/v1/markets/resolved?ticker=BTC&limit=5`}</pre>
          <p className="mt-2">
            Keys are sent as a Bearer token. You only see the plaintext value
            once at creation — we store a SHA-256 hash on the server.
          </p>
        </details>
      </section>
    </main>
  );
}
