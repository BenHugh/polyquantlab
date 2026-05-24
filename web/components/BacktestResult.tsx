"use client";

import ExportButtons from "@/components/ExportButtons";
import { formatDateTime } from "@/libs/formatDate";
import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Poll FastAPI's job_store via /api/backtest/[id] until terminal.
 *
 * Status flow: queued → running → completed | failed.
 * We poll every 1.2s; typical jobs complete in 2-15s. We give up after
 * 90s of polling and show a "still running, refresh later" notice — the
 * job continues server-side and the user can revisit the URL.
 */

interface Trade {
  ts: string;
  market_id: string;
  side: string;
  price: number;
  size: number;
  slippage_bps: number;
  // Per-trade fields populated by the engine after settlement (Phase H1).
  // `pnl` may be null for very old result rows; we render those as
  // "pending" instead of zero so users don't conflate "no PnL data" with
  // "PnL was exactly zero".
  pnl?: number | null;
  fees?: number;
  resolution_yes_price?: number | null;
  // Underlying spot price (BTC/ETH/SOL) at the moment of fill. Lets the
  // user see "what was BTC doing when this trade fired?" without
  // jumping back to the market detail page. Populated by the engine
  // since Phase J.
  underlying_price?: number | null;
}

interface BacktestResultBody {
  trades: Trade[];
  total_pnl: number;
  total_fees: number;
  win_rate: number;
  sharpe: number | null;
  max_drawdown: number;
  n_markets: number;
  n_trades: number;
}

interface JobRecord {
  job_id: string;
  api_key_id: string;
  status: "queued" | "running" | "completed" | "failed";
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  params: Record<string, unknown>;
  result: BacktestResultBody | null;
  error: string | null;
}

const POLL_MS = 1200;
// 6 min: backend ARQ job_timeout is 300s (5 min); we give an extra minute
// of buffer so a slow-but-still-running job doesn't get the "stuck"
// banner before the worker has had a chance to mark it timed-out.
const GIVE_UP_MS = 360_000;

