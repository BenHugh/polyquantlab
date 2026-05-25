import BacktestForm from "@/components/BacktestForm";
import PageHeader from "@/components/PageHeader";
import { getSubscription } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function BacktestPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let maxMarketLimit = 200;
  let tierDisplay = "Free";
  if (user?.email) {
    try {
      const sub = await getSubscription(user.email);
      maxMarketLimit = sub.limits.max_market_limit;
      tierDisplay = sub.tier_display;
    } catch (e) {
      console.error("[backtest page] subscription fetch failed:", e);
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        eyebrow="Strategy"
        title="New backtest"
        subtitle={
          <>
            {tierDisplay} tier · up to {maxMarketLimit} markets per backtest ·{" "}
            <Link
              href="/dashboard/backtest/sweep"
              className="link link-primary link-hover"
            >
              Or run a parameter sweep →
            </Link>
          </>
        }
      />
      <BacktestForm maxMarketLimit={maxMarketLimit} />
    </div>
  );
}
