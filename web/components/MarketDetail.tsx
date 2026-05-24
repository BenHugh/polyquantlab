"use client";

/**
 * Single-market inspector with three differentiating features that
 * Polymarket.com doesn't offer:
 *
 *   1. Dual-axis chart — Polymarket Up share overlaid on the Binance
 *      spot price for the underlying, so you can see the causal link
 *      between the market and the asset (the whole reason these markets
 *      exist).
 *
 *   2. Time scrubber — drag a slider to replay the orderbook at any
 *      historical second. Leverages our 8 snap/sec/market depth. This is
 *      our biggest single differentiator vs the free Polymarket UI.
 *
 *   3. Friendlier empty states for fields that are mathematically zero
 *      after resolution (liquidity) or unavailable because the market
 *      pre-dates our data window (underlying-at-start).
 *
 * No charting library: hand-rolled SVG keeps the bundle tiny and the
 * dual-axis layout fully under our control.
 */

import ExportButtons from "@/components/ExportButtons";
import { useEffect, useMemo, useRef, useState } from "react";

export interface MarketMeta {
  market_id: string;
  event_id?: string;
  slug?: string | null;
  market_type?: string | null;
  ticker?: string | null;
  outcome?: string | null;
  winner?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  resolved_at?: string | null;
  final_volume?: number | null;
  final_liquidity?: number | null;
  // {ticker}_price_start / {ticker}_price_end keys are dynamic
  [k: string]: unknown;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderbookSnapshot {
  market_id: string;
  time: string;
  mid_yes: number | null;
  spread_yes: number | null;
  underlying_price: number | null;
  orderbook_up: { bids: BookLevel[]; asks: BookLevel[] };
  orderbook_down: { bids: BookLevel[]; asks: BookLevel[] };
}

export interface TimeseriesPoint {
  id: number;
  time: string;
  price_up: number | null;
  price_down: number | null;
  // Dynamic underlying key e.g. btc_price
  [k: string]: unknown;
}

export interface TimeseriesPayload {
  market: { market_id: string; market_type: string | null };
  snapshots: TimeseriesPoint[];
  total: number;
}

export default function MarketDetail({
  meta,
  book,
  series,
}: {
  meta: MarketMeta;
  book: OrderbookSnapshot | null;
  series: TimeseriesPayload | null;
}) {
  const points = series?.snapshots ?? [];
  // Scrubber index: -1 means "use the initial latest book passed in by
  // the server"; 0..N-1 means "fetch the orderbook at points[idx].time".
  const [scrubIdx, setScrubIdx] = useState<number>(-1);
  const [scrubbedBook, setScrubbedBook] = useState<OrderbookSnapshot | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  // Debounced fetch — wait for the user to actually pause/release the
  // slider before hitting the API. 500ms is long enough to absorb a
  // full drag motion (most drags are <300ms) but short enough that a
  // single click on the track feels responsive.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (scrubIdx < 0) {
      setScrubbedBook(null);
      return;
    }
    const targetTs = points[scrubIdx]?.time;
    if (!targetTs) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setScrubbing(true);
      try {
        const url = `/api/markets/${encodeURIComponent(meta.market_id)}/orderbook?at=${encodeURIComponent(targetTs)}`;
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) {
          const body = await res.json();
          // Only update if the response actually looks like a book — guards
          // against the proxy ever returning an error JSON with a 200.
          if (body && body.orderbook_up && body.orderbook_down) {
            setScrubbedBook(body);
          }
        }
      } catch {
        /* leave previous book in place */
      } finally {
        setScrubbing(false);
      }
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [scrubIdx, points, meta.market_id]);

  // Which book do we show? Scrubbed if active, otherwise the initial latest.
  const activeBook = scrubIdx >= 0 ? scrubbedBook ?? book : book;
  const activeTs = scrubIdx >= 0 ? points[scrubIdx]?.time : book?.time;

  return (
    <div className="space-y-6">
      <MetadataCard meta={meta} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <DualAxisChart
          meta={meta}
          points={points}
          highlightIdx={scrubIdx}
        />
        <OrderbookCard
          meta={meta}
          book={activeBook}
          activeTs={activeTs}
          loading={scrubbing}
        />
      </div>

      <TimeScrubber
        points={points}
        scrubIdx={scrubIdx}
        onChange={setScrubIdx}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metadata card — with friendlier empty-state copy
// ---------------------------------------------------------------------------

function MetadataCard({ meta }: { meta: MarketMeta }) {
  const ticker = (meta.ticker || "").toLowerCase();
  const priceStartKey = `${ticker}_price_start`;
  const priceEndKey = `${ticker}_price_end`;
  const priceStart = meta[priceStartKey] as number | null | undefined;
  const priceEnd = meta[priceEndKey] as number | null | undefined;

  // Determine WHY a value might be missing so we can show useful copy
  // instead of a bare "—".
  const isResolved = !!meta.resolved_at;
  const liquidityLabel =
    meta.final_liquidity == null
      ? "—"
      : meta.final_liquidity === 0 && isResolved
        ? "≈ 0 (post-resolution)"
        : formatNumber(meta.final_liquidity);

  const priceStartLabel =
    priceStart == null ? (
      <span className="opacity-60 text-sm">before data window</span>
    ) : (
      `$${formatPx(priceStart)}`
    );
  const priceEndLabel =
    priceEnd == null ? (
      <span className="opacity-60 text-sm">no spot tick near resolution</span>
    ) : (
      `$${formatPx(priceEnd)}`
    );

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat label="Ticker" value={meta.ticker || "—"} />
      <Stat
        label="Winner"
        value={
          meta.winner === "Up"
            ? "Up 📈"
            : meta.winner === "Down"
              ? "Down 📉"
              : "—"
        }
        accent={
          meta.winner === "Up"
            ? "success"
            : meta.winner === "Down"
              ? "error"
              : undefined
        }
      />
      <Stat label="Final volume" value={formatMoney(meta.final_volume)} />
      <Stat label="Final liquidity" value={liquidityLabel} />
      <Stat label="Start" value={formatDate(meta.start_time)} />
      <Stat label="End" value={formatDate(meta.end_time)} />
      <Stat
        label={`${meta.ticker || "BTC"} @ start`}
        value={priceStartLabel}
      />
      <Stat
        label={`${meta.ticker || "BTC"} @ end`}
        value={priceEndLabel}
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
  value: React.ReactNode;
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

// ---------------------------------------------------------------------------
// Dual-axis chart: Polymarket Up share (0-100%) + underlying spot price
// ---------------------------------------------------------------------------

function DualAxisChart({
  meta,
  points,
  highlightIdx,
}: {
  meta: MarketMeta;
  points: TimeseriesPoint[];
  highlightIdx: number;
}) {
  const ticker = (meta.ticker || "").toLowerCase();
  const underlyingKey = `${ticker}_price`;

  // Collect aligned (Up share, underlying) pairs. Drop points where Up
  // is null (rare); leave underlying null gaps to be skipped in the line.
  const data = useMemo(() => {
    return points.map((p) => ({
      time: p.time,
      up: p.price_up,
      under: p[underlyingKey] as number | null,
    }));
  }, [points, underlyingKey]);

  const upValues = data.map((d) => d.up).filter((v): v is number => v != null);
  const underValues = data
    .map((d) => d.under)
    .filter((v): v is number => v != null);

  if (data.length < 2 || upValues.length < 2) {
    return (
      <div className="rounded-lg border border-base-300 bg-base-100 p-4 text-sm opacity-60 text-center py-8">
        Not enough timeseries data to draw a chart yet.
      </div>
    );
  }

  // Chart dimensions
  const W = 700;
  const H = 220;
  const PAD_L = 44; // left axis label space
  const PAD_R = 56; // right axis label space
  const PAD_T = 14;
  const PAD_B = 18;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  // Scales
  const upLo = 0;
  const upHi = 1;
  const xStep = plotW / (data.length - 1);

  let underLo = 0;
  let underHi = 1;
  if (underValues.length >= 2) {
    underLo = Math.min(...underValues);
    underHi = Math.max(...underValues);
    if (underHi === underLo) underHi = underLo + 1; // avoid div-by-zero
    // Pad ~3% on each side so the line isn't glued to the edges
    const pad = (underHi - underLo) * 0.03;
    underLo -= pad;
    underHi += pad;
  }

  const xAt = (i: number) => PAD_L + i * xStep;
  const yUp = (v: number) => PAD_T + (1 - (v - upLo) / (upHi - upLo)) * plotH;
  const yUnder = (v: number) =>
    PAD_T + (1 - (v - underLo) / (underHi - underLo)) * plotH;

  // Build path strings. Skip nulls by breaking the line ("M" again).
  const buildPath = (
    values: (number | null)[],
    yFn: (v: number) => number
  ): string => {
    let path = "";
    let pen = "M";
    values.forEach((v, i) => {
      if (v == null) {
        pen = "M";
        return;
      }
      path += `${pen}${xAt(i).toFixed(1)},${yFn(v).toFixed(1)} `;
      pen = "L";
    });
    return path.trim();
  };

  const upPath = buildPath(
    data.map((d) => d.up),
    yUp
  );
  const underPath = buildPath(
    data.map((d) => d.under),
    yUnder
  );

  const upColor = "oklch(60% 0.2 250)";   // blueish — left axis
  const underColor = "oklch(70% 0.18 50)"; // orangeish — right axis

  // Highlight vertical line (driven by the time scrubber)
  const highlightX = highlightIdx >= 0 ? xAt(highlightIdx) : null;
  const highlightUp =
    highlightIdx >= 0 && data[highlightIdx]?.up != null
      ? data[highlightIdx].up
      : null;
  const highlightUnder =
    highlightIdx >= 0 && data[highlightIdx]?.under != null
      ? data[highlightIdx].under
      : null;

  const startUp = data.find((d) => d.up != null)?.up ?? null;
  const endUp = [...data].reverse().find((d) => d.up != null)?.up ?? null;

  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-4 space-y-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h3 className="font-semibold">Up share vs {meta.ticker || "Underlying"} spot</h3>
        <div className="flex items-center gap-3">
          <div className="flex gap-3 text-xs">
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-0.5"
                style={{ background: upColor }}
              />
              Up share
            </span>
            {underValues.length >= 2 && (
              <span className="flex items-center gap-1">
                <span
                  className="inline-block w-3 h-0.5"
                  style={{ background: underColor }}
                />
                {meta.ticker} spot
              </span>
            )}
          </div>
          <ExportButtons
            data={points as unknown as Record<string, unknown>[]}
            filename={`timeseries-${meta.market_id.slice(0, 16)}`}
          />
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-56"
        preserveAspectRatio="none"
      >
        {/* Grid: 4 horizontal lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = PAD_T + frac * plotH;
          return (
            <line
              key={frac}
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity={0.08}
            />
          );
        })}

        {/* Left axis ticks (Up share %) */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => (
          <text
            key={frac}
            x={PAD_L - 6}
            y={PAD_T + (1 - frac) * plotH + 3}
            textAnchor="end"
            fontSize="10"
            fill={upColor}
          >
            {Math.round(frac * 100)}%
          </text>
        ))}

        {/* Right axis ticks (underlying spot) */}
        {underValues.length >= 2 &&
          [0, 0.5, 1].map((frac) => {
            const v = underLo + frac * (underHi - underLo);
            return (
              <text
                key={frac}
                x={W - PAD_R + 6}
                y={PAD_T + (1 - frac) * plotH + 3}
                textAnchor="start"
                fontSize="10"
                fill={underColor}
              >
                ${formatPx(v)}
              </text>
            );
          })}

        {/* Lines */}
        <path d={upPath} fill="none" stroke={upColor} strokeWidth={1.5} />
        {underValues.length >= 2 && (
          <path
            d={underPath}
            fill="none"
            stroke={underColor}
            strokeWidth={1.5}
          />
        )}

        {/* Scrubber highlight: vertical line + dots on both series */}
        {highlightX != null && (
          <>
            <line
              x1={highlightX}
              x2={highlightX}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke="currentColor"
              strokeOpacity={0.4}
              strokeDasharray="3 3"
            />
            {highlightUp != null && (
              <circle
                cx={highlightX}
                cy={yUp(highlightUp)}
                r={3}
                fill={upColor}
              />
            )}
            {highlightUnder != null && (
              <circle
                cx={highlightX}
                cy={yUnder(highlightUnder)}
                r={3}
                fill={underColor}
              />
            )}
          </>
        )}
      </svg>

      <p className="text-xs opacity-70">
        Up: {startUp != null ? (startUp * 100).toFixed(1) : "?"}% →{" "}
        {endUp != null ? (endUp * 100).toFixed(1) : "?"}%
        {underValues.length >= 2 && (
          <>
            {" "}
            · {meta.ticker} ${formatPx(underValues[0])} → $
            {formatPx(underValues[underValues.length - 1])}
          </>
        )}
        {highlightIdx >= 0 && data[highlightIdx] && (
          <span className="ml-2 opacity-80">
            (scrubbed: {formatTime(data[highlightIdx].time)})
          </span>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orderbook card — now driven by the active timestamp
// ---------------------------------------------------------------------------

function OrderbookCard({
  meta,
  book,
  activeTs,
  loading,
}: {
  meta: MarketMeta;
  book: OrderbookSnapshot | null;
  activeTs?: string | null;
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">
          Orderbook
          {loading && (
            <span className="ml-2 loading loading-spinner loading-xs" />
          )}
        </h3>
        {activeTs && (
          <span className="text-xs opacity-60">{formatDate(activeTs)}</span>
        )}
      </div>

      {!book ? (
        <p className="text-sm opacity-60 py-8 text-center">
          No snapshot at this timestamp.
        </p>
      ) : (
        (() => {
          // Defensive normalisation: the API SHOULD always return the
          // 4 book sides, but if a snapshot is malformed (e.g. truncated
          // ClickHouse row, missing JSON column) we don't want to crash
          // the whole page on `.bids.length` access.
          const upBids = book.orderbook_up?.bids ?? [];
          const upAsks = book.orderbook_up?.asks ?? [];
          const downBids = book.orderbook_down?.bids ?? [];
          const downAsks = book.orderbook_down?.asks ?? [];
          return (
            <>
              <div className="text-xs opacity-70">
                Mid Up:{" "}
                <span className="font-semibold">
                  {book.mid_yes != null
                    ? (book.mid_yes * 100).toFixed(2) + "%"
                    : "—"}
                </span>{" "}
                · Spread:{" "}
                <span className="font-semibold">
                  {book.spread_yes != null
                    ? (book.spread_yes * 100).toFixed(2) + "%"
                    : "—"}
                </span>
                {book.underlying_price != null && (
                  <>
                    {" "}
                    · {meta.ticker || "Underlying"}:{" "}
                    <span className="font-semibold">
                      ${formatPx(book.underlying_price)}
                    </span>
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <BookSide title="Up · Bids" levels={upBids} accent="success" />
                <BookSide title="Up · Asks" levels={upAsks} accent="error" />
                <BookSide title="Down · Bids" levels={downBids} accent="success" />
                <BookSide title="Down · Asks" levels={downAsks} accent="error" />
              </div>

              {(upAsks.length === 0 || downBids.length === 0) && (
                <p className="text-xs opacity-60 italic">
                  Empty sides are normal for binary markets — liquidity tends
                  to concentrate on Up·Bids + Down·Asks (or vice versa). The
                  two sides are mathematically linked: Up_bid + Down_ask ≈ $1.
                </p>
              )}
            </>
          );
        })()
      )}
    </div>
  );
}

function BookSide({
  title,
  levels,
  accent,
}: {
  title: string;
  levels: BookLevel[];
  accent: "success" | "error";
}) {
  const top = levels.slice(0, 8);
  return (
    <div>
      <div
        className={`font-semibold mb-1 ${
          accent === "success" ? "text-success" : "text-error"
        }`}
      >
        {title}
      </div>
      <table className="table table-xs w-full">
        <thead>
          <tr className="opacity-70">
            <th>Price</th>
            <th className="text-right">Size</th>
          </tr>
        </thead>
        <tbody>
          {top.length === 0 && (
            <tr>
              <td colSpan={2} className="text-center opacity-50">
                empty
              </td>
            </tr>
          )}
          {top.map((l, i) => (
            <tr key={i}>
              <td>{(l.price * 100).toFixed(2)}¢</td>
              <td className="text-right tabular-nums">{formatNumber(l.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time scrubber: drag a slider through history → drives orderbook fetch
// ---------------------------------------------------------------------------

function TimeScrubber({
  points,
  scrubIdx,
  onChange,
}: {
  points: TimeseriesPoint[];
  scrubIdx: number;
  onChange: (i: number) => void;
}) {
  const latestIdx = points.length - 1;
  const currentIdx = scrubIdx < 0 ? latestIdx : scrubIdx;
  const currentTs = points[currentIdx]?.time ?? null;
  const isLatest = scrubIdx < 0;

  // Manual input — text field that mirrors the current scrubber timestamp
  // but lets the user paste / edit a precise ISO value. Validates on Enter
  // or "Go" click. Snaps to the nearest snapshot point we actually have
  // (since the orderbook API takes any ts ≤ requested and finds nearest).
  const [manualInput, setManualInput] = useState<string>("");
  const [inputError, setInputError] = useState<string | null>(null);

  // Re-sync the manual input whenever the slider position changes.
  useEffect(() => {
    if (currentTs) {
      setManualInput(currentTs);
      setInputError(null);
    }
  }, [currentTs]);

  // All point timestamps as numeric millis for fast nearest-neighbour search.
  const pointMs = useMemo(
    () => points.map((p) => new Date(p.time).getTime()),
    [points]
  );

  function jumpToTs(targetMs: number) {
    if (!Number.isFinite(targetMs) || pointMs.length === 0) return;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < pointMs.length; i++) {
      const d = Math.abs(pointMs[i] - targetMs);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    onChange(bestIdx);
  }

  function applyManualInput() {
    const trimmed = manualInput.trim();
    if (!trimmed) {
      setInputError("Empty");
      return;
    }
    const t = Date.parse(trimmed);
    if (Number.isNaN(t)) {
      setInputError("Not a valid ISO timestamp (e.g. 2026-05-24T13:42:00Z)");
      return;
    }
    const minMs = pointMs[0];
    const maxMs = pointMs[pointMs.length - 1];
    if (t < minMs - 60_000 || t > maxMs + 60_000) {
      setInputError(
        `Outside this market's data window (${new Date(minMs).toISOString().slice(0, 19)}Z to ${new Date(maxMs).toISOString().slice(0, 19)}Z)`
      );
      return;
    }
    setInputError(null);
    jumpToTs(t);
  }

  function jumpDelta(deltaMs: number) {
    const baseMs = currentTs ? new Date(currentTs).getTime() : pointMs[latestIdx];
    jumpToTs(baseMs + deltaMs);
  }

  if (points.length < 2) {
    return (
      <div className="rounded-lg border border-base-300 bg-base-100 p-4 text-sm opacity-60 text-center">
        Not enough snapshots for scrubbing on this market.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-4 space-y-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold">Time scrubber</h3>
          <p className="text-xs opacity-60 mt-0.5">
            Drag the slider, click a quick-jump, or paste an exact
            timestamp. The orderbook re-fetches 500ms after you stop.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            className="btn btn-xs btn-outline"
            onClick={() => onChange(0)}
            disabled={currentIdx === 0}
          >
            ⏮ Earliest
          </button>
          <button
            className="btn btn-xs btn-outline"
            onClick={() => jumpDelta(-60_000)}
          >
            −1m
          </button>
          <button
            className="btn btn-xs btn-outline"
            onClick={() => jumpDelta(+60_000)}
          >
            +1m
          </button>
          <button
            className="btn btn-xs btn-outline"
            disabled={isLatest}
            onClick={() => onChange(-1)}
          >
            Latest ⏭
          </button>
        </div>
      </div>

      {/* Visual slider — primarily for rough browsing */}
      <input
        type="range"
        min={0}
        max={latestIdx}
        value={currentIdx}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="range range-primary range-xs w-full"
        aria-label="Time scrubber position"
      />
      <div className="flex justify-between text-xs opacity-60">
        <span>{formatDate(points[0]?.time)}</span>
        <span>↔ drag both directions ↔</span>
        <span>{formatDate(points[latestIdx]?.time)}</span>
      </div>

      {/* Manual input — precise, copy-paste friendly */}
      <div className="flex items-center gap-2 pt-1 border-t border-base-300">
        <span className="text-xs uppercase tracking-wide opacity-60 w-20">
          {isLatest ? "Latest" : "At"}
        </span>
        <input
          type="text"
          value={manualInput}
          onChange={(e) => {
            setManualInput(e.target.value);
            setInputError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyManualInput();
            }
          }}
          className={`input input-sm input-bordered flex-1 font-mono text-xs ${inputError ? "input-error" : ""}`}
          placeholder="2026-05-24T13:42:00.000Z"
          spellCheck={false}
        />
        <button
          className="btn btn-sm btn-primary"
          onClick={applyManualInput}
        >
          Go
        </button>
      </div>
      {inputError && (
        <p className="text-xs text-error">{inputError}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

// All date formatters pin locale to "en-US" so SSR (Node, runs with
// whatever the VPS / dev-server system locale is) and CSR (browser,
// uses the user's locale — could be zh-CN, ja-JP, etc.) emit identical
// strings. Without this we get React hydration mismatches whenever the
// user's browser locale differs from the server's.
function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
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

function formatPx(n: number): string {
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
