"use client";

import ExportButtons from "@/components/ExportButtons";
import { formatDateTime } from "@/libs/formatDate";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  DollarSign,
  Hash,
  Scale,
  Target,
  Trophy,
} from "lucide-react";

interface Strategy {
  paper_strategy_id: string;
  name: string | null;
  strategy_spec: Record<string, unknown>;
  ticker: string | null;
  event_type: string | null;
  size_usd: number;
  started_at: string;
  active: boolean;
  // Set when the strategy was created via "Run as paper trade" from
  // Strategy Builder — points at a parallel backtest job with the same
  // spec used as the baseline for the live tracking comparison.
  baseline_backtest_id?: string | null;
}

interface BaselineSummary {
  status: "queued" | "running" | "completed" | "failed";
  total_pnl?: number;
  win_rate?: number;
  sharpe?: number | null;
  max_drawdown?: number;
  n_trades?: number;
}

interface Position {
  paper_position_id: string;
  market_id: string;
  side: string;
  fill_price: number;
  size_usd: number;
  slippage_bps: number;
  fees: number;
  opened_at: string;
  closed_at: string | null;
  resolution_yes_price: number | null;
  pnl: number | null;
  // BTC/ETH/SOL spot price at the moment of fill, captured from the
  // snapshot at trigger time. Lets the user see context next to the
  // Polymarket fill without jumping to another page.
  underlying_price?: number | null;
}

interface EquityPoint {
  ts: string;
  cumulative_net_pnl: number;
  trade_net_pnl: number;
}

interface EquityCurve {
  paper_strategy_id: string;
  n_closed_positions: number;
  final_net_pnl: number;
  points: EquityPoint[];
}

