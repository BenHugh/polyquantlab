"use client";

import ExportButtons from "@/components/ExportButtons";
import { useEffect, useMemo, useState } from "react";

/**
 * Sweep result viewer.
 *
 * Polls /api/backtest/[id] until status=completed (same poll pattern
 * as single backtests; the JobStore is unified). The result payload
 * has kind="sweep" + a 2D `cells[y][x]` grid of summary stats.
 *
 * UI:
 *   - Pick which metric to colour the heatmap by (net_pnl / sharpe /
 *     win_rate / max_drawdown / n_trades).
 *   - Diverging colour scale (red ↔ white ↔ green) so positive vs
 *     negative is instantly readable.
 *   - Best cell highlighted with a thicker border.
 *   - Hover any cell → tooltip with full stats.
 *   - Click any cell → opens a single backtest with those exact params
 *     so the user can drill into trades.
 */

interface SweepCell {
  total_pnl: number;
  total_fees?: number;
  net_pnl: number;
  win_rate: number;
  sharpe: number | null;
  max_drawdown: number;
  n_trades: number;
  n_markets: number;
  error?: string;
}

interface SweepAxis {
  param: string;
  values: number[];
  steps: number;
}

interface SweepResultBody {
  kind: "sweep";
  x_axis: SweepAxis;
  y_axis: SweepAxis | null;
  cells: SweepCell[][];
  best: { x_idx: number; y_idx: number; net_pnl: number };
  n_cells: number;
  n_markets_in_universe: number;
  n_markets_requested: number;
}

interface JobRecord {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  params: Record<string, unknown>;
  result: SweepResultBody | null;
  error: string | null;
}

const METRICS = [
  { key: "net_pnl",      label: "Net P&L",      higherIsBetter: true,  fmt: (v: number) => `$${v >= 0 ? "+" : ""}${v.toFixed(0)}` },
  { key: "sharpe",       label: "Sharpe",       higherIsBetter: true,  fmt: (v: number) => v.toFixed(2) },
  { key: "win_rate",     label: "Win rate",     higherIsBetter: true,  fmt: (v: number) => `${(v * 100).toFixed(0)}%` },
  { key: "max_drawdown", label: "Max drawdown", higherIsBetter: false, fmt: (v: number) => `$${v.toFixed(0)}` },
  { key: "n_trades",     label: "N trades",     higherIsBetter: true,  fmt: (v: number) => v.toString() },
] as const;

const POLL_MS = 1500;
const GIVE_UP_MS = 360_000;

