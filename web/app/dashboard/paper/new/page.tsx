import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Phase W.3: /dashboard/paper/new is now an alias for Strategy
 * Builder. The standalone NewPaperStrategyForm only knew the three
 * legacy preset types (threshold_entry / mean_reversion /
 * time_before_resolution); meanwhile Strategy Builder has supported
 * condition_based with the full parameter library + templates +
 * saved strategies + "Run as paper trade" CTA since Phase U.2.
 * Maintaining both was confusing — one entry point is clearer.
 *
 * Existing bookmarks land cleanly: the redirect carries a hint
 * via the query string that StrategyBuilder will use to surface the
 * "Run as paper trade" button as the primary action.
 */
export default function NewPaperRedirect() {
  redirect("/dashboard/strategy-builder?mode=paper");
}
