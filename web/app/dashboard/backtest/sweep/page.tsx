import PageHeader from "@/components/PageHeader";
import SweepForm from "@/components/SweepForm";
import { getSubscription } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";

export const dynamic = "force-dynamic";

export default async function SweepPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let maxMarketLimit = 200;
  let maxSweepCells = 2500;
  let tierDisplay = "Free";
  if (user?.email) {
    try {
      const sub = await getSubscription(user.email);
      maxMarketLimit = sub.limits.max_market_limit;
      tierDisplay = sub.tier_display;
      const limits = sub.limits as unknown as Record<string, number>;
      if (typeof limits.max_sweep_cells === "number") {
        maxSweepCells = limits.max_sweep_cells;
      }
    } catch (e) {
      console.error("[sweep page] subscription fetch failed:", e);
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        eyebrow="Strategy"
        title="Parameter sweep"
        subtitle={
          <>
            Run the same strategy across a grid of parameter values and
            visualise PnL / Sharpe as a heatmap. Stable plateaus indicate
            real signal; isolated spikes indicate overfitting.
            <br />
            <span className="text-base-content/50">
              {tierDisplay} tier · up to {maxMarketLimit} markets ·{" "}
              up to {maxSweepCells.toLocaleString()} sweep cells
            </span>
          </>
        }
      />
      <SweepForm
        maxMarketLimit={maxMarketLimit}
        maxSweepCells={maxSweepCells}
      />
    </div>
  );
}
