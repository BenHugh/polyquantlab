import Link from "next/link";
import ApiKeysClient from "@/components/ApiKeysClient";
import PageHeader from "@/components/PageHeader";
import { getSubscription, listApiKeys } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";

export const dynamic = "force-dynamic";

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

  let initialKeys: Awaited<ReturnType<typeof listApiKeys>> = [];
  let subscription: Awaited<ReturnType<typeof getSubscription>> | null = null;
  if (user?.email) {
    try {
      [initialKeys, subscription] = await Promise.all([
        listApiKeys(user.email),
        getSubscription(user.email),
      ]);
    } catch (e) {
      console.error("[api-keys page] FastAPI fetch failed:", e);
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title="API keys"
        subtitle="Mint, label and revoke the keys you use to call the REST API."
      />

      {upgraded === "1" && (
        <div className="alert alert-success mb-6">
          <span>
            Welcome aboard — your plan is active. Mint a key below to start
            hitting the API.
          </span>
        </div>
      )}

      {subscription && (
        <div className="rounded-xl border border-base-300 bg-base-200/50 p-4 text-sm space-y-1 mb-6">
          <div className="flex items-center gap-2">
            <span className="text-base-content/60">Plan</span>
            <span className="badge badge-primary">
              {subscription.tier_display}
            </span>
            {subscription.tier === "free" && (
              <Link className="link link-primary link-hover text-xs ml-auto" href="/#pricing">
                Upgrade →
              </Link>
            )}
          </div>
          <div className="text-base-content/60 text-xs">
            {subscription.limits.rps} req/sec · {subscription.limits.rpm}{" "}
            req/min · {subscription.limits.concurrent_backtests} concurrent
            backtests · up to {subscription.limits.max_market_limit} markets
            per backtest
          </div>
        </div>
      )}

      <ApiKeysClient initialKeys={initialKeys} />

      <details className="text-sm opacity-80 mt-8 rounded-xl border border-base-300 p-4 bg-base-200/40">
        <summary className="cursor-pointer font-medium">How to use your key</summary>
        <pre className="mt-3 rounded-lg bg-base-100 border border-base-300 p-3 overflow-x-auto text-xs font-mono">{`curl -H "Authorization: Bearer YOUR_KEY" \\
  https://api.polyquantlab.com/v1/markets/resolved?ticker=BTC&limit=5`}</pre>
        <p className="mt-3 text-base-content/60">
          Keys are sent as a Bearer token. You only see the plaintext value
          once at creation — we store a SHA-256 hash on the server.
        </p>
      </details>
    </div>
  );
}
