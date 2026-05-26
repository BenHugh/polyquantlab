"use client";

import ExportButtons from "@/components/ExportButtons";
import { formatDateTime } from "@/libs/formatDate";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  DollarSign,
  Globe2,
  Hash,
  Receipt,
  Scale,
  Sigma,
  Target,
  Trophy,
} from "lucide-react";

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

  // queued or running — show estimated progress bar
  return <RunningProgress job={job} gaveUp={gaveUp} />;
}

function RunningProgress({ job, gaveUp }: { job: JobRecord; gaveUp: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  // Estimate progress. Different strategy types have very different
  // per-market costs:
  //   threshold_entry / mean_reversion / time_before_resolution
  //     fast — one snapshot scan per market, ~60ms each
  //   condition_based
  //     slow — every snapshot evaluates the full AND/OR tree with
  //     window stats + cross-state, empirically ~440ms each
  // Previously this used a flat 50ms estimate which made
  // condition_based runs hit the 95% cap in seconds and then sit
  // there for 30-60 s, making the UI look frozen.
  const params = job.params as Record<string, unknown>;
  const marketLimit = Number(params.market_limit || 50);
  const stratType =
    (params.strategy as { type?: string } | undefined)?.type ?? "threshold_entry";
  const perMarketMs = stratType === "condition_based" ? 500 : 80;
  // Sweeps have n_cells × markets total work
  const xAxis = params.x_axis as { steps?: number } | undefined;
  const yAxis = params.y_axis as { steps?: number } | undefined;
  const cellCount = xAxis?.steps
    ? xAxis.steps * (yAxis?.steps || 1)
    : 1;
  const expectedMs = Math.max(2000, marketLimit * cellCount * perMarketMs);

  let pct: number;
  let label: string;
  if (job.status === "queued") {
    pct = 5;
    label = "Queued — waiting for a worker…";
  } else if (job.started_at) {
    const elapsed = now - new Date(job.started_at).getTime();
    // Asymptotic curve instead of hard linear-then-cap. 1×expected ≈
    // 80%, 1.5× ≈ 88%, 2× ≈ 92%, 3×+ asymptote at 95%. Means the bar
    // keeps creeping forward even when our estimate undershoots — no
    // more "stuck at 95% for 30 seconds" panic.
    const ratio = elapsed / expectedMs;
    const eased = 1 - Math.exp(-ratio * 1.6);
    pct = Math.min(95, eased * 100);
    const remainingMs = Math.max(0, expectedMs - elapsed);
    label = remainingMs > 1000
      ? `Running… ~${Math.ceil(remainingMs / 1000)}s remaining`
      : "Running… finishing up";
  } else {
    pct = 10;
    label = "Starting…";
  }

  return (
    <div className="rounded-xl border border-base-300 bg-base-200/30 p-4 space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
          <span className="truncate">{label}</span>
        </div>
        <span className="font-mono text-xs tabular-nums text-base-content/70 shrink-0">
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-base-300 overflow-hidden">
        <div
          className="h-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {gaveUp && (
        <p className="text-xs text-warning">
          This job is taking longer than usual. The page will keep the
          result available — refresh to retry, or check back later.
        </p>
      )}
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
      {result.n_trades === 0 && <NoTradesCallout params={params} />}
      <StatsGrid result={result} />
      <PnLChart trades={result.trades} />
      <TradesTable trades={result.trades} />
      <ParamsCard params={params} />
    </div>
  );
}

/**
 * Zero-trades callout — explains WHY the result is all zeros and points
 * the user back to Strategy Builder to loosen. Previously when a strategy
 * never fired, the page rendered all-zero stats + "Not enough trades for
 * a chart" + an empty table, leaving the user thinking the backtest
 * "didn't show any data" (it did — it showed an empty result).
 */
