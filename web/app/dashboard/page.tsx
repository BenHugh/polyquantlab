import ButtonAccount from "@/components/ButtonAccount";
import Link from "next/link";

export const dynamic = "force-dynamic";

// This is a private page: It's protected by the layout.js component which ensures the user is authenticated.
// It's a server compoment which means you can fetch data (like the user profile) before the page is rendered.
// See https://shipfa.st/docs/tutorials/private-page
export default async function Dashboard() {
  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl md:text-4xl font-extrabold">Dashboard</h1>
          <ButtonAccount />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Link
            href="/dashboard/api-keys"
            className="rounded-lg border border-base-300 p-4 hover:bg-base-200 transition"
          >
            <div className="font-semibold">API keys</div>
            <p className="text-sm opacity-70 mt-1">
              Mint, label and revoke the keys you use to call the REST API.
            </p>
          </Link>

          <Link
            href="/dashboard/markets"
            className="rounded-lg border border-base-300 p-4 hover:bg-base-200 transition"
          >
            <div className="font-semibold">Markets</div>
            <p className="text-sm opacity-70 mt-1">
              Browse resolved BTC / ETH / SOL Up/Down markets with full
              orderbook history.
            </p>
          </Link>

          <Link
            href="/dashboard/backtest"
            className="rounded-lg border border-base-300 p-4 hover:bg-base-200 transition"
          >
            <div className="font-semibold">Backtests</div>
            <p className="text-sm opacity-70 mt-1">
              Build and run a strategy against historical orderbook data.
            </p>
          </Link>

          <Link
            href="/dashboard/stats/calibration"
            className="rounded-lg border border-base-300 p-4 hover:bg-base-200 transition sm:col-span-2"
          >
            <div className="font-semibold">Market calibration</div>
            <p className="text-sm opacity-70 mt-1">
              Is Polymarket well-calibrated? Implied vs realised Up rates,
              per ticker and per window — the data Polymarket itself
              doesn&apos;t publish.
            </p>
          </Link>
        </div>
      </section>
    </main>
  );
}
