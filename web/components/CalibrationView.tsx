"use client";

import ExportButtons from "@/components/ExportButtons";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";

/**
 * Calibration scatter/bar plot — see the page for the marketing pitch.
 *
 * Bars represent the OBSERVED Up-rate at each implied-probability
 * bucket. The diagonal `y=x` line is what a perfectly-calibrated set
 * of markets would look like. We compute these on the fly from
 * resolved markets in our DB — there's no batch job, just a fanout of
 * ClickHouse queries.
 */

interface Bucket {
  lo: number;
  hi: number;
  n_markets: number;
  up_rate: number | null;
  mean_mid: number | null;
}

interface CalibrationResponse {
  params: {
    ticker: string | null;
    event_type: string | null;
    minutes_before: number;
    buckets: number;
  };
  n_markets: number;
  n_total_resolved: number;
  buckets: Bucket[];
}

const TICKERS = ["ALL", "BTC", "ETH", "SOL"] as const;
// Up/Down binary markets only. Bracket / price-target markets are
// not in our product scope; see collector/discovery.py:WINDOW_TAG_TO_TYPE.
const EVENT_TYPES = ["ALL", "5m", "15m", "1h", "4h", "daily_up_down"] as const;
const EVENT_TYPE_LABELS: Record<(typeof EVENT_TYPES)[number], string> = {
  ALL: "ALL",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  daily_up_down: "Daily",
};
const MINUTES_OPTIONS = [0.5, 1, 5, 15, 60] as const;