export default function PaperStrategyDetail({ strategyId }: { strategyId: string }) {
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [equity, setEquity] = useState<EquityCurve | null>(null);
  const [baseline, setBaseline] = useState<BaselineSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [sRes, pRes, eRes] = await Promise.all([
        fetch(`/api/paper/strategies/${encodeURIComponent(strategyId)}`, { cache: "no-store" }),
        fetch(`/api/paper/strategies/${encodeURIComponent(strategyId)}/positions`, { cache: "no-store" }),
        fetch(`/api/paper/strategies/${encodeURIComponent(strategyId)}/equity`, { cache: "no-store" }),
      ]);
      if (!sRes.ok) {
        setError("Strategy not found or unauthorised.");
        return;
      }
      const sBody: Strategy = await sRes.json();
      setStrategy(sBody);
      if (pRes.ok) {
        const body = await pRes.json();
        setPositions(body.positions ?? []);
      }
      if (eRes.ok) setEquity(await eRes.json());
      // Fetch the baseline backtest if one was linked. We hit our own
      // /api/backtest/[id] endpoint which already polls + serializes
      // the full job record. Best-effort — silently degrades to no
      // baseline panel if the fetch fails.
      if (sBody.baseline_backtest_id) {
        try {
          const bRes = await fetch(
            `/api/backtest/${encodeURIComponent(sBody.baseline_backtest_id)}`,
            { cache: "no-store" },
          );
          if (bRes.ok) {
            const bJob = await bRes.json();
            const r = bJob.result;
            setBaseline({
              status: bJob.status,
              total_pnl: r?.total_pnl,
              win_rate: r?.win_rate,
              sharpe: r?.sharpe,
              max_drawdown: r?.max_drawdown,
              n_trades: r?.n_trades,
            });
          }
        } catch {
          // ignore
        }
      } else {
        setBaseline(null);
      }
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Network error");
    }
  }

  useEffect(() => {
    refresh();
    // Refresh every 30s so paper P&L updates without manual reload
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [strategyId]);

  if (error) return <div className="alert alert-error"><span>{error}</span></div>;
  if (!strategy) return <div className="opacity-70">Loading…</div>;

  const open = positions.filter((p) => p.closed_at == null);
  const closed = positions.filter((p) => p.closed_at != null);
  const wins = closed.filter((p) => (p.pnl ?? 0) - p.fees > 0).length;
  const losses = closed.length - wins;
  const winRate = closed.length > 0 ? wins / closed.length : 0;

  // Per-trade net P&L = pnl - fees. Used by profit factor, avg trade,
  // best/worst, and the drawdown computation on the equity curve.
  const closedNetPnls = closed.map((p) => (p.pnl ?? 0) - (p.fees ?? 0));
  const grossWins = closedNetPnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(
    closedNetPnls.filter((p) => p < 0).reduce((a, b) => a + b, 0),
  );
  const profitFactor =
    grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : null;
  const avgTrade = closed.length > 0
    ? closedNetPnls.reduce((a, b) => a + b, 0) / closed.length
    : 0;
  const bestTrade = closedNetPnls.length ? Math.max(...closedNetPnls) : null;
  const worstTrade = closedNetPnls.length ? Math.min(...closedNetPnls) : null;
  // Drawdown from running peak in chronological order — matches the
  // backtest result page convention.
  let runningPeak = 0;
  let runningSum = 0;
  let maxDrawdown = 0;
  for (const p of closedNetPnls) {
    runningSum += p;
    if (runningSum > runningPeak) runningPeak = runningSum;
    const dd = runningPeak - runningSum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Time-since-last-fill for the Live status pill. `opened_at` is the
  // most recent activity signal we have on the worker side; "fired
  // X min ago" tells the user whether the strategy is still alive.
  const lastFillTs = positions.length > 0
    ? Math.max(
        ...positions.map((p) => new Date(p.opened_at).getTime()),
      )
    : null;
  const ageMinutes = lastFillTs != null
    ? Math.floor((Date.now() - lastFillTs) / 60000)
    : null;

  // Hero verdict — one sentence at the top. Priority:
  //   1. Baseline comparison if available (tracking ahead/behind)
  //   2. Else net-PnL trajectory + sample size
  function heroSentence(): { text: string; tone: "success" | "error" | "neutral" } {
    const livePnl = equity?.final_net_pnl ?? 0;
    if (baseline && baseline.status === "completed" && baseline.total_pnl != null
        && baseline.n_trades && baseline.n_trades > 0 && closed.length > 0) {
      const completionRatio = closed.length / baseline.n_trades;
      const expected = baseline.total_pnl * completionRatio;
      const delta = livePnl - expected;
      const pct = expected !== 0 ? (delta / Math.abs(expected)) * 100 : 0;
      if (Math.abs(pct) < 5) {
        return { text: `Tracking the backtest baseline closely — within ${pct.toFixed(1)}% of expected P&L at ${closed.length} trades.`, tone: "neutral" };
      }
      if (delta >= 0) {
        return { text: `Outpacing the backtest baseline by ${pct.toFixed(1)}% (+$${delta.toFixed(2)}) at ${closed.length} trades. Promising — let it run more.`, tone: "success" };
      }
      return { text: `Underperforming the backtest by ${Math.abs(pct).toFixed(1)}% ($${delta.toFixed(2)}) at ${closed.length} trades. Could be regime shift, slippage, or noise.`, tone: "error" };
    }
    if (closed.length === 0) {
      return open.length > 0
        ? { text: `${open.length} position${open.length === 1 ? "" : "s"} live — waiting for the first market to resolve before P&L appears.`, tone: "neutral" }
        : { text: `Watching for entries. Strategy fires on each matching snapshot — first opportunity may take minutes.`, tone: "neutral" };
    }
    if (livePnl > 0) {
      return { text: `Net +$${livePnl.toFixed(2)} across ${closed.length} closed trades · ${(winRate * 100).toFixed(0)}% win rate.`, tone: "success" };
    }
    if (livePnl < 0) {
      return { text: `Net −$${Math.abs(livePnl).toFixed(2)} across ${closed.length} closed trades · ${(winRate * 100).toFixed(0)}% win rate.`, tone: "error" };
    }
    return { text: `Break-even across ${closed.length} closed trades.`, tone: "neutral" };
  }
  const hero = heroSentence();

  const heroTone =
    hero.tone === "success" ? "border-success/40 bg-success/5 text-success" :
    hero.tone === "error" ? "border-error/40 bg-error/5 text-error" :
    "border-base-300 bg-base-200/30 text-base-content/80";

  return (
    <div className="space-y-5">
      {/* Hero verdict — one sentence answers "is this working?" */}
      <div className={`rounded-xl border ${heroTone} px-5 py-4 flex items-baseline justify-between gap-4 flex-wrap`}>
        <div className="space-y-1 min-w-0 flex-1">
          <div className="text-[10px] font-mono uppercase tracking-widest opacity-60">
            Live verdict
          </div>
          <div className="text-base leading-relaxed">
            {hero.text}
          </div>
        </div>
        <LiveStatusPill
          active={strategy.active}
          monitoring={open.length}
          ageMinutes={ageMinutes}
        />
      </div>

      {/* Strategy header */}
      <div className="rounded-lg border border-base-300 bg-base-100 p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-semibold text-lg">
              {strategy.name || "(untitled)"}
            </h2>
            <p className="text-xs opacity-60 mt-1">
              Started {formatDateTime(strategy.started_at)} ·{" "}
              {strategy.ticker || "any ticker"} ·{" "}
              {strategy.event_type || "any window"} ·{" "}
              ${strategy.size_usd}/trade
            </p>
          </div>
          {strategy.active ? (
            <span className="badge badge-success badge-lg">Active</span>
          ) : (
            <span className="badge badge-ghost badge-lg">Paused</span>
          )}
        </div>
        <details className="text-xs opacity-80 mt-3">
          <summary className="cursor-pointer">Strategy spec</summary>
          <pre className="mt-2 bg-base-200 p-2 rounded overflow-x-auto">
            {JSON.stringify(strategy.strategy_spec, null, 2)}
          </pre>
        </details>
      </div>

      {/* Primary stats — net P&L, win rate, edge metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label="Net P&L"
          icon={<DollarSign size={13} strokeWidth={2} />}
          value={`${equity && equity.final_net_pnl >= 0 ? "+" : ""}$${equity ? equity.final_net_pnl.toFixed(2) : "0.00"}`}
          accent={equity && equity.final_net_pnl >= 0 ? "success" : equity && equity.final_net_pnl < 0 ? "error" : undefined}
        />
        <Stat
          label="Win rate"
          icon={<Target size={13} strokeWidth={2} />}
          value={`${(winRate * 100).toFixed(1)}%`}
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
        <Stat
          label="Avg trade"
          icon={<Activity size={13} strokeWidth={2} />}
          value={`${avgTrade >= 0 ? "+" : ""}$${avgTrade.toFixed(2)}`}
          accent={
            closed.length === 0 ? undefined :
            avgTrade > 0 ? "success" : avgTrade < 0 ? "error" : undefined
          }
        />
      </div>
      {/* Secondary stats — tail + drawdown */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label="Best trade"
          icon={<Trophy size={13} strokeWidth={2} />}
          value={bestTrade !== null ? `+$${bestTrade.toFixed(2)}` : "—"}
          accent={bestTrade !== null && bestTrade > 0 ? "success" : undefined}
        />
        <Stat
          label="Worst trade"
          icon={<ArrowDownRight size={13} strokeWidth={2} />}
          value={worstTrade !== null ? `$${worstTrade.toFixed(2)}` : "—"}
          accent={worstTrade !== null && worstTrade < 0 ? "error" : undefined}
        />
        <Stat
          label="Max drawdown"
          icon={<ArrowUpRight size={13} strokeWidth={2} className="rotate-180" />}
          value={`$${maxDrawdown.toFixed(2)}`}
          accent={maxDrawdown > 0 ? "error" : undefined}
        />
        <Stat
          label="Trades"
          icon={<Hash size={13} strokeWidth={2} />}
          value={`${wins} W / ${losses} L`}
        />
      </div>

      {/* Baseline backtest comparison — only when the strategy was
        * created via "Run as paper trade" from Strategy Builder. */}
      <BaselineComparison
        baseline={baseline}
        livePnl={equity?.final_net_pnl ?? 0}
        liveTrades={closed.length}
        liveWinRate={winRate}
      />

      {/* Open positions — currently in-flight trades. Pulled out as
        * its own section so the user can see "live state" at a glance
        * without scrolling through the full chronological table. */}
      {open.length > 0 && (
        <OpenPositionsCard positions={open} />
      )}

      {/* Equity curve + drawdown overlay */}
      <EquityChart equity={equity} maxDrawdown={maxDrawdown} />

      {/* Positions */}
      <div className="rounded-lg border border-base-300 bg-base-100">
        <div className="flex items-center justify-between p-3 border-b border-base-300">
          <h3 className="font-semibold text-sm">All virtual trades ({positions.length})</h3>
          <ExportButtons
            data={positions as unknown as Record<string, unknown>[]}
            filename={`paper-trades-${strategyId.slice(0, 8)}`}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Opened</th>
                <th>Market</th>
                <th>Side</th>
                <th className="text-right">Fill</th>
                <th className="text-right">Size</th>
                <th className="text-right">Underlying $</th>
                <th>Closed</th>
                <th className="text-right">Net P&L</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-6 opacity-60">
                    No virtual trades yet — strategy hasn&apos;t fired since it started.
                  </td>
                </tr>
              )}
              {positions.slice(0, 200).map((p) => {
                const net = p.pnl != null ? p.pnl - p.fees : null;
                return (
                  <tr key={p.paper_position_id}>
                    <td className="whitespace-nowrap text-xs">{formatDateTime(p.opened_at)}</td>
                    <td className="font-mono text-xs">
                      <Link
                        href={`/dashboard/markets/${encodeURIComponent(p.market_id)}`}
                        className="link link-hover"
                      >
                        {p.market_id.slice(0, 14)}…
                      </Link>
                    </td>
                    <td>
                      <span className={`badge ${p.side.includes("yes") ? "badge-success" : "badge-error"}`}>
                        {p.side}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{(p.fill_price * 100).toFixed(2)}¢</td>
                    <td className="text-right tabular-nums">${p.size_usd.toFixed(2)}</td>
                    <td className="text-right tabular-nums opacity-80">
                      {typeof p.underlying_price === "number"
                        ? `$${p.underlying_price >= 1000 ? p.underlying_price.toFixed(0) : p.underlying_price.toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {p.closed_at ? formatDateTime(p.closed_at) : <span className="opacity-50">open</span>}
                    </td>
                    <td className={`text-right tabular-nums ${
                      net == null ? "opacity-50"
                      : net > 0 ? "text-success"
                      : net < 0 ? "text-error" : ""
                    }`}>
                      {net == null ? "—" : `${net >= 0 ? "+" : ""}$${net.toFixed(2)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs opacity-60 text-center">
        Auto-refreshes every 30 seconds while you have this page open.
      </p>
    </div>
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
  const color = accent === "success" ? "text-success" : accent === "error" ? "text-error" : "";
  // Icon colour mirrors the value's accent so a quick scan of the
  // 4-up stat row signals positive / negative / neutral at a glance.
  const iconColor =
    accent === "success" ? "text-success/70" : accent === "error" ? "text-error/70" : "text-base-content/40";
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-3">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide opacity-60">
        {icon && <span className={`shrink-0 ${iconColor}`} aria-hidden>{icon}</span>}
        <span>{label}</span>
      </div>
      <div className={`font-semibold mt-1 font-mono tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function EquityChart({
  equity,
  maxDrawdown,
}: {
  equity: EquityCurve | null;
  maxDrawdown: number;
}) {
  if (!equity || equity.points.length < 2) {
    return (
      <div className="rounded-lg border border-base-300 bg-base-100 p-4 text-sm opacity-60 text-center py-8">
        Equity curve will appear once at least 2 paper positions close.
      </div>
    );
  }
  const W = 700;
  const H = 160;
  const values = equity.points.map((p) => p.cumulative_net_pnl);
  // Compute running peak per point so we can shade drawdown regions.
  let peak = 0;
  const peaks = values.map((v) => {
    if (v > peak) peak = v;
    return peak;
  });
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 0);
  const range = Math.max(hi - lo, 1e-9);
  const step = W / (values.length - 1);
  const yZero = H - ((0 - lo) / range) * H;
  const yFor = (v: number) => H - ((v - lo) / range) * H;
  const path = values.map((v, i) => {
    const x = i * step;
    const y = yFor(v);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  // Peak line — running maximum. Drawdown = peak - current; the shaded
  // band between the two lines visualises pain. When the current value
  // equals the peak (new high), the band collapses to nothing.
  const peakPath = peaks.map((v, i) => {
    const x = i * step;
    const y = yFor(v);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const ddBandPath =
    peakPath +
    " " +
    values
      .slice()
      .reverse()
      .map((v, j) => {
        const i = values.length - 1 - j;
        const x = i * step;
        const y = yFor(v);
        return `L${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ") +
    " Z";
  const finalGood = values[values.length - 1] >= 0;
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-4 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold">Equity curve (net P&L)</h3>
        <div className="flex items-center gap-3 text-xs font-mono">
          <span className="text-base-content/50">
            Max DD: −${maxDrawdown.toFixed(2)}
          </span>
          <span className={`${finalGood ? "text-success" : "text-error"}`}>
            {finalGood ? "+" : ""}${equity.final_net_pnl.toFixed(2)}
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40" preserveAspectRatio="none">
        {/* Drawdown band — area between peak and current. */}
        <path d={ddBandPath} fill="oklch(55% 0.2 25 / 0.12)" stroke="none" />
        {/* Zero baseline */}
        <line x1={0} x2={W} y1={yZero} y2={yZero} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        {/* Peak (running max) — dashed line */}
        <path d={peakPath} fill="none" strokeWidth={1} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="3 3" />
        {/* Equity curve */}
        <path d={path} fill="none" strokeWidth={1.75}
          stroke={finalGood ? "oklch(60% 0.18 150)" : "oklch(55% 0.2 25)"} />
      </svg>
      <p className="text-xs opacity-60">
        {equity.n_closed_positions} closed positions in chronological order.
        Shaded region = drawdown from running peak.
      </p>
    </div>
  );
}

/**
 * Live status pill — top-right of the hero band. Tells the user at a
 * glance whether the strategy is still running, what it's currently
 * monitoring, and when it last did something. This is the "I'm
 * still alive" signal that the original page lacked — without it
 * a paused strategy looks identical to an active-but-quiet one.
 */
function LiveStatusPill({
  active,
  monitoring,
  ageMinutes,
}: {
  active: boolean;
  monitoring: number;
  ageMinutes: number | null;
}) {
  if (!active) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-base-300/40 text-base-content/60 text-xs">
        <span className="w-2 h-2 rounded-full bg-base-content/40" />
        Paused
      </div>
    );
  }
  const ageText =
    ageMinutes === null
      ? "no fills yet"
      : ageMinutes < 1
        ? "just now"
        : ageMinutes < 60
          ? `${ageMinutes}m ago`
          : `${Math.floor(ageMinutes / 60)}h ago`;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-success/10 border border-success/30 text-success text-xs">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-75 animate-ping" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
      </span>
      <span>Live</span>
      <span className="opacity-60">·</span>
      <span className="opacity-80">
        {monitoring} open · last fill {ageText}
      </span>
    </div>
  );
}

/**
 * Open positions card — currently-in-flight trades, lifted out of the
 * chronological "all trades" table so the live state isn't buried.
 */
function OpenPositionsCard({ positions }: { positions: Position[] }) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="font-semibold text-sm">
          Open positions ({positions.length})
        </h3>
        <span className="text-[10px] font-mono uppercase tracking-widest text-primary/70">
          waiting for resolution
        </span>
      </div>
      <div className="space-y-1.5">
        {positions.slice(0, 8).map((p) => (
          <div
            key={p.paper_position_id}
            className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-base-100 border border-base-300/60 text-xs"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={`badge badge-xs ${p.side.includes("yes") ? "badge-success" : "badge-error"}`}>
                {p.side}
              </span>
              <code className="font-mono opacity-60 truncate max-w-[18ch]" title={p.market_id}>
                {p.market_id.slice(0, 10)}…
              </code>
            </div>
            <div className="flex items-center gap-3 font-mono tabular-nums text-base-content/70 shrink-0">
              <span>fill {(p.fill_price * 100).toFixed(0)}¢</span>
              <span>·</span>
              <span>${p.size_usd.toFixed(0)}</span>
              {p.underlying_price != null && (
                <>
                  <span>·</span>
                  <span className="opacity-60">${p.underlying_price.toFixed(0)}</span>
                </>
              )}
              <span>·</span>
              <span className="opacity-60">{formatDateTime(p.opened_at)}</span>
            </div>
          </div>
        ))}
        {positions.length > 8 && (
          <p className="text-[11px] text-base-content/40 font-mono text-center pt-1">
            + {positions.length - 8} more — see full table below
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Baseline comparison panel — shows the backtest expectation alongside
 * the live paper-trading reality so a user can tell whether their
 * strategy is tracking, ahead, or behind out-of-sample. Renders only
 * when a baseline_backtest_id was attached at strategy-create time
 * (i.e. the strategy was created via the "Run as paper trade" CTA in
 * Strategy Builder); legacy paper strategies just don't see this card.
 */
function BaselineComparison({
  baseline,
  livePnl,
  liveTrades,
  liveWinRate,
}: {
  baseline: BaselineSummary | null;
  livePnl: number;
  liveTrades: number;
  liveWinRate: number;
}) {
  if (!baseline) return null;
  if (baseline.status !== "completed" || baseline.total_pnl == null) {
    return (
      <div className="rounded-lg border border-base-300 bg-base-100 p-4">
        <h3 className="font-semibold">Baseline backtest</h3>
        <p className="text-sm opacity-70 mt-2">
          Baseline run is {baseline.status}. Tracking comparison will
          appear once it completes.
        </p>
      </div>
    );
  }

  const bPnl = baseline.total_pnl ?? 0;
  const bTrades = baseline.n_trades ?? 0;
  const bWinRate = baseline.win_rate ?? 0;
  // Expected live PnL: scale baseline PnL by the fraction of trades
  // we've completed so far. liveTrades=0 → expected=0, no tracking
  // signal yet. liveTrades=bTrades → expected=bPnl.
  const completionRatio = bTrades > 0 ? liveTrades / bTrades : 0;
  const expectedPnl = bPnl * completionRatio;
  const trackingDelta = livePnl - expectedPnl;
  const trackingTone =
    trackingDelta >= 0 ? "text-success" : "text-error";

  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="font-semibold">Baseline backtest vs live paper</h3>
        <span className="text-[10px] uppercase tracking-widest opacity-50 font-mono">
          {liveTrades}/{bTrades} trades · {(completionRatio * 100).toFixed(0)}% of baseline universe
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <SideStat
          label="Backtest P&L"
          value={`${bPnl >= 0 ? "+" : ""}$${bPnl.toFixed(2)}`}
          accent={bPnl >= 0 ? "success" : "error"}
        />
        <SideStat
          label="Paper P&L (live)"
          value={`${livePnl >= 0 ? "+" : ""}$${livePnl.toFixed(2)}`}
          accent={livePnl >= 0 ? "success" : "error"}
        />
        <SideStat
          label="Tracking vs expected"
          value={`${trackingDelta >= 0 ? "+" : ""}$${trackingDelta.toFixed(2)}`}
          accent={trackingDelta >= 0 ? "success" : "error"}
        />
        <SideStat
          label="Backtest win rate"
          value={`${(bWinRate * 100).toFixed(1)}%`}
        />
        <SideStat
          label="Paper win rate"
          value={`${(liveWinRate * 100).toFixed(1)}%`}
        />
        <SideStat
          label="Backtest Sharpe"
          value={baseline.sharpe != null ? baseline.sharpe.toFixed(2) : "—"}
        />
      </div>

      <p className={`text-xs ${trackingTone}`}>
        {liveTrades === 0
          ? "Waiting for the first live trade to start tracking."
          : trackingDelta >= 0
            ? `Live paper is ahead of the backtest by $${trackingDelta.toFixed(2)} at this trade count — the strategy is so far validating out-of-sample.`
            : `Live paper is behind by $${Math.abs(trackingDelta).toFixed(2)} vs what the backtest predicted at this trade count. Could be regime shift, slippage assumptions, or noise — let it run more trades.`}
      </p>
    </div>
  );
}

function SideStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "success" | "error";
}) {
  const color =
    accent === "success" ? "text-success" : accent === "error" ? "text-error" : "";
  return (
    <div className="rounded-md border border-base-300/60 bg-base-200/40 p-2.5">
      <div className="text-[10px] uppercase tracking-widest opacity-60">{label}</div>
      <div className={`font-semibold mt-1 font-mono tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
