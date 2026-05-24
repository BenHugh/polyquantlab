import BacktestForm from "@/components/BacktestForm";
import ButtonAccount from "@/components/ButtonAccount";
import { getSubscription } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /dashboard/backtest — strategy builder.
 *
 * We render the user's tier limits up front so they don't try to
 * configure a 200-market sweep on Free (which would 402 on submit).
 * The form itself is a client component — it handles dynamic strategy
 * params and submission/polling.
 */
export default async function BacktestPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/signin");

  // Best-effort fetch of the user's tier; if FastAPI is down we just
  // render the form with Premium-like defaults and let the server gate
  // reject on submit.
  let maxMarketLimit = 200;
  let tierDisplay = "Free";
  try {
    const sub = await getSubscription(user.email);
    maxMarketLimit = sub.limits.max_market_limit;
    tierDisplay = sub.tier_display;
  } catch (e) {
    console.error("[backtest page] subscription fetch failed:", e);
  }

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Link
              href="/dashboard"
              className="link link-hover text-sm"
            >
              ← Dashboard
            </Link>
            <h1 className="text-3xl md:text-4xl font-extrabold mt-1">
              New backtest
            </h1>
            <p className="text-sm opacity-70 mt-1">
              {tierDisplay} tier · up to {maxMarketLimit} markets per backtest
            </p>
          </div>
          <ButtonAccount />
        </div>

        <BacktestForm maxMarketLimit={maxMarketLimit} />
      </section>
    </main>
  );
}