export default function CalibrationView() {
  const [ticker, setTicker] = useState<(typeof TICKERS)[number]>("ALL");
  const [eventType, setEventType] =
    useState<(typeof EVENT_TYPES)[number]>("5m");
  const [minutesBefore, setMinutesBefore] = useState<number>(1);
  const [data, setData] = useState<CalibrationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          minutes_before: String(minutesBefore),
          buckets: "10",
          max_markets: "2000",
        });
        if (ticker !== "ALL") qs.set("ticker", ticker);
        if (eventType !== "ALL") qs.set("event_type", eventType);
        const res = await fetch(`/api/stats/calibration?${qs.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`Failed: ${res.status}`);
        }
        const body = await res.json();
        if (!cancelled) setData(body);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [ticker, eventType, minutesBefore]);

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 justify-between">
        <div className="flex flex-wrap items-center gap-4">
          <FilterTabs
            label="Ticker"
            options={TICKERS}
            value={ticker}
            onChange={(v) => setTicker(v as typeof ticker)}
          />
          <FilterTabs
            label="Window"
            options={EVENT_TYPES}
            labels={EVENT_TYPE_LABELS}
            value={eventType}
            onChange={(v) => setEventType(v as typeof eventType)}
          />
          <div className="flex items-center gap-2">
            <span className="text-xs opacity-60 uppercase tracking-wide">
              T-minus
            </span>
            <div className="tabs tabs-boxed">
              {MINUTES_OPTIONS.map((m) => (
                <button
                  key={m}
                  className={`tab tab-sm ${minutesBefore === m ? "tab-active" : ""}`}
                  onClick={() => setMinutesBefore(m)}
                >
                  {m < 1 ? `${m * 60}s` : `${m}m`}
                </button>
              ))}
            </div>
          </div>
        </div>
        {data && data.buckets.length > 0 && (
          <ExportButtons
            data={data.buckets as unknown as Record<string, unknown>[]}
            filename={`calibration-${ticker.toLowerCase()}-${eventType}-${minutesBefore}m`}
          />
        )}
      </div>

      {/* Status banner */}
      {error && (
        <div className="alert alert-error">
          <span>{error}</span>
        </div>
      )}
      {loading && !data && (
        <div className="rounded-lg border border-base-300 p-8 text-center opacity-60">
          Computing calibration…
        </div>
      )}

      {data && (
        (() => {
          const totalN = data.buckets.reduce(
            (s, b) => s + b.n_markets,
            0
          );
          if (totalN === 0) {
            return (
              <div className="rounded-lg border border-base-300 bg-base-100 p-8 text-center space-y-2">
                <div className="font-semibold">
                  No resolved markets match this filter.
                </div>
                <p className="text-sm opacity-70">
                  Either we haven&apos;t collected enough data yet for the
                  selected window, or no snapshots exist at T−
                  {data.params.minutes_before} min before resolution for
                  any of those markets. Try a different window, ticker,
                  or T-minus value.
                </p>
              </div>
            );
          }
          return (
            <>
              <SummaryBar data={data} />
              <CalibrationChart buckets={data.buckets} loading={loading} />
              <InsightCard
                buckets={data.buckets}
                ticker={ticker}
                eventType={eventType}
              />
              <BucketTable buckets={data.buckets} />
            </>
          );
        })()
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FilterTabs({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  /** Optional display-label override (e.g. "daily_up_down" → "Daily"). */
  labels?: Record<string, string>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs opacity-60 uppercase tracking-wide">
        {label}
      </span>
      <div className="tabs tabs-boxed">
        {options.map((o) => (
          <button
            key={o}
            className={`tab tab-sm ${value === o ? "tab-active" : ""}`}
            onClick={() => onChange(o)}
          >
            {labels?.[o] ?? o}
          </button>
        ))}
      </div>
    </div>
  );
}

function SummaryBar({ data }: { data: CalibrationResponse }) {
  // Aggregate stats: total markets, mean implied, mean actual
  const totalN = data.buckets.reduce((s, b) => s + b.n_markets, 0);
  const weightedImplied =
    totalN > 0
      ? data.buckets.reduce(
          (s, b) => s + (b.mean_mid ?? 0) * b.n_markets,
          0
        ) / totalN
      : null;
  const weightedActual =
    totalN > 0
      ? data.buckets.reduce(
          (s, b) => s + (b.up_rate ?? 0) * b.n_markets,
          0
        ) / totalN
      : null;
  const bias =
    weightedImplied != null && weightedActual != null
      ? weightedActual - weightedImplied
      : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat label="Markets sampled" value={`${totalN.toLocaleString()}`} />
      <Stat
        label="Mean implied Up"
        value={
          weightedImplied != null
            ? `${(weightedImplied * 100).toFixed(1)}%`
            : "—"
        }
      />
      <Stat
        label="Actual Up rate"
        value={
          weightedActual != null
            ? `${(weightedActual * 100).toFixed(1)}%`
            : "—"
        }
      />
      <Stat
        label="Net bias"
        value={
          bias != null
            ? `${bias >= 0 ? "+" : ""}${(bias * 100).toFixed(1)}pp`
            : "—"
        }
        accent={
          bias == null ? undefined : Math.abs(bias) > 0.02 ? "warning" : "success"
        }
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
  accent?: "warning" | "success";
}) {
  const color =
    accent === "warning"
      ? "text-warning"
      : accent === "success"
        ? "text-success"
        : "";
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-3">
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className={`font-semibold mt-1 ${color}`}>{value}</div>
    </div>
  );
}

function CalibrationChart({
  buckets,
  loading,
}: {
  buckets: Bucket[];
  loading: boolean;
}) {
  const W = 520;
  const H = 380;
  const PAD = 40;
  const plotW = W - 2 * PAD;
  const plotH = H - 2 * PAD;
  const x = (v: number) => PAD + v * plotW;
  const y = (v: number) => H - PAD - v * plotH;

  // Max bucket count for sizing bubbles
  const maxN = Math.max(...buckets.map((b) => b.n_markets), 1);

  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-4 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold">Calibration plot</h3>
        <div className="text-xs opacity-70 flex gap-3">
          <span>Diagonal = perfectly calibrated</span>
          {loading && (
            <span className="loading loading-spinner loading-xs" />
          )}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ maxHeight: 480 }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Axes */}
        <line
          x1={PAD}
          x2={W - PAD}
          y1={H - PAD}
          y2={H - PAD}
          stroke="currentColor"
          strokeOpacity={0.4}
        />
        <line
          x1={PAD}
          x2={PAD}
          y1={PAD}
          y2={H - PAD}
          stroke="currentColor"
          strokeOpacity={0.4}
        />

        {/* Diagonal y=x */}
        <line
          x1={x(0)}
          x2={x(1)}
          y1={y(0)}
          y2={y(1)}
          stroke="oklch(60% 0.18 250)"
          strokeOpacity={0.5}
          strokeDasharray="4 4"
        />

        {/* Grid lines at 25/50/75% */}
        {[0.25, 0.5, 0.75].map((v) => (
          <g key={v}>
            <line
              x1={x(v)}
              x2={x(v)}
              y1={PAD}
              y2={H - PAD}
              stroke="currentColor"
              strokeOpacity={0.08}
            />
            <line
              x1={PAD}
              x2={W - PAD}
              y1={y(v)}
              y2={y(v)}
              stroke="currentColor"
              strokeOpacity={0.08}
            />
          </g>
        ))}

        {/* Axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={`tick-${v}`}>
            <text
              x={x(v)}
              y={H - PAD + 16}
              textAnchor="middle"
              fontSize="10"
              fill="currentColor"
              opacity={0.6}
            >
              {Math.round(v * 100)}%
            </text>
            <text
              x={PAD - 8}
              y={y(v) + 3}
              textAnchor="end"
              fontSize="10"
              fill="currentColor"
              opacity={0.6}
            >
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        <text
          x={W / 2}
          y={H - 8}
          textAnchor="middle"
          fontSize="11"
          fill="currentColor"
          opacity={0.7}
        >
          Implied Up probability (Polymarket)
        </text>
        <text
          x={12}
          y={H / 2}
          textAnchor="middle"
          fontSize="11"
          fill="currentColor"
          opacity={0.7}
          transform={`rotate(-90 12 ${H / 2})`}
        >
          Actual Up rate (observed)
        </text>

        {/* Buckets as bubbles — radius scales with sample size */}
        {buckets.map((b, i) => {
          if (b.up_rate == null || b.mean_mid == null) return null;
          const cx = x(b.mean_mid);
          const cy = y(b.up_rate);
          const r = 4 + 14 * Math.sqrt(b.n_markets / maxN);
          // Color by under/over: if observed > implied, red (markets too cheap);
          // observed < implied: green (markets too expensive)
          const delta = b.up_rate - b.mean_mid;
          const fill =
            Math.abs(delta) < 0.02
              ? "oklch(65% 0.12 180)"      // neutral
              : delta > 0
                ? "oklch(60% 0.2 25)"       // under-priced (red)
                : "oklch(60% 0.18 150)";    // over-priced (green)
          return (
            <g key={i}>
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={fill}
                fillOpacity={0.55}
                stroke={fill}
                strokeWidth={1.5}
              />
              <text
                x={cx}
                y={cy - r - 2}
                textAnchor="middle"
                fontSize="9"
                fill="currentColor"
                opacity={0.65}
              >
                n={b.n_markets}
              </text>
            </g>
          );
        })}
      </svg>

      <p className="text-xs opacity-60">
        Bubble size = sample count. Red bubbles = market underestimated Up
        (longer-than-implied actual occurrence). Green = market overestimated
        Up. Bubbles on the diagonal are well-calibrated.
      </p>
    </div>
  );
}

function InsightCard({
  buckets,
  ticker,
  eventType,
}: {
  buckets: Bucket[];
  ticker: string;
  eventType: string;
}) {
  const router = useRouter();

  // Find the bucket with the largest mispricing (|up_rate - mean_mid|).
  // Require n_markets ≥ 20 so we're surfacing an edge, not small-sample noise.
  const MIN_N = 20;
  const candidates = buckets.filter(
    (b) =>
      b.n_markets >= MIN_N && b.up_rate != null && b.mean_mid != null,
  );
  if (candidates.length === 0) {
    return null;
  }
  const winner = candidates.reduce((best, b) =>
    Math.abs((b.up_rate ?? 0) - (b.mean_mid ?? 0)) >
    Math.abs((best.up_rate ?? 0) - (best.mean_mid ?? 0))
      ? b
      : best,
  );
  const delta = (winner.up_rate ?? 0) - (winner.mean_mid ?? 0);
  const edgePp = Math.abs(delta) * 100;
  if (edgePp < 2) {
    return null; // nothing notable
  }

  const direction = delta > 0 ? "UP under-priced" : "UP over-priced";
  const tradeLogic = delta > 0 ? "always_up" : "always_down";
  const description =
    delta > 0
      ? `markets in the ${(winner.lo * 100).toFixed(0)}–${(winner.hi * 100).toFixed(0)}% implied range actually go Up ${(((winner.up_rate ?? 0)) * 100).toFixed(1)}% of the time across ${winner.n_markets} resolved markets — buying UP in this band would capture the gap.`
      : `markets in the ${(winner.lo * 100).toFixed(0)}–${(winner.hi * 100).toFixed(0)}% implied range only go Up ${(((winner.up_rate ?? 0)) * 100).toFixed(1)}% of the time across ${winner.n_markets} markets — buying DOWN when UP is in this band would capture the gap.`;

  function applyToBuilder() {
    // Hand off via localStorage. Strategy Builder picks up `pql-strategy-builder-prefill`
    // on mount, applies it, and clears the key — so it's a one-shot push
    // that doesn't trample any saved state if the user navigates back later.
    const prefill = {
      ticker: ticker !== "ALL" ? ticker : "BTC",
      eventType:
        eventType !== "ALL" ? eventType : "5m",
      tradeLogic,
      entry: [
        {
          id: Math.random().toString(36).slice(2),
          type: "token_price",
          side: "yes",
          op: ">=",
          value: Number(winner.lo.toFixed(2)),
        },
        {
          id: Math.random().toString(36).slice(2),
          type: "token_price",
          side: "yes",
          op: "<=",
          value: Number(winner.hi.toFixed(2)),
        },
      ],
      takeProfit: [] as unknown[],
      stopLoss: [] as unknown[],
      // Banner text the builder can show explaining where this came from.
      origin: `Calibration edge · ${ticker !== "ALL" ? ticker : "BTC"} ${eventType !== "ALL" ? eventType : "5m"} · ${direction} by ${edgePp.toFixed(1)}pp`,
    };
    try {
      localStorage.setItem("pql-strategy-builder-prefill", JSON.stringify(prefill));
    } catch {
      // localStorage full / disabled — proceed without prefill; the builder
      // just won't pre-populate.
    }
    toast.success("Applied — opening Strategy Builder…");
    router.push("/dashboard/strategy-builder");
  }

  const accent =
    delta > 0
      ? "border-primary/30 bg-primary/5"
      : "border-error/30 bg-error/5";
  const accentText = delta > 0 ? "text-primary" : "text-error";

  return (
    <div className={`rounded-xl border ${accent} p-5 space-y-3`}>
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest opacity-60 mb-1">
            Insight
          </div>
          <div className={`text-lg font-semibold ${accentText}`}>
            {direction} by {edgePp.toFixed(1)}pp in the{" "}
            {(winner.lo * 100).toFixed(0)}–{(winner.hi * 100).toFixed(0)}%
            band
          </div>
        </div>
        <button
          onClick={applyToBuilder}
          className="btn btn-sm btn-primary rounded-lg"
        >
          Apply to Strategy Builder →
        </button>
      </div>
      <p className="text-sm text-base-content/70 leading-relaxed">
        {ticker !== "ALL" ? `${ticker} ` : ""}
        {eventType !== "ALL" ? `${eventType} ` : ""}
        {description}
      </p>
      <p className="text-[11px] opacity-50 leading-relaxed font-mono">
        Caveat: edge is computed from historical resolved markets within
        your selected filter. Past mispricing doesn&apos;t guarantee future
        mispricing — always validate with Paper Trading before going live.
      </p>
    </div>
  );
}

function BucketTable({ buckets }: { buckets: Bucket[] }) {
  return (
    <div className="rounded-lg border border-base-300 overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Implied bucket</th>
            <th className="text-right">Markets</th>
            <th className="text-right">Mean implied</th>
            <th className="text-right">Actual Up rate</th>
            <th className="text-right">Bias</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b, i) => {
            const bias =
              b.up_rate != null && b.mean_mid != null
                ? b.up_rate - b.mean_mid
                : null;
            return (
              <tr key={i} className={b.n_markets === 0 ? "opacity-40" : ""}>
                <td>
                  {(b.lo * 100).toFixed(0)}% – {(b.hi * 100).toFixed(0)}%
                </td>
                <td className="text-right tabular-nums">
                  {b.n_markets.toLocaleString()}
                </td>
                <td className="text-right tabular-nums">
                  {b.mean_mid != null
                    ? `${(b.mean_mid * 100).toFixed(1)}%`
                    : "—"}
                </td>
                <td className="text-right tabular-nums">
                  {b.up_rate != null
                    ? `${(b.up_rate * 100).toFixed(1)}%`
                    : "—"}
                </td>
                <td
                  className={`text-right tabular-nums ${
                    bias == null
                      ? "opacity-50"
                      : bias > 0.02
                        ? "text-error"
                        : bias < -0.02
                          ? "text-success"
                          : ""
                  }`}
                >
                  {bias != null
                    ? `${bias >= 0 ? "+" : ""}${(bias * 100).toFixed(1)}pp`
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
