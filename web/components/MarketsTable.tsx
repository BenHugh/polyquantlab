"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Shape returned by FastAPI's GET /v1/markets/resolved.
 * Field names follow the PolyBackTest schema for compat (slug, ticker,
 * market_type, end_time, resolved_at). We loosen to optional everywhere
 * so partial rows don't crash the table.
 */
export interface ResolvedMarket {
  market_id: string;
  event_id?: string;
  slug?: string | null;
  ticker?: string | null;
  market_type?: string | null;
  outcome?: string | null;
  winner?: string | null;
  end_time?: string | null;
  resolved_at?: string | null;
  final_volume?: number | null;
  final_liquidity?: number | null;
}

const TICKERS = ["ALL", "BTC", "ETH", "SOL"] as const;
type TickerFilter = (typeof TICKERS)[number];

export default function MarketsTable({
  initial,
}: {
  initial: ResolvedMarket[];
}) {
  const [ticker, setTicker] = useState<TickerFilter>("ALL");
  const [markets, setMarkets] = useState<ResolvedMarket[]>(initial);
  const [loading, setLoading] = useState(false);

  // Re-fetch from the proxy whenever the ticker filter changes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ limit: "200" });
        if (ticker !== "ALL") qs.set("ticker", ticker);
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
    // Skip the initial load — we already have SSR data for "ALL".
    if (ticker === "ALL" && markets === initial) return;
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  return (
    <div className="space-y-4">
      {/* Filter tabs */}
      <div role="tablist" className="tabs tabs-boxed w-fit">
        {TICKERS.map((t) => (
          <button
            key={t}
            role="tab"
            className={`tab ${ticker === t ? "tab-active" : ""}`}
            onClick={() => setTicker(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-base-300 overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Market</th>
              <th>Ticker</th>
              <th>Resolved</th>
              <th>Winner</th>
              <th className="text-right">Volume</th>
              <th className="text-right">Liquidity</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="text-center py-8 opacity-60">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && markets.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-8 opacity-60">
                  No resolved markets yet for this filter.
                </td>
              </tr>
            )}
            {!loading &&
              markets.map((m) => (
                <tr key={m.market_id} className="hover">
                  <td>
                    <div className="font-mono text-xs opacity-70">
                      {m.market_id.slice(0, 12)}…
                    </div>
                    <div className="text-sm">
                      {m.slug || <span className="opacity-50">no slug</span>}
                    </div>
                  </td>
                  <td>
                    {m.ticker && (
                      <span className="badge badge-ghost">{m.ticker}</span>
                    )}
                  </td>
                  <td>{formatDate(m.resolved_at)}</td>
                  <td>
                    {m.winner === "Up" && (
                      <span className="badge badge-success">Up</span>
                    )}
                    {m.winner === "Down" && (
                      <span className="badge badge-error">Down</span>
                    )}
                    {!m.winner && (
                      <span className="badge badge-ghost">—</span>
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatMoney(m.final_volume)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatNumber(m.final_liquidity)}
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
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
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
