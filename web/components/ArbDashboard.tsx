"use client";

/**
 * ArbDashboard — live Polymarket × Binance mispricing scanner UI.
 *
 * Polls /api/arb every POLL_MS (default 4 s). Renders a table of
 * opportunities sorted by expected net PnL per share, with all the
 * diagnostics a trader needs to decide whether to execute:
 *
 *   - Ticker icon + event type (5m / 15m / 1h / ...)
 *   - τ countdown to market resolution
 *   - Strike vs spot (the "why is YES even quoted at 50¢?" signal)
 *   - Polymarket YES/NO book + model probability
 *   - Direction pill + actual fill price + spread + net EV
 *
 * Filters (top of page): min edge percentage, vol window, ticker set.
 *
 * Honest UX choices:
 *   - We show fill_price (real ask) not yes_mid as the headline number.
 *     A fillable price is what matters; mid-of-wide-book is fiction.
 *   - "NET EV / share" is gross_edge − entry_fee. We do NOT subtract gas
 *     or execution lag, but warn about both in a footer disclosure.
 *   - Empty state when no edges clear filters is the normal case during
 *     active trading hours; we explain that rather than blame the user.
 */

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Clock, Filter, Zap } from "lucide-react";
import CoinIcon from "@/components/CoinIcon";
import QSelect from "@/components/QSelect";

const POLL_MS = 4000;

interface ArbOpportunity {
  market_id: string;
  ticker: string;
  event_type: string;
  question: string;
  resolution_at: string;
  seconds_to_resolution: number;
  underlying_now: number;
  strike_price: number;
  log_diff: number;
  sigma_annual: number;
  sigma_tau: number;
  market_yes_mid: number;
  model_yes_prob: number;
  mismatch_mid: number;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  fill_price: number;
  fill_spread: number;
  direction: "BUY_YES" | "BUY_NO";
  edge_per_share: number;
  est_fee_per_share: number;
  expected_pnl_per_share: number;
}

interface ArbResponse {
  as_of: string;
  count: number;
  tickers: string[];
  event_types: string[];
  min_edge_pp: number;
  opportunities: ArbOpportunity[];
}

