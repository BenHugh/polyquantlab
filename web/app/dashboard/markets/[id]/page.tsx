import ButtonAccount from "@/components/ButtonAccount";
import MarketDetail, {
  type MarketMeta,
  type OrderbookSnapshot,
  type TimeseriesPayload,
} from "@/components/MarketDetail";
import { fastapiGet } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /dashboard/markets/[id] — single market detail.
 *
 * Server-side we fan-out three FastAPI requests in parallel:
 *   1. metadata (winner, volume, liquidity, slug…)
 *   2. latest orderbook snapshot (Up + Down sides)
 *   3. price timeseries (last 500 points)
 *
 * Any of these can fail independently — we render best-effort with
 * placeholders so a sparse market (e.g. recent + no resolved data yet)
 * still shows something useful.
 */
export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const [metaR, bookR, tsR] = await Promise.allSettled([
    fastapiGet<MarketMeta>(`/v1/markets/${encodeURIComponent(id)}`),
    fastapiGet<OrderbookSnapshot>(
      `/v1/markets/${encodeURIComponent(id)}/orderbook`
    ),
    fastapiGet<TimeseriesPayload>(
      `/v1/markets/${encodeURIComponent(id)}/timeseries?limit=500`
    ),
  ]);

  const meta = metaR.status === "fulfilled" ? metaR.value : null;
  const book = bookR.status === "fulfilled" ? bookR.value : null;
  const series = tsR.status === "fulfilled" ? tsR.value : null;

  if (!meta) {
    return (
      <main className="min-h-screen p-8">
        <section className="max-w-3xl mx-auto space-y-4">
          <Link href="/dashboard/markets" className="btn btn-ghost btn-sm">
            ← Back to markets
          </Link>
          <div className="alert alert-error">
            <span>
              Market <code>{id}</code> not found or upstream API unavailable.
            </span>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Link href="/dashboard/markets" className="link link-hover text-sm">
              ← Markets
            </Link>
            <h1 className="text-2xl md:text-3xl font-extrabold mt-1">
              {meta.slug || "Untitled market"}
            </h1>
            <p className="font-mono text-xs opacity-60 mt-1">{meta.market_id}</p>
          </div>
          <ButtonAccount />
        </div>

        <MarketDetail meta={meta} book={book} series={series} />
      </section>
    </main>
  );
}
