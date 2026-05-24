"use client";

import ExportButtons from "@/components/ExportButtons";
import { formatDateTime as formatDate } from "@/libs/formatDate";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

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
  // Optional underlying-price enrichment (when ?with_underlying=true).
  // `underlying_delta_pct` = (end-start)/start × 100, in percent.
  underlying_start?: number | null;
  underlying_end?: number | null;
  underlying_delta_pct?: number | null;
}

const TICKERS = ["ALL", "BTC", "ETH", "SOL"] as const;
type TickerFilter = (typeof TICKERS)[number];

// Up/Down binary markets only (intentional product scope — matches
// PolyBackTest). Bracket / price-target markets are NOT collected;
// see collector/discovery.py:WINDOW_TAG_TO_TYPE for rationale.
const EVENT_TYPES = ["ALL", "5m", "15m", "1h", "4h", "daily_up_down"] as const;
type EventTypeFilter = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_LABELS: Record<EventTypeFilter, string> = {
  ALL: "ALL",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  daily_up_down: "Daily",
};

export default function MarketsTable({
  initial,
}: {
  initial: ResolvedMarket[];
}) {
  const [ticker, setTicker] = useState<TickerFilter>("ALL");
  const [eventType, setEventType] = useState<EventTypeFilter>("ALL");
  const [markets, setMarkets] = useState<ResolvedMarket[]>(initial);
  const [loading, setLoading] = useState(false);
  // Client-side fuzzy search across the currently-loaded set. We don't
  // round-trip to the API for this — 500 rows is trivially filterable in
  // the browser, and instant feedback is way better UX than typing →
  // wait → see results. Trade-off: if a user searches for text that only
  // appears in old (>500) markets, they'd need to widen the filter first.
  const [search, setSearch] = useState("");

  // Memoise the search result so React doesn't re-filter when unrelated
  // state changes (e.g. loading flag flipping during a re-fetch).
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return markets;
    return markets.filter((m) => {
      const hay = `${m.question ?? ""} ${m.slug ?? ""} ${m.market_id}`.toLowerCase();
      return hay.includes(q);
    });
  }, [markets, search]);

  // Re-fetch from the proxy whenever any filter changes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const qs = new URLSearchParams({
          limit: "500",
          with_underlying: "true",
        });
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
      {/* Search box — instant client-side filter across question/slug/id */}
      <div className="form-control">
        <input
          type="text"
          className="input input-bordered w-full"
          placeholder="Search by question, slug, or market id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

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
                  {EVENT_TYPE_LABELS[t]}
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
              <th className="text-right">Underlying Δ</th>
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
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-8 opacity-60">
                  {search
                    ? `No markets match "${search}". Try widening filters or clearing the search.`
                    : "No resolved markets yet for this filter."}
                </td>
              </tr>
            )}
            {!loading &&
              visible.map((m) => {
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
                    <td
                      className={`text-right tabular-nums ${
                        typeof m.underlying_delta_pct !== "number"
                          ? "opacity-50"
                          : m.underlying_delta_pct > 0
                            ? "text-success"
                            : m.underlying_delta_pct < 0
                              ? "text-error"
                              : ""
                      }`}
                      title={
                        typeof m.underlying_start === "number" &&
                        typeof m.underlying_end === "number"
                          ? `${m.ticker} $${m.underlying_start.toFixed(2)} → $${m.underlying_end.toFixed(2)}`
                          : "No underlying data in this window"
                      }
                    >
                      {typeof m.underlying_delta_pct === "number"
                        ? `${m.underlying_delta_pct >= 0 ? "+" : ""}${m.underlying_delta_pct.toFixed(2)}%`
                        : "—"}
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
        {search
          ? `Showing ${visible.length} of ${markets.length} loaded markets matching "${search}".`
          : `Showing the ${markets.length} most-recently-resolved markets.`}{" "}
        Volume, liquidity, fill price, and PnL are computed on-demand on
        the single-market page (too expensive to aggregate across the list).
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

// Date formatting moved to libs/formatDate.ts — locale-independent so
// SSR and CSR produce byte-identical strings (no hydration mismatch).

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
