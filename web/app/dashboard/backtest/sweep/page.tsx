import ButtonAccount from "@/components/ButtonAccount";
import SweepForm from "@/components/SweepForm";
import { getSubscription } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /dashboard/backtest/sweep — submit a parameter sweep.
 *
 * Like /dashboard/backtest but the user picks 1 or 2 strategy params
 * to vary across a grid. Submission returns a job_id; the heatmap
 * results page polls /api/backtest/[id] for completion just like
 * single backtests do (the result payload carries kind:"sweep" so the
 * results page knows to render a heatmap instead of an equity curve).
 */
export default async function SweepPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/signin");

  let maxMarketLimit = 200;
  let maxSweepCells = 2500;
  let tierDisplay = "Free";
  try {
    const sub = await getSubscription(user.email);
    maxMarketLimit = sub.limits.max_market_limit;
    tierDisplay = sub.tier_display;
    // max_sweep_cells is included in tier limits but not yet typed on
    // the frontend SubscriptionView. Read defensively.
    const limits = sub.limits as unknown as Record<string, number>;
    if (typeof limits.max_sweep_cells === "number") {
      maxSweepCells = limits.max_sweep_cells;
    }
  } catch (e) {
    console.error("[sweep page] subscription fetch failed:", e);
  }

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Link href="/dashboard/backtest" className="link link-hover text-sm">
              ← Single backtest
            </Link>
            <h1 className="text-3xl md:text-4xl font-extrabold mt-1">
              Parameter sweep
            </h1>
            <p className="text-sm opacity-70 mt-1 max-w-2xl">
              Run the same strategy across a grid of parameter values
              and visualise PnL / Sharpe as a heatmap. Stable plateaus
              in the grid indicate real signal; isolated spikes indicate
              overfitting.
            </p>
            <p className="text-xs opacity-60 mt-2">
              {tierDisplay} tier · up to {maxMarketLimit} markets ·{" "}
              up to {maxSweepCells.toLocaleString()} sweep cells
            </p>
          </div>
          <ButtonAccount />
        </div>

        <SweepForm
          maxMarketLimit={maxMarketLimit}
          maxSweepCells={maxSweepCells}
        />
      </section>
    </main>
  );
}