export default function BacktestResult({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const start = Date.now();

    async function poll() {
      try {
        const res = await fetch(`/api/backtest/${encodeURIComponent(jobId)}`, {
          cache: "no-store",
        });
        if (res.status === 404) {
          if (!cancelled) setError("Job not found (it may have expired).");
          return;
        }
        if (!res.ok) {
          if (!cancelled) setError(`Failed to fetch job (${res.status})`);
          return;
        }
        const body: JobRecord = await res.json();
        if (cancelled) return;
        setJob(body);
        if (body.status === "completed" || body.status === "failed") return;
        if (Date.now() - start > GIVE_UP_MS) {
          setGaveUp(true);
          return;
        }
        timer = setTimeout(poll, POLL_MS);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Network error");
      }
    }
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  if (error) {
    return (
      <div className="alert alert-error">
        <span>{error}</span>
      </div>
    );
  }

  if (!job) {
    return <div className="opacity-70">Loading job…</div>;
  }

  return (
    <div className="space-y-6">
      <StatusBanner job={job} gaveUp={gaveUp} />
      {job.status === "completed" && job.result && (
        <ResultView result={job.result} params={job.params} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status banner
// ---------------------------------------------------------------------------

function StatusBanner({ job, gaveUp }: { job: JobRecord; gaveUp: boolean }) {
  if (job.status === "completed") {
    const elapsed =
      job.completed_at && job.started_at
        ? (new Date(job.completed_at).getTime() -
            new Date(job.started_at).getTime()) /
          1000
        : null;
    return (
      <div className="alert alert-success">
        <span>
          Completed{elapsed != null ? ` in ${elapsed.toFixed(1)}s` : ""}.
        </span>
      </div>
    );
  }

  if (job.status === "failed") {
    return (
      <div className="alert alert-error flex-col items-start gap-2">
        <span className="font-semibold">Backtest failed</span>
        <pre className="text-xs whitespace-pre-wrap">{job.error || "(no detail)"}</pre>
        <Link href="/dashboard/backtest" className="btn btn-sm btn-outline">
          Try again
        </Link>
      </div>
    );
  }

  // queued or running
  return (
    <div className="alert">
      <span className="loading loading-spinner loading-sm" />
      <span>
        {job.status === "queued" ? "Queued — waiting for a worker…" : "Running…"}
        {gaveUp &&
          " (this job is taking longer than usual; the page will keep the result available — refresh to retry)"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result view: stats + sparkline + trade table
// ---------------------------------------------------------------------------

function ResultView({
  result,
  params,
}: {
  result: BacktestResultBody;
  params: Record<string, unknown>;
}) {
  return (
    <div className="space-y-6">
      <StatsGrid result={result} />
      <PnLChart trades={result.trades} />
      <TradesTable trades={result.trades} />
      <ParamsCard params={params} />
    </div>
  );
}

function StatsGrid({ result }: { result: BacktestResultBody }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat
        label="Total PnL"
        value={`$${result.total_pnl.toFixed(2)}`}
        accent={result.total_pnl >= 0 ? "success" : "error"}
      />
      <Stat label="Fees" value={`$${result.total_fees.toFixed(2)}`} />
      <Stat
        label="Win rate"
        value={`${(result.win_rate * 100).toFixed(1)}%`}
      />
      <Stat
        label="Sharpe"
        value={result.sharpe != null ? result.sharpe.toFixed(2) : "—"}
      />
      <Stat
        label="Max drawdown"
        value={`$${result.max_drawdown.toFixed(2)}`}
        accent={result.max_drawdown > 0 ? "error" : undefined}
      />
      <Stat label="Markets" value={result.n_markets.toString()} />
      <Stat label="Trades" value={result.n_trades.toString()} />
      <Stat
        label="PnL / trade"
        value={
          result.n_trades > 0
            ? `$${(result.total_pnl / result.n_trades).toFixed(2)}`
            : "—"
        }
      />
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "success" | "error";
}) {
  const color =
    accent === "success"
      ? "text-success"
      : accent === "error"
      ? "text-error"
      : "";
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-3">
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className={`font-semibold mt-1 ${color}`}>{value}</div>
    </div>
  );
}

// Real cumulative P&L curve. Each trade now carries its realised P&L
// (computed by the engine at settlement; see backtest/engine.py
// _settle_trade_pnl). We sum trades in time-order and draw the equity
// curve — what quants actually want to see when judging a strategy.
//
// Net = gross P&L − fees per trade.
function PnLChart({ trades }: { trades: Trade[] }) {
  if (trades.length < 2) {
    return (
      <div className="rounded-lg border border-base-300 bg-base-100 p-4 text-sm opacity-60 text-center py-8">
        Not enough trades for a chart.
      </div>
    );
  }

  // Sort by timestamp just in case the engine returned per-market batches.
  const sorted = [...trades].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );

  // Detect whether the result actually has per-trade pnl populated. Old
  // results (pre-Phase H1) won't, in which case we fall back to the
  // exposure chart so we don't render nonsense.
  const hasPnl = sorted.some((t) => typeof t.pnl === "number");

  let acc = 0;
  const cum = sorted.map((t) => {
    if (hasPnl) {
      const gross = typeof t.pnl === "number" ? t.pnl : 0;
      const fees = typeof t.fees === "number" ? t.fees : 0;
      acc += gross - fees;
    } else {
      const signed = t.side.toLowerCase().includes("yes") ? t.size : -t.size;
      acc += signed;
    }
    return acc;
  });

  const width = 700;
  const height = 140;
  const lo = Math.min(...cum, 0);
  const hi = Math.max(...cum, 0);
  const range = Math.max(hi - lo, 1e-9);
  const step = width / (cum.length - 1);
  const yZero = height - ((0 - lo) / range) * height;

  // Build path. Also build a fill polygon between the curve and the zero
  // line so the equity area is visually obvious.
  const path = cum
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - lo) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Filled polygon (only used when we have real PnL)
  const fillPath =
    hasPnl && cum.length >= 2
      ? `${path} L${(cum.length - 1) * step},${yZero} L0,${yZero} Z`
      : null;

  const finalValue = cum[cum.length - 1];
  const finalGood = finalValue >= 0;

  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-4 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold">
          {hasPnl ? "Equity curve (net P&L)" : "Cumulative exposure"}
        </h3>
        {hasPnl && (
          <span
            className={`font-mono text-sm ${
              finalGood ? "text-success" : "text-error"
            }`}
          >
            {finalGood ? "+" : ""}${finalValue.toFixed(2)}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-36"
        preserveAspectRatio="none"
      >
        {fillPath && (
          <path
            d={fillPath}
            fill={finalGood ? "oklch(70% 0.15 150)" : "oklch(65% 0.18 25)"}
            fillOpacity={0.15}
          />
        )}
        <line
          x1={0}
          x2={width}
          y1={yZero}
          y2={yZero}
          stroke="currentColor"
          strokeOpacity={0.3}
          strokeDasharray="4 4"
        />
        <path
          d={path}
          fill="none"
          stroke={
            hasPnl
              ? finalGood
                ? "oklch(60% 0.18 150)"
                : "oklch(55% 0.2 25)"
              : "oklch(60% 0.2 250)"
          }
          strokeWidth={1.75}
        />
      </svg>
      <p className="text-xs opacity-60">
        {hasPnl
          ? "Net realised P&L (gross − fees) compounded trade-by-trade in chronological order. Drawdown areas are highlighted."
          : "Cumulative signed notional. This result was computed before per-trade P&L was added — re-run the backtest to see the real equity curve."}
      </p>
    </div>
  );
}

function TradesTable({ trades }: { trades: Trade[] }) {
  return (
    <div className="rounded-lg border border-base-300 bg-base-100">
      <div className="flex items-center justify-between p-3 border-b border-base-300">
        <h3 className="font-semibold text-sm">Trades</h3>
        <ExportButtons
          data={trades as unknown as Record<string, unknown>[]}
          filename={`backtest-trades-${new Date().toISOString().slice(0, 10)}`}
        />
      </div>
      <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Time</th>
            <th>Market</th>
            <th>Side</th>
            <th className="text-right">Fill price</th>
            <th className="text-right">Size</th>
            <th className="text-right">Underlying $</th>
            <th className="text-right">Slip (bps)</th>
            <th className="text-right">Fees</th>
            <th className="text-right">Net P&L</th>
          </tr>
        </thead>
        <tbody>
          {trades.length === 0 && (
            <tr>
              <td colSpan={9} className="text-center opacity-60 py-6">
                Strategy didn&apos;t fire any trades.
              </td>
            </tr>
          )}
          {trades.slice(0, 200).map((t, i) => {
            const gross = typeof t.pnl === "number" ? t.pnl : null;
            const fees = typeof t.fees === "number" ? t.fees : 0;
            const net = gross != null ? gross - fees : null;
            return (
              <tr key={i}>
                <td className="whitespace-nowrap">{formatDate(t.ts)}</td>
                <td className="font-mono text-xs">
                  <Link
                    href={`/dashboard/markets/${encodeURIComponent(t.market_id)}`}
                    className="link link-hover"
                  >
                    {t.market_id.slice(0, 12)}…
                  </Link>
                </td>
                <td>
                  <SideBadge side={t.side} />
                </td>
                <td className="text-right tabular-nums">
                  {(t.price * 100).toFixed(2)}¢
                </td>
                <td className="text-right tabular-nums">
                  ${t.size.toFixed(2)}
                </td>
                <td className="text-right tabular-nums opacity-80">
                  {typeof t.underlying_price === "number"
                    ? `$${formatPx(t.underlying_price)}`
                    : "—"}
                </td>
                <td className="text-right tabular-nums">
                  {t.slippage_bps.toFixed(1)}
                </td>
                <td className="text-right tabular-nums opacity-70">
                  {fees > 0 ? `$${fees.toFixed(3)}` : "$0"}
                </td>
                <td
                  className={`text-right tabular-nums ${
                    net == null
                      ? "opacity-50"
                      : net > 0
                        ? "text-success"
                        : net < 0
                          ? "text-error"
                          : ""
                  }`}
                >
                  {net == null
                    ? "—"
                    : `${net >= 0 ? "+" : ""}$${net.toFixed(2)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {trades.length > 200 && (
        <div className="text-xs opacity-60 px-3 py-2 border-t border-base-300">
          Showing first 200 of {trades.length} trades — export to get all of them.
        </div>
      )}
    </div>
  );
}

function SideBadge({ side }: { side: string }) {
  const lower = side.toLowerCase();
  if (lower.includes("yes"))
    return <span className="badge badge-success">{side}</span>;
  if (lower.includes("no"))
    return <span className="badge badge-error">{side}</span>;
  return <span className="badge">{side}</span>;
}

function ParamsCard({ params }: { params: Record<string, unknown> }) {
  return (
    <details className="rounded-lg border border-base-300 bg-base-100 p-4">
      <summary className="cursor-pointer font-semibold text-sm">
        Submitted parameters
      </summary>
      <pre className="mt-2 text-xs bg-base-200 p-3 rounded overflow-x-auto">
        {JSON.stringify(params, null, 2)}
      </pre>
    </details>
  );
}

// Date formatting delegated to libs/formatDate so SSR + CSR produce
// identical strings (avoids hydration mismatch). Re-export under the
// local name so existing call sites don't change.
const formatDate = formatDateTime;

function formatPx(n: number): string {
  // Spot prices: BTC at $60k+, ETH at $2-4k, SOL at $100-300. Pick a
  // sensible number of decimals so column widths stay reasonable.
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