export default function SweepResult({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [metric, setMetric] = useState<typeof METRICS[number]["key"]>("net_pnl");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const start = Date.now();
    async function poll() {
      try {
        const res = await fetch(`/api/backtest/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        if (res.status === 404) {
          if (!cancelled) setError("Sweep not found (may have expired).");
          return;
        }
        if (!res.ok) {
          if (!cancelled) setError(`Failed: ${res.status}`);
          return;
        }
        const body: JobRecord = await res.json();
        if (cancelled) return;
        setJob(body);
        if (body.status === "completed" || body.status === "failed") return;
        if (Date.now() - start > GIVE_UP_MS) { setGaveUp(true); return; }
        timer = setTimeout(poll, POLL_MS);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Network error");
      }
    }
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId]);

  if (error)        return <div className="alert alert-error"><span>{error}</span></div>;
  if (!job)         return <div className="opacity-70">Loading sweep…</div>;

  if (job.status === "failed") {
    return (
      <div className="alert alert-error flex-col items-start gap-2">
        <span className="font-semibold">Sweep failed</span>
        <pre className="text-xs whitespace-pre-wrap">{job.error || "(no detail)"}</pre>
      </div>
    );
  }
  if (job.status !== "completed" || !job.result) {
    return (
      <div className="alert">
        <span className="loading loading-spinner loading-sm" />
        <span>
          {job.status === "queued" ? "Queued…" : "Running…"}
          {gaveUp && " (still working — refresh later to retrieve)"}
        </span>
      </div>
    );
  }

  return (
    <SweepBody result={job.result} params={job.params} metric={metric} setMetric={setMetric} />
  );
}

// ---------------------------------------------------------------------------
// The actual heatmap + stats
// ---------------------------------------------------------------------------

function SweepBody({
  result,
  params,
  metric,
  setMetric,
}: {
  result: SweepResultBody;
  params: Record<string, unknown>;
  metric: typeof METRICS[number]["key"];
  setMetric: (m: typeof METRICS[number]["key"]) => void;
}) {
  const metricSpec = METRICS.find((m) => m.key === metric)!;
  const { x_axis, y_axis, cells, best } = result;

  // Flatten values for min/max so the colour scale spans the full range.
  const flat = useMemo(() => {
    const vals: number[] = [];
    for (const row of cells) {
      for (const c of row) {
        const v = (c as any)[metric];
        if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
      }
    }
    return vals;
  }, [cells, metric]);

  const lo = flat.length ? Math.min(...flat) : 0;
  const hi = flat.length ? Math.max(...flat) : 0;
  const absMax = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
  // For "higher is better" we want a diverging scale centred at 0.
  // For "lower is better" (drawdown) we flip the perception.
  function colorFor(v: number | null): string {
    if (v == null || !Number.isFinite(v)) return "var(--fallback-b3,#e5e7eb)";
    // Normalise to [-1, 1] around 0
    const t = Math.max(-1, Math.min(1, v / absMax));
    // Higher-is-better: green for positive, red for negative
    // Lower-is-better: invert
    const polarity = metricSpec.higherIsBetter ? 1 : -1;
    const tp = t * polarity;
    if (tp >= 0) {
      // 0 → white, 1 → strong green
      const alpha = 0.1 + 0.7 * tp;
      return `oklch(70% ${0.18 * tp} 150 / ${alpha})`;
    } else {
      const alpha = 0.1 + 0.7 * Math.abs(tp);
      return `oklch(65% ${0.20 * Math.abs(tp)} 25 / ${alpha})`;
    }
  }

  return (
    <div className="space-y-6">
      <div className="alert alert-success">
        <span>
          Completed · {result.n_cells} cells × {result.n_markets_in_universe} markets ={" "}
          {(result.n_cells * result.n_markets_in_universe).toLocaleString()} simulated runs.
        </span>
      </div>

      {/* Metric selector + export */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs opacity-60 uppercase tracking-wide">Colour by</span>
          <div className="tabs tabs-boxed">
            {METRICS.map((m) => (
              <button
                key={m.key}
                className={`tab tab-sm ${metric === m.key ? "tab-active" : ""}`}
                onClick={() => setMetric(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <ExportButtons
          data={cells.flatMap((row, yi) => row.map((c, xi) => ({
            x: x_axis.values[xi],
            ...(y_axis ? { y: y_axis.values[yi] } : {}),
            ...c,
          }))) as unknown as Record<string, unknown>[]}
          filename={`sweep-${x_axis.param}${y_axis ? "-" + y_axis.param : ""}`}
        />
      </div>

      {/* Heatmap */}
      <div className="rounded-lg border border-base-300 bg-base-100 p-4 overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th className="text-xs opacity-50 p-1">
                {y_axis ? `${y_axis.param} ↓ / ${x_axis.param} →` : x_axis.param}
              </th>
              {x_axis.values.map((xv, xi) => (
                <th key={xi} className="text-xs opacity-70 p-1 font-normal">
                  {formatNum(xv)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((row, yi) => (
              <tr key={yi}>
                <td className="text-xs opacity-70 p-1 pr-2">
                  {y_axis ? formatNum(y_axis.values[yi]) : ""}
                </td>
                {row.map((cell, xi) => {
                  const v = (cell as any)[metric] as number | null;
                  const isBest = best.x_idx === xi && best.y_idx === yi;
                  const isError = !!cell.error;
                  return (
                    <td
                      key={xi}
                      title={cellTooltip(cell, x_axis.values[xi], y_axis ? y_axis.values[yi] : null, x_axis.param, y_axis?.param)}
                      style={{
                        background: isError ? "var(--fallback-b3,#e5e7eb)" : colorFor(v),
                        outline: isBest ? "2px solid currentColor" : "none",
                      }}
                      className="font-mono text-xs text-center min-w-[60px] cursor-help"
                    >
                      <div className="px-2 py-1.5">
                        {isError ? "ERR" : v == null ? "—" : metricSpec.fmt(v)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Best cell summary */}
      <div className="rounded-lg border border-base-300 bg-base-100 p-4">
        <h3 className="font-semibold mb-2">Best cell (by net P&L)</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Stat label={x_axis.param} value={formatNum(x_axis.values[best.x_idx])} />
          {y_axis && (
            <Stat label={y_axis.param} value={formatNum(y_axis.values[best.y_idx])} />
          )}
          <Stat label="Net P&L"
            value={`$${cells[best.y_idx][best.x_idx].net_pnl >= 0 ? "+" : ""}${cells[best.y_idx][best.x_idx].net_pnl.toFixed(2)}`}
            accent={cells[best.y_idx][best.x_idx].net_pnl >= 0 ? "success" : "error"}
          />
          <Stat label="Sharpe"
            value={
              cells[best.y_idx][best.x_idx].sharpe != null
                ? cells[best.y_idx][best.x_idx].sharpe!.toFixed(2)
                : "—"
            }
          />
          <Stat label="Win rate"
            value={`${(cells[best.y_idx][best.x_idx].win_rate * 100).toFixed(1)}%`} />
          <Stat label="Trades" value={cells[best.y_idx][best.x_idx].n_trades.toString()} />
        </div>
        <p className="text-xs opacity-60 mt-3">
          Tip: Look for a smooth high-PnL <em>plateau</em> rather than an
          isolated spike. Spikes often vanish on out-of-sample data — a
          stable region of similar values is a much stronger signal.
        </p>
      </div>

      <details className="rounded-lg border border-base-300 bg-base-100 p-4">
        <summary className="cursor-pointer font-semibold text-sm">
          Sweep parameters
        </summary>
        <pre className="mt-2 text-xs bg-base-200 p-3 rounded overflow-x-auto">
          {JSON.stringify(params, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "success" | "error" }) {
  const color = accent === "success" ? "text-success" : accent === "error" ? "text-error" : "";
  return (
    <div>
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className={`font-semibold mt-0.5 ${color}`}>{value}</div>
    </div>
  );
}

function cellTooltip(
  c: SweepCell,
  x: number,
  y: number | null,
  xParam: string,
  yParam: string | undefined
): string {
  const parts: string[] = [
    `${xParam}: ${formatNum(x)}`,
  ];
  if (y != null && yParam) parts.push(`${yParam}: ${formatNum(y)}`);
  parts.push(`Net P&L: $${c.net_pnl.toFixed(2)}`);
  parts.push(`Sharpe: ${c.sharpe != null ? c.sharpe.toFixed(2) : "—"}`);
  parts.push(`Win rate: ${(c.win_rate * 100).toFixed(1)}%`);
  parts.push(`Trades: ${c.n_trades} on ${c.n_markets} markets`);
  if (c.error) parts.push(`ERROR: ${c.error}`);
  return parts.join("\n");
}

function formatNum(n: number): string {
  if (Math.abs(n) < 0.01) return n.toExponential(1);
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
}
