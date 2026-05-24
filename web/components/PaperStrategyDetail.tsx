"use client";

import ExportButtons from "@/components/ExportButtons";
import { formatDateTime } from "@/libs/formatDate";
import Link from "next/link";
import { useEffect, useState } from "react";

interface Strategy {
  paper_strategy_id: string;
  name: string | null;
  strategy_spec: Record<string, unknown>;
  ticker: string | null;
  event_type: string | null;
  size_usd: number;
  started_at: string;
  active: boolean;
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
      setStrategy(await sRes.json());
      if (pRes.ok) {
        const body = await pRes.json();
        setPositions(body.positions ?? []);
      }
      if (eRes.ok) setEquity(await eRes.json());
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

  return (
    <div className="space-y-6">
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

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat
          label="Net P&L"
          value={`$${equity ? (equity.final_net_pnl >= 0 ? "+" : "") + equity.final_net_pnl.toFixed(2) : "0.00"}`}
          accent={equity && equity.final_net_pnl >= 0 ? "success" : equity && equity.final_net_pnl < 0 ? "error" : undefined}
        />
        <Stat label="Win rate" value={`${(winRate * 100).toFixed(1)}%`} />
        <Stat label="Open positions" value={open.length.toString()} />
        <Stat label="Closed positions" value={closed.length.toString()} />
        <Stat label="W / L" value={`${wins} / ${losses}`} />
      </div>

      {/* Equity curve */}
      <EquityChart equity={equity} />

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

function Stat({ label, value, accent }: { label: string; value: string; accent?: "success" | "error" }) {
  const color = accent === "success" ? "text-success" : accent === "error" ? "text-error" : "";
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-3">
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className={`font-semibold mt-1 ${color}`}>{value}</div>
    </div>
  );
}

function EquityChart({ equity }: { equity: EquityCurve | null }) {
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
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 0);
  const range = Math.max(hi - lo, 1e-9);
  const step = W / (values.length - 1);
  const yZero = H - ((0 - lo) / range) * H;
  const path = values.map((v, i) => {
    const x = i * step;
    const y = H - ((v - lo) / range) * H;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const finalGood = values[values.length - 1] >= 0;
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-4 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold">Equity curve (net P&L)</h3>
        <span className={`font-mono text-sm ${finalGood ? "text-success" : "text-error"}`}>
          {finalGood ? "+" : ""}${equity.final_net_pnl.toFixed(2)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40" preserveAspectRatio="none">
        <line x1={0} x2={W} y1={yZero} y2={yZero} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        <path d={path} fill="none" strokeWidth={1.75}
          stroke={finalGood ? "oklch(60% 0.18 150)" : "oklch(55% 0.2 25)"} />
      </svg>
      <p className="text-xs opacity-60">
        {equity.n_closed_positions} closed positions in chronological order.
      </p>
    </div>
  );
}
