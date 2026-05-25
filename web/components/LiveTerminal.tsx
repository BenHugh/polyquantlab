"use client";

/**
 * Live Terminal — the dashboard's at-a-glance view of currently-trading
 * Polymarket Up/Down markets vs. the underlying Binance spot price.
 *
 * Three areas:
 *   - Top:    ticker selector + connection-status pill
 *   - Left:   one card per timeframe (5m/15m/1h/4h/daily) with UP/DOWN
 *             prices, spread, mid, and top-5 levels of each order book
 *   - Right:  Binance spot big-number + last-hour mini line, then a
 *             stream of recent Polymarket trades
 *
 * Refresh every 5 s by polling /api/polymarket/live-board and
 * /api/polymarket/recent-trades. WebSocket streaming is a Phase L+
 * polish item; 5 s polling is fine because the underlying collector
 * already runs at 8 snapshots/sec/market server-side — we're just
 * sampling the latest snapshot once every 5 s for the UI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Ticker = "BTC" | "ETH" | "SOL";

interface OrderbookLevel {
  price: number;
  size: number;
}

interface Board {
  event_type: string;
  market_id: string;
  slug: string;
  question: string;
  outcome: string;
  resolution_at: string | null;
  time_to_resolution_s: number | null;
  snapshot_ts: string;
  mid_yes: number | null;
  mid_no: number | null;
  best_yes_bid: number | null;
  best_yes_ask: number | null;
  best_no_bid: number | null;
  best_no_ask: number | null;
  spread_yes: number | null;
  spread_no: number | null;
  last_trade_yes_price: number | null;
  last_trade_no_price: number | null;
  last_trade_ts: string | null;
  underlying_price: number | null;
  orderbook_up: { bids: OrderbookLevel[]; asks: OrderbookLevel[] };
  orderbook_down: { bids: OrderbookLevel[]; asks: OrderbookLevel[] };
}

interface LiveBoardResponse {
  ticker: Ticker;
  as_of: string;
  boards: Board[];
}

interface Trade {
  trade_id: string;
  market_id: string;
  slug: string;
  event_type: string;
  outcome: string;
  ts: string;
  side: string; // BUY_YES | SELL_YES | BUY_NO | SELL_NO
  price: number;
  size: number;
  notional_usd: number;
}

interface TradesResponse {
  ticker: Ticker;
  count: number;
  trades: Trade[];
}

interface CalibrationBucket {
  lo: number;
  hi: number;
  n_markets: number;
  up_rate: number | null;
  mean_mid: number | null;
}

interface CalibrationResponse {
  n_markets: number;
  buckets: CalibrationBucket[];
}

const REFRESH_MS = 5_000;
const CALIBRATION_BUCKETS = 20;
// A bucket needs at least this many historical markets before we'll
// surface a mispricing badge from it — otherwise small-sample noise
// can mislabel any one current market.
const MIN_BUCKET_N = 10;
// Mispricing threshold in percentage points (mid_yes vs historical Up rate).
const MISPRICING_THRESHOLD_PP = 5;

const EVENT_TYPE_ORDER: string[] = ["5m", "15m", "1h", "4h", "daily_up_down"];
const EVENT_TYPE_LABEL: Record<string, string> = {
  "5m": "5M",
  "15m": "15M",
  "1h": "1H",
  "4h": "4H",
  daily_up_down: "Daily",
};

export default function LiveTerminal() {
  const [ticker, setTicker] = useState<Ticker>("BTC");
  const [board, setBoard] = useState<LiveBoardResponse | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [calibration, setCalibration] = useState<CalibrationBucket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastTick, setLastTick] = useState<number>(0);

  const inflight = useRef(false);

  // Calibration is computed across the last ~500 resolved markets for the
  // ticker (server-side ~1s). We fetch once per ticker change and cache it
  // in component state — historical Up-rate by mid bucket changes on the
  // hour, not on the 5-second polling interval.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/stats/calibration?ticker=${ticker}&buckets=${CALIBRATION_BUCKETS}&max_markets=500`,
          { cache: "no-store" },
        );
        if (!r.ok) throw new Error(`calibration ${r.status}`);
        const data: CalibrationResponse = await r.json();
        if (!cancelled) setCalibration(data.buckets || []);
      } catch {
        // Mispricing overlay is best-effort — silently degrade rather
        // than block the page on calibration failure.
        if (!cancelled) setCalibration([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const fetchAll = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const [b, t] = await Promise.all([
        fetch(`/api/polymarket/live-board?ticker=${ticker}`, { cache: "no-store" }),
        fetch(`/api/polymarket/recent-trades?ticker=${ticker}&limit=40`, { cache: "no-store" }),
      ]);
      if (!b.ok) throw new Error(`live-board ${b.status}`);
      if (!t.ok) throw new Error(`recent-trades ${t.status}`);
      const boardData: LiveBoardResponse = await b.json();
      const tradesData: TradesResponse = await t.json();
      setBoard(boardData);
      setTrades(tradesData.trades || []);
      setError(null);
      setLastTick(Date.now());
    } catch (e: any) {
      setError(e?.message || "fetch failed");
    } finally {
      inflight.current = false;
    }
  }, [ticker]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchAll]);

  const orderedBoards = useMemo(() => {
    if (!board) return [];
    const byType: Record<string, Board> = {};
    for (const b of board.boards) byType[b.event_type] = b;
    return EVENT_TYPE_ORDER.map((t) => byType[t]).filter(Boolean);
  }, [board]);

  return (
    <div className="space-y-4">
      {/* Top control bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="join">
          {(["BTC", "ETH", "SOL"] as Ticker[]).map((t) => (
            <button
              key={t}
              onClick={() => setTicker(t)}
              className={`join-item btn btn-sm ${
                ticker === t ? "btn-primary" : "btn-ghost"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-base-content/60">
          <span
            className={`inline-flex items-center gap-1.5 ${
              error ? "text-error" : "text-primary"
            }`}
          >
            <span className="relative flex h-1.5 w-1.5">
              {!error && (
                <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
              )}
              <span
                className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
                  error ? "bg-error" : "bg-primary"
                }`}
              />
            </span>
            {error ? "Reconnecting…" : "Live"}
          </span>
          <span className="font-mono">
            {lastTick ? new Date(lastTick).toLocaleTimeString() : "—"}
          </span>
        </div>
      </div>

      {error && (
        <div className="alert alert-error text-sm py-2">
          <span>{error}</span>
        </div>
      )}

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Left: Polymarket cards (3/5 cols on desktop) */}
        <div className="lg:col-span-3 space-y-4">
          {orderedBoards.length === 0 ? (
            <div className="rounded-xl border border-base-300 bg-base-200/30 p-10 text-center text-sm text-base-content/60">
              No currently-trading markets for {ticker}.
            </div>
          ) : (
            orderedBoards.map((b) => (
              <BoardCard
                key={b.market_id}
                board={b}
                mispricing={computeMispricing(
                  b.last_trade_yes_price ?? b.mid_yes,
                  calibration,
                )}
              />
            ))
          )}
        </div>

        {/* Right: Binance + recent trades (2/5 cols on desktop) */}
        <div className="lg:col-span-2 space-y-4">
          <UnderlyingPanel
            ticker={ticker}
            currentPrice={orderedBoards[0]?.underlying_price ?? null}
          />
          <RecentTradesPanel trades={trades} />
        </div>
      </div>
    </div>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────── */

