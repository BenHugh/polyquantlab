import ButtonAccount from "@/components/ButtonAccount";
import MarketsTable, { type ResolvedMarket } from "@/components/MarketsTable";
import { fastapiGet } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface ResolvedMarketsResponse {
  markets: ResolvedMarket[];
  count: number;
}

/**
 * /dashboard/markets — list of resolved BTC/ETH/SOL Up/Down markets.
 *
 * Initial paint is server-rendered from FastAPI. Client-side, the user
 * can filter by ticker (BTC/ETH/SOL) and re-fetch through our /api/markets
 * proxy. We fetch up to 200 most-recent resolved markets — the UI gives a
 * "load more" button for deeper history (not yet wired).
 */
export default async function MarketsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  let markets: ResolvedMarket[] = [];
  let fetchError: string | null = null;
  try {
    const data = await fastapiGet<ResolvedMarketsResponse>(
      "/v1/markets/resolved?limit=200"
    );
    markets = data.markets ?? [];
  } catch (e: any) {
    fetchError = e?.message || "Failed to load markets";
    console.error("[markets page]", e);
  }

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-extrabold">Markets</h1>
            <p className="text-sm opacity-70 mt-1">
              Resolved Polymarket crypto Up/Down markets. Click a row to
              inspect the orderbook + price history.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="btn btn-ghost btn-sm"
            >
              ← Dashboard
            </Link>
            <ButtonAccount />
          </div>
        </div>

        {fetchError ? (
          <div className="alert alert-error">
            <span>{fetchError}</span>
          </div>
        ) : (
          <MarketsTable initial={markets} />
        )}
      </section>
    </main>
  );
}
