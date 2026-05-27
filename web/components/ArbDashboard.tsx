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
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Clock, Filter, Zap } from "lucide-react";
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
  tier: "stable" | "stale";
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
  const [tierFilter, setTierFilter] = useState<"all" | "stable" | "stale">("stable");
  const [tickerFilter, setTickerFilter] = useState<"all" | "BTC" | "ETH" | "SOL">("all");
  const [paused, setPaused] = useState(false);
  const [lastFetched, setLastFetched] = useState<number>(0);

  const fetchArb = useCallback(async () => {
    try {
      // limit raised from 50 → 200: BTC alone often saturates 50, so
      // ETH/SOL get truncated. 200 gives enough headroom across all
      // 3 tickers + 5 timeframes without straining the engine
      // (typical scan time stays under 600ms even at 200).
      const params = new URLSearchParams({
        min_edge_pp: String(minEdgePp),
        limit: "200",
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
        <OpportunityTable
          rows={data.opportunities}
          tierFilter={tierFilter}
          onTierFilterChange={setTierFilter}
          tickerFilter={tickerFilter}
          onTickerFilterChange={setTickerFilter}
        />
      ) : null}

      {/* Footer disclosure */}
      <div className="text-xs text-base-content/50 px-3 py-2 border-t border-base-300/40 space-y-2">
        <div>
          <span className="inline-flex items-center gap-1 font-mono text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success inline-block" />
            STABLE
          </span>{" "}
          rows have a fill price between $0.30 and $0.85 — sitting at the
          Polymarket maker-bot default book zone. These typically persist
          30+ seconds and are realistically fillable.{" "}
          <span className="inline-flex items-center gap-1 font-mono text-warning">
            <span className="h-1.5 w-1.5 rounded-full bg-warning inline-block" />
            STALE
          </span>{" "}
          rows are deep mispricings (fill &lt; $0.30) — model says huge edge,
          but HFT bots usually arb these in milliseconds. Treat them as
          educational data, not executable trades.
        </div>
        <div>
          <strong className="text-base-content/70">Net EV caveats:</strong>{" "}
          the &quot;Net EV&quot; column shows expected PnL per share after
          the Polymarket 2026 taker fee but <em>before</em> Polygon gas
          (~$0.10-0.30 per trade), execution lag (5-30 s between detection
          and order placement), and adverse selection. Realised returns
          typically 40-60% of model EV.
        </div>
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

function OpportunityTable({
  rows,
  tierFilter,
  onTierFilterChange,
  tickerFilter,
  onTickerFilterChange,
}: {
  rows: ArbOpportunity[];
  tierFilter: "all" | "stable" | "stale";
  onTierFilterChange: (v: "all" | "stable" | "stale") => void;
  tickerFilter: "all" | "BTC" | "ETH" | "SOL";
  onTickerFilterChange: (v: "all" | "BTC" | "ETH" | "SOL") => void;
}) {
  // Apply ticker filter first (cheaper, fewer rows for tier counts to walk)
  const tickerFiltered =
    tickerFilter === "all"
      ? rows
      : rows.filter((r) => r.ticker === tickerFilter);
  const stableCount = tickerFiltered.filter((r) => r.tier === "stable").length;
  const staleCount = tickerFiltered.filter((r) => r.tier === "stale").length;
  const filtered = tickerFiltered.filter(
    (r) => tierFilter === "all" || r.tier === tierFilter,
  );

  // Per-ticker counts for the ticker filter pills — count from ALL rows
  // (not tier-filtered) so the user knows the underlying coverage even
  // when narrowed to stable/stale.
  const tickerCounts = {
    BTC: rows.filter((r) => r.ticker === "BTC").length,
    ETH: rows.filter((r) => r.ticker === "ETH").length,
    SOL: rows.filter((r) => r.ticker === "SOL").length,
  };

  return (
    <div className="q-panel">
      <header className="q-panel-header flex-wrap gap-y-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="shrink-0 text-success" aria-hidden>
            <Zap size={16} strokeWidth={2} />
          </span>
          <h3 className="q-section-title truncate">
            {filtered.length} opportunit{filtered.length === 1 ? "y" : "ies"}
          </h3>
        </div>
        <div className="flex items-center gap-3 shrink-0 flex-wrap">
          {/* Ticker filter — pills, default "all" so user sees full coverage */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onTickerFilterChange("all")}
              className={`btn btn-xs gap-1.5 ${tickerFilter === "all" ? "btn-primary" : "btn-ghost"}`}
              title="Show all tickers"
            >
              All
              <span className="font-mono text-[10px] opacity-70">{rows.length}</span>
            </button>
            {(["BTC", "ETH", "SOL"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTickerFilterChange(t)}
                className={`btn btn-xs gap-1.5 ${tickerFilter === t ? "btn-primary" : "btn-ghost"}`}
                title={`Show ${t} opportunities only`}
              >
                <CoinIcon ticker={t} size={12} />
                <span className="font-mono text-[10px] opacity-70">{tickerCounts[t]}</span>
              </button>
            ))}
          </div>
          {/* Tier filter — separate from ticker so users can compose */}
          <div className="flex items-center gap-1 border-l border-base-300/60 pl-3">
            <TierToggleButton
              label="Stable"
              count={stableCount}
              active={tierFilter === "stable"}
              onClick={() => onTierFilterChange("stable")}
              dotClass="bg-success"
              title="Fill price between 0.30 and 0.85 — sitting at the maker-default book; tends to persist 30+ seconds and is actually fillable."
            />
            <TierToggleButton
              label="Stale"
              count={staleCount}
              active={tierFilter === "stale"}
              onClick={() => onTierFilterChange("stale")}
              dotClass="bg-warning"
              title="Deep mispricings (fill < 0.30). HFT bots usually arb these in milliseconds — likely gone by the time you click."
            />
            <TierToggleButton
              label="All"
              count={tickerFiltered.length}
              active={tierFilter === "all"}
              onClick={() => onTierFilterChange("all")}
              dotClass="bg-base-content/40"
              title="Show every opportunity that cleared engine filters."
            />
          </div>
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Market</th>
              <th>Tier</th>
              <th className="text-right">τ</th>
              <th className="text-right">Spot vs Strike</th>
              <th className="text-right">Model</th>
              <th>Direction</th>
              <th className="text-right">Fill</th>
              <th className="text-right">Spread</th>
              <th className="text-right">Fee</th>
              <th className="text-right">
                <span
                  className="cursor-help border-b border-dashed border-base-content/30"
                  title="Per-share expected profit according to the model: (1 − P_model) − fill_price − fee. This is an UPPER BOUND, not realised return. Polygon gas, execution lag, and adverse selection typically reduce realised return to 40-60% of this number. Verify with paper trading before going live."
                >
                  Model Net EV
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((o) => (
              <OpportunityRow key={o.market_id} o={o} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TierToggleButton({
  label,
  count,
  active,
  onClick,
  dotClass,
  title,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dotClass: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`btn btn-xs gap-1.5 ${active ? "btn-primary" : "btn-ghost"}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
      <span>{label}</span>
      <span className="font-mono text-[10px] opacity-70">{count}</span>
    </button>
  );
}

function OpportunityRow({ o }: { o: ArbOpportunity }) {
  const deltaPct = ((o.underlying_now - o.strike_price) / o.strike_price) * 100;
  const deltaSign = deltaPct >= 0 ? "+" : "";
  const deltaTone = deltaPct >= 0 ? "text-success" : "text-error";
  const isBuyYes = o.direction === "BUY_YES";
  const isStable = o.tier === "stable";
  return (
    <tr className={`hover:bg-base-200/40 ${o.tier === "stale" ? "opacity-70" : ""}`}>
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
      <td>
        <span
          className={`inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide ${
            isStable ? "text-success" : "text-warning"
          }`}
          title={
            isStable
              ? "Fill is at the maker-default book zone — survives 30+ seconds."
              : "Deep mispricing — likely already arbed by HFT bots."
          }
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              isStable ? "bg-success" : "bg-warning"
            }`}
          />
          {isStable ? "STABLE" : "STALE"}
        </span>
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
        <div className="flex flex-col items-end leading-tight">
          <span className="font-mono tabular-nums text-success font-semibold">
            +${o.expected_pnl_per_share.toFixed(3)}
          </span>
          <span className="text-[10px] text-base-content/40 font-mono">
            model · before gas
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