function NoTradesCallout({ params }: { params: Record<string, unknown> }) {
  const marketLimit = Number(params.market_limit || 50);
  const ticker = (params.ticker as string) || "all";
  const eventType = (params.event_type as string) || "all";
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 space-y-2">
      <div className="flex items-center gap-2 text-warning font-semibold">
        <span className="w-2 h-2 rounded-full bg-warning" aria-hidden />
        <span>No trades fired</span>
      </div>
      <p className="text-sm text-base-content/70 leading-relaxed">
        Across <strong>{marketLimit} {ticker} {eventType}</strong> markets, your
        entry conditions never simultaneously matched. The backtest ran fine —
        it just didn&apos;t find a setup to enter on. This usually means one of
        your AND conditions is too strict for the data sample.
      </p>
      <details className="text-xs text-base-content/60">
        <summary className="cursor-pointer hover:text-base-content/80 select-none">
          How to loosen
        </summary>
        <ul className="mt-2 ml-4 space-y-1 list-disc">
          <li>
            <strong>Token price ≤ X</strong> — bump X by 0.05-0.10
          </li>
          <li>
            <strong>Spread ≤ X</strong> — Polymarket books are wider than
            equities; try 0.08-0.10
          </li>
          <li>
            <strong>Coin move ≥ X%</strong> — try 0.10% instead of 0.20%+
          </li>
          <li>
            <strong>Time-window conditions</strong> — widen the window to
            capture more snapshots
          </li>
          <li>
            Or change the outer group from <strong>AND</strong> to{" "}
            <strong>OR</strong> — but only after isolating which condition
            is the binding constraint
          </li>
        </ul>
      </details>
      <Link
        href="/dashboard/strategy-builder"
        className="btn btn-sm btn-warning btn-outline gap-2"
      >
        ← Back to Strategy Builder
      </Link>
    </div>
  );
}