function BoardCard({
  board,
  mispricing,
}: {
  board: Board;
  mispricing: MispricingResult | null;
}) {
  const label = EVENT_TYPE_LABEL[board.event_type] ?? board.event_type;
  return (
    <div className="rounded-xl border border-base-300 bg-base-200/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-base-300 bg-base-200/40 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="badge badge-sm badge-primary">{label}</span>
          <span className="text-xs font-mono text-base-content/60 truncate">
            {board.question}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {mispricing && <MispricingBadge result={mispricing} />}
          <span className="text-xs font-mono text-base-content/50">
            {formatTimeToResolution(board.time_to_resolution_s)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 divide-x divide-base-300">
        <SideBlock
          label="UP"
          lastTrade={board.last_trade_yes_price}
          mid={board.mid_yes}
          bestBid={board.best_yes_bid}
          bestAsk={board.best_yes_ask}
          spread={board.spread_yes}
          book={board.orderbook_up}
          tone="primary"
        />
        <SideBlock
          label="DOWN"
          lastTrade={board.last_trade_no_price}
          mid={board.mid_no}
          bestBid={board.best_no_bid}
          bestAsk={board.best_no_ask}
          spread={board.spread_no}
          book={board.orderbook_down}
          tone="error"
        />
      </div>
    </div>
  );
}

function SideBlock({
  label,
  lastTrade,
  mid,
  bestBid,
  bestAsk,
  spread,
  book,
  tone,
}: {
  label: string;
  lastTrade: number | null;
  mid: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  book: { bids: OrderbookLevel[]; asks: OrderbookLevel[] };
  tone: "primary" | "error";
}) {
  const accent = tone === "primary" ? "text-primary" : "text-error";
  // Headline preference: a recent trade (last 60 s) is the truest signal
  // of where the market is actually transacting. Mid-of-book is a
  // mathematical artifact when the book is wide (stale far-edge orders
  // at 10¢ + 90¢ produce mid=50¢ that nobody is actually trading at),
  // so we only fall back to it when no recent trade exists.
  const headline = lastTrade ?? mid;
  const headlineSrc = lastTrade !== null ? "LTP" : "mid";
  const isWide = spread !== null && spread > 0.1;
  return (
    <div className="p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className={`text-[10px] font-mono uppercase tracking-widest ${accent}`}>
          {label} token
        </span>
        <span
          className={`text-[10px] font-mono ${isWide ? "text-warning" : "text-base-content/40"}`}
          title={isWide ? "Order book is wide — no tight quotes on either side right now." : undefined}
        >
          {headlineSrc} · spread {spread !== null ? `${(spread * 100).toFixed(1)}¢` : "—"}
        </span>
      </div>
      <div className={`font-bold text-3xl tracking-tight tabular-nums ${accent}`}>
        {headline !== null ? headline.toFixed(2) : "—"}
      </div>
      <div className="mt-1 text-[11px] font-mono text-base-content/50 flex gap-3">
        <span>
          BID{" "}
          <span className="text-base-content/80">
            {bestBid !== null ? bestBid.toFixed(2) : "—"}
          </span>
        </span>
        <span>
          ASK{" "}
          <span className="text-base-content/80">
            {bestAsk !== null ? bestAsk.toFixed(2) : "—"}
          </span>
        </span>
      </div>
      <div className="mt-3">
        <BookMini bids={book.bids} asks={book.asks} />
      </div>
    </div>
  );
}

function BookMini({ bids, asks }: { bids: OrderbookLevel[]; asks: OrderbookLevel[] }) {
  const rows = 5;
  const a = asks.slice(0, rows).reverse(); // best-ask at bottom of asks
  const b = bids.slice(0, rows);
  const maxSize = Math.max(
    ...[...a, ...b].map((l) => l.size),
    1,
  );
  return (
    <div className="font-mono text-[11px] space-y-px">
      {a.map((l, i) => (
        <BookRow key={`a${i}`} level={l} maxSize={maxSize} tone="error" />
      ))}
      <div className="h-px bg-base-300 my-1" />
      {b.map((l, i) => (
        <BookRow key={`b${i}`} level={l} maxSize={maxSize} tone="primary" />
      ))}
    </div>
  );
}

function BookRow({
  level,
  maxSize,
  tone,
}: {
  level: OrderbookLevel;
  maxSize: number;
  tone: "primary" | "error";
}) {
  const pct = Math.min(100, (level.size / maxSize) * 100);
  const bar =
    tone === "primary" ? "bg-primary/15" : "bg-error/15";
  const text =
    tone === "primary" ? "text-primary" : "text-error";
  return (
    <div className="relative flex justify-between px-1">
      <div
        className={`absolute inset-y-0 right-0 ${bar}`}
        style={{ width: `${pct}%` }}
      />
      <span className={`relative ${text}`}>
        {(level.price * 100).toFixed(0)}¢
      </span>
      <span className="relative text-base-content/60">
        {Math.round(level.size).toLocaleString("en-US")}
      </span>
    </div>
  );
}

function UnderlyingPanel({
  ticker,
  currentPrice,
}: {
  ticker: Ticker;
  currentPrice: number | null;
}) {
  // Binance sparkline / chart is a Phase L+ polish item — the big number
  // sourced from the live-board's most-recent snapshot is enough for v1
  // to convey "this is the underlying tape we're benchmarking against".
  return (
    <div className="rounded-xl border border-base-300 bg-base-200/30 p-5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-base-content/40 mb-1">
        Binance spot · {ticker}/USDT
      </div>
      <div className="text-3xl font-bold tracking-tight tabular-nums">
        {currentPrice !== null
          ? `$${currentPrice.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`
          : "—"}
      </div>
      <div className="text-xs text-base-content/40 mt-2 font-mono">
        Sourced from the latest Polymarket snapshot — same underlying tape used
        for backtest calibration.
      </div>
    </div>
  );
}

function RecentTradesPanel({ trades }: { trades: Trade[] }) {
  return (
    <div className="rounded-xl border border-base-300 bg-base-200/30 overflow-hidden">
      <div className="px-4 py-2 border-b border-base-300 bg-base-200/40 text-[10px] font-mono uppercase tracking-widest text-base-content/60">
        Recent trades · last 60 min
      </div>
      <div className="max-h-[480px] overflow-y-auto">
        {trades.length === 0 ? (
          <div className="p-6 text-center text-xs text-base-content/40">
            No trades yet.
          </div>
        ) : (
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-base-content/40 uppercase tracking-wider text-[9px]">
                <th className="px-3 py-1.5 text-left">Time</th>
                <th className="px-2 py-1.5 text-left">TF</th>
                <th className="px-2 py-1.5 text-left">Side</th>
                <th className="px-2 py-1.5 text-right">Price</th>
                <th className="px-2 py-1.5 text-right">Size</th>
                <th className="px-3 py-1.5 text-right">$</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const action = t.side.startsWith("BUY") ? "BUY" : "SELL";
                const token = t.side.endsWith("_YES") ? "UP" : "DOWN";
                const actionColor =
                  action === "BUY" ? "text-primary" : "text-error";
                const tokenColor =
                  token === "UP" ? "text-primary/80" : "text-error/80";
                return (
                  <tr
                    key={t.trade_id}
                    className="border-t border-base-300/40 hover:bg-base-300/40"
                  >
                    <td className="px-3 py-1 text-base-content/60">
                      {formatHmsMillis(t.ts)}
                    </td>
                    <td className="px-2 py-1 text-base-content/50">
                      {EVENT_TYPE_LABEL[t.event_type] ?? t.event_type}
                    </td>
                    <td className="px-2 py-1">
                      <span className={actionColor}>{action}</span>{" "}
                      <span className={tokenColor}>{token}</span>
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {t.price.toFixed(2)}
                    </td>
                    <td className="px-2 py-1 text-right text-base-content/60 tabular-nums">
                      ×{t.size.toFixed(2)}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums">
                      ${t.notional_usd.toFixed(0)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ─── Mispricing overlay ─────────────────────────────────────────── */

interface MispricingResult {
  /** Historical Up-rate for the bucket the current mid_yes falls in. */
  upRate: number;
  /** Sample size for the bucket — only show if reasonably large. */
  n: number;
  /** Signed pp difference: positive = market under-pricing Up, negative = over-pricing. */
  edgePp: number;
}

function computeMispricing(
  midYes: number | null,
  buckets: CalibrationBucket[],
): MispricingResult | null {
  if (midYes === null || buckets.length === 0) return null;
  const bucket = buckets.find((b) => midYes >= b.lo && midYes < b.hi);
  if (!bucket || bucket.up_rate === null || bucket.n_markets < MIN_BUCKET_N) {
    return null;
  }
  const edgePp = (bucket.up_rate - midYes) * 100;
  if (Math.abs(edgePp) < MISPRICING_THRESHOLD_PP) return null;
  return { upRate: bucket.up_rate, n: bucket.n_markets, edgePp };
}

function MispricingBadge({ result }: { result: MispricingResult }) {
  const sign = result.edgePp >= 0 ? "+" : "";
  const tone =
    result.edgePp >= 0
      ? "border-primary/40 text-primary bg-primary/10"
      : "border-error/40 text-error bg-error/10";
  const direction = result.edgePp >= 0 ? "UP under-priced" : "UP over-priced";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono ${tone}`}
      title={`Historical Up rate at this implied probability: ${(result.upRate * 100).toFixed(1)}% across ${result.n} resolved markets. ${direction} by ${Math.abs(result.edgePp).toFixed(1)}pp.`}
    >
      <span>Edge</span>
      <span className="tabular-nums">
        {sign}
        {result.edgePp.toFixed(1)}pp
      </span>
    </span>
  );
}

/* ─── Format helpers ─────────────────────────────────────────────── */

function formatTimeToResolution(secs: number | null): string {
  if (secs === null || secs < 0) return "—";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatHmsMillis(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
