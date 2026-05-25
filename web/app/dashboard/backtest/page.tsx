import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /dashboard/backtest is now an alias for /dashboard/strategy-builder
 * after Phase R merged the two flows. The detail pages
 * (/dashboard/backtest/[id], /dashboard/backtest/sweep) still live
 * here — only the index page redirects.
 *
 * Kept as a route rather than a 404 so any saved bookmark / external
 * link to /dashboard/backtest lands somewhere useful.
 */
export default function BacktestRedirect() {
  redirect("/dashboard/strategy-builder");
}