function StatsGrid({ result }: { result: BacktestResultBody }) {
  // Tail + ratio metrics aren't on the result body itself — derive them
  // from the trade list here so we don't have to migrate the backend
  // response schema mid-flight. All trades carry a `pnl` field on
  // Phase H1+ results, so this is safe for anything backtested in the
  // last few weeks.
  const tradePnls = result.trades
    .map((t) => (typeof t.pnl === "number" ? t.pnl : null))
    .filter((p): p is number => p !== null);

  const best = tradePnls.length ? Math.max(...tradePnls) : null;
  const worst = tradePnls.length ? Math.min(...tradePnls) : null;
  const grossWins = tradePnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(
    tradePnls.filter((p) => p < 0).reduce((a, b) => a + b, 0),
  );
  const profitFactor =
    grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : null;
  // Calmar (per-trade flavour): a strategy that earns N times its worst
  // drawdown is the kind of thing institutional quants screen on first.
  const calmar =
    result.max_drawdown !== 0
      ? result.total_pnl / Math.abs(result.max_drawdown)
      : null;

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label="Total PnL"
          icon={<DollarSign size={13} strokeWidth={2} />}
          value={`$${result.total_pnl.toFixed(2)}`}
          accent={result.total_pnl >= 0 ? "success" : "error"}
        />
        <Stat
          label="Fees"
          icon={<Receipt size={13} strokeWidth={2} />}
          value={`$${result.total_fees.toFixed(2)}`}
        />
        <Stat
          label="Win rate"
          icon={<Target size={13} strokeWidth={2} />}
          value={`${(result.win_rate * 100).toFixed(1)}%`}
        />
        <Stat
          label="Sharpe"
          icon={<Sigma size={13} strokeWidth={2} />}
          value={result.sharpe != null ? result.sharpe.toFixed(2) : "—"}
        />
        <Stat
          label="Max drawdown"
          icon={<ArrowUpRight size={13} strokeWidth={2} className="rotate-180" />}
          value={`$${result.max_drawdown.toFixed(2)}`}
          accent={result.max_drawdown > 0 ? "error" : undefined}
        />
        <Stat
          label="Trades"
          icon={<Hash size={13} strokeWidth={2} />}
          value={result.n_trades.toString()}
        />
        <Stat
          label="PnL / trade"
          icon={<Activity size={13} strokeWidth={2} />}
          value={
            result.n_trades > 0
              ? `$${(result.total_pnl / result.n_trades).toFixed(2)}`
              : "—"
          }
        />
        <Stat
          label="Profit factor"
          icon={<Scale size={13} strokeWidth={2} />}
          value={
            profitFactor === null
              ? "—"
              : profitFactor === Infinity
                ? "∞"
                : profitFactor.toFixed(2)
          }
          accent={
            profitFactor === null || profitFactor === Infinity
              ? undefined
              : profitFactor >= 1
                ? "success"
                : "error"
          }
        />
      </div>

      {/* Tail row — separate so it visually reads as "secondary detail" */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
        <Stat
          label="Best trade"
          icon={<Trophy size={13} strokeWidth={2} />}
          value={best !== null ? `+$${best.toFixed(2)}` : "—"}
          accent={best !== null && best > 0 ? "success" : undefined}
        />
        <Stat
          label="Worst trade"
          icon={<ArrowDownRight size={13} strokeWidth={2} />}
          value={worst !== null ? `$${worst.toFixed(2)}` : "—"}
          accent={worst !== null && worst < 0 ? "error" : undefined}
        />
        <Stat
          label="Calmar"
          icon={<BarChart3 size={13} strokeWidth={2} />}
          value={calmar !== null ? calmar.toFixed(2) : "—"}
          accent={
            calmar === null ? undefined : calmar >= 0 ? "success" : "error"
          }
        />
        <Stat
          label="Markets"
          icon={<Globe2 size={13} strokeWidth={2} />}
          value={result.n_markets.toString()}
        />
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  accent,
  icon,
}: {
  label: string;
  value: string;
  accent?: "success" | "error";
  icon?: ReactNode;
}) {
  const color =
    accent === "success"
      ? "text-success"
      : accent === "error"
      ? "text-error"
      : "";
  // Icon tinted to match the value's accent — quick visual scan of the
  // stat grid reads green=good, red=bad, neutral=informational.
  const iconColor =
    accent === "success"
      ? "text-success/70"
      : accent === "error"
      ? "text-error/70"
      : "text-base-content/40";
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-3">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide opacity-60">
        {icon && (
          <span className={`shrink-0 ${iconColor}`} aria-hidden>
            {icon}
          </span>
        )}
        <span>{label}</span>
      </div>
      <div className={`font-semibold mt-1 font-mono tabular-nums ${color}`}>{value}</div>
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
  // Build path as a monotone-cubic spline (Steffen, 1990 — produces smooth
  // curves that *never overshoot* the underlying data points, unlike
  // generic Bezier interpolation which can invent fake humps between
  // samples). For a P&L curve that matters: a Bezier would visually
  // imply equity dips that didn't actually happen, which is dishonest
  // when the chart is the user's primary signal of strategy quality.
  // 50 trade segments still read as "smooth" without the lie.
  const points = cum.map((v, i) => ({
    x: i * step,
    y: height - ((v - lo) / range) * height,
  }));
  const path = monotoneCubicPath(points);

  const lastX = (cum.length - 1) * step;
  const fillPath =
    hasPnl && cum.length >= 2
      ? `${path} L${lastX.toFixed(1)},${yZero} L0,${yZero} Z`
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

// Monotone-cubic SVG path. Steffen (1990) / d3.curveMonotoneX, inlined so
// we don't pull a chart lib for one chart. The invariant is the
// important one: tangents are chosen so the spline never overshoots a
// local extremum. For an equity curve that means we'll never visually
// imply a dip that didn't happen between two real trade points.
function monotoneCubicPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;

  const n = pts.length;
  // Slopes between adjacent points.
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    dy.push(pts[i + 1].y - pts[i].y);
    m.push(dy[i] / (dx[i] || 1));
  }

  // Per-point tangents (Fritsch-Carlson).
  const tangents: number[] = new Array(n);
  tangents[0] = m[0];
  tangents[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      // Sign change at this point → flat tangent prevents overshoot.
      tangents[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangents[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }

  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    const x1 = pts[i].x + h / 3;
    const y1 = pts[i].y + (tangents[i] * h) / 3;
    const x2 = pts[i + 1].x - h / 3;
    const y2 = pts[i + 1].y - (tangents[i + 1] * h) / 3;
    d += ` C${x1.toFixed(1)},${y1.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}
