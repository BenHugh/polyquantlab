"use client";

import ExportButtons from "@/components/ExportButtons";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";

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
    return <RunningProgress job={job} gaveUp={gaveUp} />;
  }

  return (
    <SweepBody result={job.result} params={job.params} metric={metric} setMetric={setMetric} />
  );
}

// ---------------------------------------------------------------------------
// The actual heatmap + stats
// ---------------------------------------------------------------------------

function RunningProgress({ job, gaveUp }: { job: JobRecord; gaveUp: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  // Sweep cost is roughly cells × markets × 50ms. The worker runs them
  // serially per cell (cells are batched but the parameter override
  // still means each cell hits ClickHouse + the engine), so a 3×5
  // grid over 100 markets ≈ 75 s.
  const params = job.params as Record<string, unknown>;
  const marketLimit = Number(params.market_limit || 100);
  const xAxis = params.x_axis as { steps?: number } | undefined;
  const yAxis = params.y_axis as { steps?: number } | undefined;
  const cellCount = (xAxis?.steps || 1) * (yAxis?.steps || 1);
  const expectedMs = Math.max(5000, cellCount * marketLimit * 50);

  let pct: number;
  let label: string;
  if (job.status === "queued") {
    pct = 5;
    label = "Queued — waiting for a worker…";
  } else if (job.started_at) {
    const elapsed = now - new Date(job.started_at).getTime();
    pct = Math.min(95, (elapsed / expectedMs) * 100);
    const remainingMs = Math.max(0, expectedMs - elapsed);
    label = `Running ${cellCount} cells × ${marketLimit} markets · ~${Math.ceil(remainingMs / 1000)}s remaining`;
  } else {
    pct = 10;
    label = "Starting…";
  }

  return (
    <div className="rounded-xl border border-base-300 bg-base-200/30 p-4 space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
          <span className="truncate">{label}</span>
        </div>
        <span className="font-mono text-xs tabular-nums text-base-content/70 shrink-0">
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-base-300 overflow-hidden">
        <div
          className="h-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {gaveUp && (
        <p className="text-xs text-warning">
          This sweep is taking longer than usual. Results will appear here
          when it finishes — refresh later.
        </p>
      )}
    </div>
  );
}

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
  const router = useRouter();
  const [running, setRunning] = useState(false);
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

  // Plateau detection. A cell is "on the plateau" when its metric is
  // within 10% of the peak AND at least 2 of its 4-neighbours also
  // qualify. Single-cell spikes don't pass the neighbour test, which
  // is exactly what we want — out-of-sample those usually evaporate.
  const plateau = useMemo(() => {
    const grid = cells;
    if (grid.length === 0) return new Set<string>();
    const peak = (() => {
      let best = -Infinity;
      let dir = metricSpec.higherIsBetter ? 1 : -1;
      for (const row of grid)
        for (const c of row) {
          const v = (c as any)[metric];
          if (typeof v === "number" && Number.isFinite(v)) {
            const score = v * dir;
            if (score > best) best = score;
          }
        }
      return best;
    })();
    if (!Number.isFinite(peak)) return new Set<string>();
    const dir = metricSpec.higherIsBetter ? 1 : -1;
    const threshold = peak * 0.9; // within 10% of peak (in dir-adjusted space)
    function passes(y: number, x: number): boolean {
      const c = grid[y]?.[x];
      if (!c || c.error) return false;
      const v = (c as any)[metric];
      if (typeof v !== "number" || !Number.isFinite(v)) return false;
      return v * dir >= threshold;
    }
    const set = new Set<string>();
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        if (!passes(y, x)) continue;
        const neighbourHits =
          (passes(y - 1, x) ? 1 : 0) +
          (passes(y + 1, x) ? 1 : 0) +
          (passes(y, x - 1) ? 1 : 0) +
          (passes(y, x + 1) ? 1 : 0);
        if (neighbourHits >= 2) set.add(`${y},${x}`);
      }
    }
    return set;
  }, [cells, metric, metricSpec]);
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
                  const isPlateau = plateau.has(`${yi},${xi}`);
                  const isError = !!cell.error;
                  // Outline priority: best (solid) → plateau (dashed inner ring).
                  const outline = isBest
                    ? "2px solid currentColor"
                    : isPlateau
                      ? "1.5px dashed oklch(70% 0.18 155 / 0.7)"
                      : "none";
                  return (
                    <td
                      key={xi}
                      title={cellTooltip(cell, x_axis.values[xi], y_axis ? y_axis.values[yi] : null, x_axis.param, y_axis?.param)}
                      style={{
                        background: isError ? "var(--fallback-b3,#e5e7eb)" : colorFor(v),
                        outline,
                        outlineOffset: isPlateau && !isBest ? "-2px" : undefined,
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
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
          <h3 className="font-semibold">Best cell (by net P&L)</h3>
          <button
            onClick={async () => {
              if (running) return;
              setRunning(true);
              try {
                const baseStrategy =
                  (params.strategy as Record<string, unknown>) || {};
                const merged = {
                  ...baseStrategy,
                  [x_axis.param]: x_axis.values[best.x_idx],
                };
                if (y_axis) {
                  (merged as Record<string, unknown>)[y_axis.param] =
                    y_axis.values[best.y_idx];
                }
                const body = {
                  strategy: merged,
                  ticker: params.ticker,
                  event_type: params.event_type,
                  market_limit: params.market_limit,
                  since: params.since,
                  until: params.until,
                };
                const r = await fetch("/api/backtest", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                });
                const data = await r.json();
                if (!r.ok) {
                  toast.error(data?.error || `Submit failed (${r.status})`);
                  return;
                }
                const id = data.job_id || data.id;
                if (!id) {
                  toast.error("No job_id returned");
                  return;
                }
                toast.success("Running with best params…");
                router.push(`/dashboard/backtest/${id}`);
              } catch (e: any) {
                toast.error(e?.message || "Network error");
              } finally {
                setRunning(false);
              }
            }}
            disabled={running}
            className="btn btn-sm btn-primary rounded-lg"
            title="Submit a new single-backtest job using the swept-best parameter values."
          >
            {running ? "Submitting…" : "Run best params →"}
          </button>
        </div>
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
          Tip: Cells outlined with a <span className="font-mono">dashed
          green</span> border are within 10% of the peak <em>and</em>
          have ≥2 similar neighbours — the strategy plateau. Spike-only
          cells (no dashed outline) usually don&apos;t survive out-of-sample.
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
