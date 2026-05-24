"use client";

import ExportButtons from "@/components/ExportButtons";
import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Shape returned by FastAPI's GET /v1/markets/resolved.
 *
 * NOTE: the list endpoint returns BASIC metadata only — no per-market
 * volume/liquidity (those need an expensive ClickHouse aggregation, so
 * they're only computed on the single-market detail endpoint). Winner
 * is derived from `resolution_outcome`.
 */
export interface ResolvedMarket {
  market_id: string;
  event_id?: string;
  ticker?: string | null;
  // The list endpoint actually returns `question` (full description)
  // and `event_type` (5m / 15m / 1h / ...). PolyBackTest's schema calls
  // these slug/market_type — we keep both for forward-compat.
  question?: string | null;
  event_type?: string | null;
  slug?: string | null;
  market_type?: string | null;
  // Winner derives from this — "Up", "Down", or null.
  resolution_outcome?: string | null;
  // Legacy/detail fields (present on /v1/markets/{id} but not on the list).
  outcome?: string | null;
  winner?: string | null;
  end_time?: string | null;
  resolution_at?: string | null;
  resolved_at?: string | null;
  final_volume?: number | null;
  final_liquidity?: number | null;
}

const TICKERS = ["ALL", "BTC", "ETH", "SOL"] as const;
type TickerFilter = (typeof TICKERS)[number];

// event_type vocabulary matches the strings used in events table
// (PolyBackTest schema: "5m", "15m", "1h", "4h", "24h").
const EVENT_TYPES = ["ALL", "5m", "15m", "1h", "4h", "24h"] as const;
type EventTypeFilter = (typeof EVENT_TYPES)[number];

export default function MarketsTable({
  initial,
}: {
  initial: ResolvedMarket[];
}) {
  const [ticker, setTicker] = useState<TickerFilter>("ALL");
  const [eventType, setEventType] = useState<EventTypeFilter>("ALL");
  const [markets, setMarkets] = useState<ResolvedMarket[]>(initial);
  const [loading, setLoading] = useState(false);

  // Re-fetch from the proxy whenever any filter changes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ limit: "500" });
        if (ticker !== "ALL") qs.set("ticker", ticker);
        if (eventType !== "ALL") qs.set("event_type", eventType);
        const res = await fetch(`/api/markets?${qs.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          console.error("markets fetch failed", res.status);
          return;
        }
        const body = await res.json();
        if (!cancelled) setMarkets(body.markets ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    // Skip the initial load — we already have SSR data when both filters
    // are at their defaults (ALL / ALL).
    if (ticker === "ALL" && eventType === "ALL" && markets === initial) return;
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, eventType]);

  return (
    <div className="space-y-4">
      {/* Filter tabs + export */}
      <div className="flex flex-wrap items-center gap-4 justify-between">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs opacity-60 uppercase tracking-wide">
              Ticker
            </span>
            <div role="tablist" className="tabs tabs-boxed">
              {TICKERS.map((t) => (
                <button
                  key={t}
                  role="tab"
                  className={`tab tab-sm ${ticker === t ? "tab-active" : ""}`}
                  onClick={() => setTicker(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs opacity-60 uppercase tracking-wide">
              Window
            </span>
            <div role="tablist" className="tabs tabs-boxed">
              {EVENT_TYPES.map((t) => (
                <button
                  key={t}
                  role="tab"
                  className={`tab tab-sm ${eventType === t ? "tab-active" : ""}`}
                  onClick={() => setEventType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
        <ExportButtons
          data={markets as unknown as Record<string, unknown>[]}
          filename={`markets-${ticker.toLowerCase()}-${eventType}-${new Date().toISOString().slice(0, 10)}`}
        />
      </div>

      <div className="rounded-lg border border-base-300 overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Market</th>
              <th>Ticker</th>
              <th>Window</th>
              <th>Resolved</th>
              <th>Winner</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="text-center py-8 opacity-60">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && markets.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-8 opacity-60">
                  No resolved markets yet for this filter.
                </td>
              </tr>
            )}
            {!loading &&
              markets.map((m) => {
                // Winner: prefer the explicit `winner` from /v1/markets/{id}
                // (used when this list is built from per-market enrichment),
                // otherwise derive from `resolution_outcome` on the list endpoint.
                const winner = m.winner || normaliseWinner(m.resolution_outcome);
                // Display name: PolyBackTest schema uses `slug`, our list endpoint
                // returns the more readable `question`. Take whichever is present.
                const label = m.question || m.slug;
                return (
                  <tr key={m.market_id} className="hover">
                    <td>
                      <div className="text-sm">
                        {label || <span className="opacity-50">untitled</span>}
                      </div>
                      <div className="font-mono text-xs opacity-50">
                        {m.market_id.slice(0, 14)}…
                      </div>
                    </td>
                    <td>
                      {m.ticker && (
                        <span className="badge badge-ghost">{m.ticker}</span>
                      )}
                    </td>
                    <td>
                      {(m.event_type || m.market_type) && (
                        <span className="badge badge-outline badge-sm">
                          {m.event_type || m.market_type}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {formatDate(m.resolved_at)}
                    </td>
                    <td>
                      {winner === "Up" && (
                        <span className="badge badge-success">Up</span>
                      )}
                      {winner === "Down" && (
                        <span className="badge badge-error">Down</span>
                      )}
                      {winner === "Inconclusive" && (
                        <span className="badge badge-warning">
                          Inconclusive
                        </span>
                      )}
                      {!winner && (
                        <span className="badge badge-ghost">—</span>
                      )}
                    </td>
                    <td>
                      <Link
                        href={`/dashboard/markets/${encodeURIComponent(m.market_id)}`}
                        className="btn btn-xs btn-outline"
                      >
                        Inspect →
                      </Link>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <p className="text-xs opacity-60">
        Showing the {markets.length} most-recently-resolved markets. Volume,
        liquidity, fill price, and PnL are computed on-demand on the
        single-market page (too expensive to aggregate across the list).
      </p>
    </div>
  );
}

/**
 * The resolution_outcome string comes off the Gamma API verbatim. Most
 * markets resolve to "Up" or "Down", but some come back as "Yes"/"No"
 * (older event types) or freeform — match the same logic the FastAPI
 * single-market endpoint uses to derive `winner`.
 */
function normaliseWinner(outcome?: string | null): string | null {
  if (!outcome) return null;
  const t = outcome.toLowerCase();
  if (t === "up" || t === "yes" || t.includes("up")) return "Up";
  if (t === "down" || t === "no" || t.includes("down")) return "Down";
  if (t.includes("inconclusive")) return "Inconclusive";
  return outcome;
}

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Force en-US locale so SSR (Node, system locale) and CSR (browser
  // locale, may be zh-CN/ja-JP/etc) produce identical strings and
  // hydration doesn't flag a mismatch.
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMoney(n?: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

function formatNumber(n?: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}
