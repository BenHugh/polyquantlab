"use client";

/**
 * Read-only market inspector. No charting library — we hand-roll an
 * inline SVG sparkline for the price history so the dashboard stays
 * dep-light. (Phase E2 will swap to Recharts for the backtest results
 * page; we'll lift the chart there.)
 */

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
  return (
    <div className="space-y-6">
      <MetadataCard meta={meta} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <PriceSparkline meta={meta} series={series} />
        <OrderbookCard meta={meta} book={book} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metadata card
// ---------------------------------------------------------------------------

function MetadataCard({ meta }: { meta: MarketMeta }) {
  const ticker = (meta.ticker || "").toLowerCase();
  const priceStartKey = `${ticker}_price_start`;
  const priceEndKey = `${ticker}_price_end`;
  const priceStart = meta[priceStartKey] as number | null | undefined;
  const priceEnd = meta[priceEndKey] as number | null | undefined;

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
        accent={meta.winner === "Up" ? "success" : meta.winner === "Down" ? "error" : undefined}
      />
      <Stat label="Final volume" value={formatMoney(meta.final_volume)} />
      <Stat label="Final liquidity" value={formatNumber(meta.final_liquidity)} />
      <Stat label="Start" value={formatDate(meta.start_time)} />
      <Stat label="End" value={formatDate(meta.end_time)} />
      <Stat
        label={`${meta.ticker || "BTC"} @ start`}
        value={priceStart != null ? `$${formatPx(priceStart)}` : "—"}
      />
      <Stat
        label={`${meta.ticker || "BTC"} @ end`}
        value={priceEnd != null ? `$${formatPx(priceEnd)}` : "—"}
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
  value: string;
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
// Price sparkline (inline SVG; no chart lib)
// ---------------------------------------------------------------------------

function PriceSparkline({
  meta,
  series,
}: {
  meta: MarketMeta;
  series: TimeseriesPayload | null;
}) {
  const points = series?.snapshots ?? [];
  const upSeries = points
    .map((p) => p.price_up)
    .filter((v): v is number => typeof v === "number");

  const ticker = (meta.ticker || "").toLowerCase();
  const underlyingKey = `${ticker}_price`;
  const underlyingSeries = points
    .map((p) => p[underlyingKey] as number | null)
    .filter((v): v is number => typeof v === "number");

  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Up-side price over time</h3>
        <span className="text-xs opacity-60">{points.length} snapshots</span>
      </div>

      {upSeries.length < 2 ? (
        <p className="text-sm opacity-60 py-8 text-center">
          Not enough data yet.
        </p>
      ) : (
        <>
          <Sparkline values={upSeries} domain={[0, 1]} color="oklch(60% 0.2 250)" />
          <p className="text-xs opacity-70">
            Up share: {(upSeries[0] * 100).toFixed(1)}% →{" "}
            {(upSeries[upSeries.length - 1] * 100).toFixed(1)}%
          </p>
        </>
      )}

      {underlyingSeries.length >= 2 && (
        <>
          <div className="border-t border-base-300 pt-3" />
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-sm">
              Underlying spot ({meta.ticker})
            </h4>
            <span className="text-xs opacity-60 tabular-nums">
              ${formatPx(underlyingSeries[0])} → $
              {formatPx(underlyingSeries[underlyingSeries.length - 1])}
            </span>
          </div>
          <Sparkline
            values={underlyingSeries}
            color="oklch(70% 0.18 50)"
          />
        </>
      )}
    </div>
  );
}

function Sparkline({
  values,
  domain,
  color = "currentColor",
  height = 60,
}: {
  values: number[];
  /** Force a y-axis domain; if omitted, autoscale to min/max. */
  domain?: [number, number];
  color?: string;
  height?: number;
}) {
  if (values.length < 2) return null;
  const width = 600;
  const [lo, hi] = domain ?? [Math.min(...values), Math.max(...values)];
  const range = Math.max(hi - lo, 1e-9);
  const step = width / (values.length - 1);
  const path = values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - lo) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-16"
      preserveAspectRatio="none"
    >
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Orderbook card
// ---------------------------------------------------------------------------

function OrderbookCard({
  meta,
  book,
}: {
  meta: MarketMeta;
  book: OrderbookSnapshot | null;
}) {
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Latest orderbook</h3>
        {book?.time && (
          <span className="text-xs opacity-60">{formatDate(book.time)}</span>
        )}
      </div>

      {!book ? (
        <p className="text-sm opacity-60 py-8 text-center">
          No snapshots stored yet.
        </p>
      ) : (
        <>
          <div className="text-xs opacity-70">
            Mid Up:{" "}
            <span className="font-semibold">
              {book.mid_yes != null ? (book.mid_yes * 100).toFixed(2) + "%" : "—"}
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
            <BookSide title="Up · Bids" levels={book.orderbook_up.bids} accent="success" />
            <BookSide title="Up · Asks" levels={book.orderbook_up.asks} accent="error" />
            <BookSide title="Down · Bids" levels={book.orderbook_down.bids} accent="success" />
            <BookSide title="Down · Asks" levels={book.orderbook_down.asks} accent="error" />
          </div>
        </>
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
// Formatters
// ---------------------------------------------------------------------------

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

function formatPx(n: number): string {
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
