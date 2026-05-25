import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * Dashboard home — an overview grid of the product's surfaces.
 *
 * Each card is a route, with a one-line description aimed at "what
 * problem does this solve". Visual language: hairline borders, generous
 * padding, subtle hover lift. No icons — the layout shell already shows
 * them in the sidebar; repeating here would feel cluttered.
 */
export default function Dashboard() {
  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <header>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          Welcome back
        </h1>
        <p className="text-base-content/60 mt-2">
          Polymarket research workbench — sub-second orderbook data,
          backtests, sweeps, paper trading.
        </p>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card
          href="/dashboard/markets"
          title="Markets"
          desc="Browse resolved BTC / ETH / SOL Up/Down markets with full orderbook history and underlying-price overlay."
        />
        <Card
          href="/dashboard/backtest"
          title="Backtest"
          desc="Run a strategy against historical orderbook depth. Realistic walk-the-book execution, Polymarket fees, real PnL."
        />
        <Card
          href="/dashboard/backtest/sweep"
          title="Parameter sweep"
          desc="Run the same strategy across a 2D grid of parameter values. Find robust plateaus instead of overfitted spikes."
        />
        <Card
          href="/dashboard/stats/calibration"
          title="Calibration"
          desc="Is Polymarket well-calibrated? Implied vs realised Up rates per ticker / window — the data Polymarket itself doesn't publish."
          accent
        />
        <Card
          href="/dashboard/paper"
          title="Paper trading"
          desc="Save a strategy. We run it on every new snapshot. Real-time virtual fills, virtual P&L, no real money."
        />
        <Card
          href="/dashboard/api-keys"
          title="API keys"
          desc="Mint, label and revoke keys for programmatic access. Same data the dashboard uses."
        />
      </section>

      <section className="mt-10 rounded-xl border border-base-300 bg-base-200/50 p-6">
        <h2 className="text-lg font-semibold mb-2">Quick start</h2>
        <ol className="space-y-1.5 text-sm text-base-content/80 list-decimal list-inside">
          <li>
            Open <Link href="/dashboard/stats/calibration" className="link link-primary link-hover">Calibration</Link>{" "}
            to find buckets where Polymarket is systematically mispricing.
          </li>
          <li>
            Build a strategy on <Link href="/dashboard/backtest" className="link link-primary link-hover">Backtest</Link>{" "}
            that targets that bucket. Check the Equity curve.
          </li>
          <li>
            Validate robustness with a{" "}
            <Link href="/dashboard/backtest/sweep" className="link link-primary link-hover">parameter sweep</Link>{" "}
            — look for a flat plateau, not an isolated spike.
          </li>
          <li>
            Send the surviving strategy to{" "}
            <Link href="/dashboard/paper" className="link link-primary link-hover">Paper trading</Link>{" "}
            and watch real-time performance for 1-4 weeks before deploying capital.
          </li>
        </ol>
      </section>
    </div>
  );
}

function Card({
  href,
  title,
  desc,
  accent,
}: {
  href: string;
  title: string;
  desc: string;
  accent?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`hover-card-lift block rounded-xl border p-5 bg-base-200/40 ${
        accent ? "border-primary/30" : "border-base-300"
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold tracking-tight">{title}</h3>
        <span className="text-base-content/40 group-hover:text-primary transition-colors">
          →
        </span>
      </div>
      <p className="text-sm text-base-content/60 leading-relaxed">{desc}</p>
    </Link>
  );
}