export default function ArbDashboard() {
  const [data, setData] = useState<ArbResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [minEdgePp, setMinEdgePp] = useState(0.04);
  const [paused, setPaused] = useState(false);
  const [lastFetched, setLastFetched] = useState<number>(0);

  const fetchArb = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        min_edge_pp: String(minEdgePp),
        limit: "50",
      });
      const res = await fetch(`/api/arb?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.detail || body?.error || `HTTP ${res.status}`);
        return;
      }
      const body: ArbResponse = await res.json();
      setData(body);
      setError(null);
      setLastFetched(Date.now());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Network error";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [minEdgePp]);

  useEffect(() => {
    fetchArb();
    if (paused) return;
    const id = setInterval(fetchArb, POLL_MS);
    return () => clearInterval(id);
  }, [fetchArb, paused]);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <section className="q-panel">
        <header className="q-panel-header">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="shrink-0 text-info" aria-hidden>
              <Filter size={16} strokeWidth={2} />
            </span>
            <h3 className="q-section-title truncate">Filters</h3>
          </div>
          <span className="q-section-subtitle flex items-center gap-3 shrink-0">
            <LivePulse paused={paused} error={!!error} lastFetched={lastFetched} />
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className="btn btn-ghost btn-xs"
              title={paused ? "Resume polling" : "Pause polling"}
            >
              {paused ? "▶ Resume" : "⏸ Pause"}
            </button>
          </span>
        </header>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="block">
            <label className="q-label">Minimum expected profit per share</label>
            <QSelect
              value={String(minEdgePp)}
              onChange={(v) => setMinEdgePp(parseFloat(v))}
              options={[
                { value: "0.02", label: "$0.02+", hint: "show everything" },
                { value: "0.04", label: "$0.04+", hint: "default · noise filtered" },
                { value: "0.07", label: "$0.07+", hint: "cleaner signal" },
                { value: "0.10", label: "$0.10+", hint: "only the obvious" },
              ]}
            />
          </div>
          <div className="block">
            <label className="q-label">Coverage</label>
            <div className="flex items-center gap-2 h-[1.875rem]">
              <CoinIcon ticker="BTC" size={16} />
              <CoinIcon ticker="ETH" size={16} />
              <CoinIcon ticker="SOL" size={16} />
              <span className="font-mono text-xs text-base-content/60 ml-2">
                5m · 15m · 1h · 4h · Daily
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Status */}
      {error && (
        <div className="alert alert-error">
          <AlertTriangle size={16} />
          <span>Live scan failed: {error}</span>
        </div>
      )}

      {/* Opportunity table */}
      {loading && !data ? (
        <div className="opacity-70 text-center py-8">Scanning live books…</div>
      ) : data && data.opportunities.length === 0 ? (
        <EmptyState as_of={data.as_of} min_edge_pp={data.min_edge_pp} />
      ) : data ? (
        <OpportunityTable rows={data.opportunities} />
      ) : null}

      {/* Footer disclosure */}
      <div className="text-xs text-base-content/50 px-3 py-2 border-t border-base-300/40">
        <strong className="text-base-content/70">Honest disclosure:</strong>{" "}
        the &quot;Net EV&quot; column shows expected PnL per share after the
        Polymarket 2026 taker fee but{" "}
        <em>before</em> Polygon gas (~$0.10-0.30 per trade), execution lag
        (5-30 s between detection and order placement), and adverse selection
        (faster bots usually win when the underlying just moved). Realised
        returns will be lower than the model says — typically 40-60% of model
        EV. Paper-trade in PolyQuantLab&apos;s Paper Trading before going live
        with real funds.
      </div>
    </div>
  );
}

/* ─── Sub-components ────────────────────────────────────────────── */

function LivePulse({
  paused,
  error,
  lastFetched,
}: {
  paused: boolean;
  error: boolean;
  lastFetched: number;
}) {
  const [ago, setAgo] = useState("—");
  useEffect(() => {
    if (!lastFetched) return;
    const update = () => {
      const s = Math.round((Date.now() - lastFetched) / 1000);
      setAgo(`${s}s ago`);
    };
    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [lastFetched]);
  const tone = error
    ? "text-error"
    : paused
      ? "text-base-content/40"
      : "text-primary";
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] ${tone}`}>
      <span className="relative flex h-1.5 w-1.5">
        {!paused && !error && (
          <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
        )}
        <span
          className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
            error ? "bg-error" : paused ? "bg-base-content/40" : "bg-primary"
          }`}
        />
      </span>
      <span>{paused ? "paused" : error ? "error" : `live · ${ago}`}</span>
    </span>
  );
}

function EmptyState({
  as_of,
  min_edge_pp,
}: {
  as_of: string;
  min_edge_pp: number;
}) {
  return (
    <div className="rounded-lg border border-base-300/60 bg-base-200/30 p-8 text-center space-y-2">
      <div className="text-2xl">🌊</div>
      <div className="font-semibold">Books are tight right now</div>
      <p className="text-sm text-base-content/60 max-w-md mx-auto leading-relaxed">
        No opportunities clear the{" "}
        <strong>${min_edge_pp.toFixed(2)}-per-share</strong> threshold at{" "}
        <span className="font-mono">
          {new Date(as_of).toLocaleTimeString()}
        </span>
        . Polymarket bots usually reprice within seconds of an underlying
        move — most opportunities only appear when BTC/ETH/SOL is moving
        fast and the bots lag. Stay on this page; the scanner will surface
        rows as soon as something opens up.
      </p>
      <p className="text-xs text-base-content/40 mt-3">
        Try lowering the threshold to <strong>$0.02</strong> to see marginal
        opportunities (educational — these are mostly eaten by fees).
      </p>
    </div>
  );
}

function OpportunityTable({ rows }: { rows: ArbOpportunity[] }) {
  return (
    <div className="q-panel">
      <header className="q-panel-header">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="shrink-0 text-success" aria-hidden>
            <Zap size={16} strokeWidth={2} />
          </span>
          <h3 className="q-section-title truncate">
            {rows.length} opportunit{rows.length === 1 ? "y" : "ies"}
          </h3>
        </div>
        <span className="q-section-subtitle">
          sorted by net EV per share
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Market</th>
              <th className="text-right">τ</th>
              <th className="text-right">Spot vs Strike</th>
              <th className="text-right">Model</th>
              <th>Direction</th>
              <th className="text-right">Fill</th>
              <th className="text-right">Spread</th>
              <th className="text-right">Fee</th>
              <th className="text-right">Net EV / share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <OpportunityRow key={o.market_id} o={o} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OpportunityRow({ o }: { o: ArbOpportunity }) {
  const deltaPct = ((o.underlying_now - o.strike_price) / o.strike_price) * 100;
  const deltaSign = deltaPct >= 0 ? "+" : "";
  const deltaTone = deltaPct >= 0 ? "text-success" : "text-error";
  const isBuyYes = o.direction === "BUY_YES";
  return (
    <tr className="hover:bg-base-200/40">
      <td>
        <div className="flex items-center gap-2">
          <CoinIcon ticker={o.ticker} size={16} />
          <div className="flex flex-col">
            <span className="font-mono text-xs font-medium">{o.event_type}</span>
            <span className="font-mono text-[10px] text-base-content/40">
              {o.market_id.slice(0, 10)}…
            </span>
          </div>
        </div>
      </td>
      <td className="text-right tabular-nums font-mono text-xs">
        <span className="inline-flex items-center gap-1">
          <Clock size={11} className="text-base-content/40" />
          {formatTau(o.seconds_to_resolution)}
        </span>
      </td>
      <td className="text-right tabular-nums font-mono text-xs">
        <div className="flex flex-col items-end leading-tight">
          <span>
            ${o.underlying_now.toFixed(2)}{" "}
            <span className="text-base-content/30">/</span>{" "}
            <span className="text-base-content/60">
              ${o.strike_price.toFixed(2)}
            </span>
          </span>
          <span className={`text-[10px] ${deltaTone}`}>
            {deltaSign}
            {deltaPct.toFixed(2)}%
          </span>
        </div>
      </td>
      <td className="text-right tabular-nums font-mono text-xs">
        <div className="flex flex-col items-end leading-tight">
          <span className="text-base-content/80">
            {(o.model_yes_prob * 100).toFixed(1)}%
          </span>
          <span className="text-[10px] text-base-content/40">
            σ_τ {(o.sigma_tau * 100).toFixed(2)}%
          </span>
        </div>
      </td>
      <td>
        <span
          className={`badge badge-sm gap-1 ${
            isBuyYes ? "badge-success" : "badge-error"
          }`}
        >
          {isBuyYes ? (
            <ArrowUpRight size={11} strokeWidth={2.5} />
          ) : (
            <ArrowDownRight size={11} strokeWidth={2.5} />
          )}
          {isBuyYes ? "BUY YES" : "BUY NO"}
        </span>
      </td>
      <td className="text-right tabular-nums font-mono text-xs">
        ${o.fill_price.toFixed(3)}
      </td>
      <td className="text-right tabular-nums font-mono text-xs text-base-content/60">
        {(o.fill_spread * 100).toFixed(1)}¢
      </td>
      <td className="text-right tabular-nums font-mono text-xs text-base-content/60">
        ${o.est_fee_per_share.toFixed(3)}
      </td>
      <td className="text-right">
        <div className="flex items-center justify-end gap-1.5">
          <Activity size={12} className="text-success/60" />
          <span className="font-mono tabular-nums text-success font-semibold">
            +${o.expected_pnl_per_share.toFixed(3)}
          </span>
        </div>
      </td>
    </tr>
  );
}

function formatTau(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d`;
}
