"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";

/**
 * Sweep configuration form.
 *
 * The user picks a base strategy (same three as the single backtest),
 * pins values for everything they want fixed, then picks 1 or 2 axes
 * to sweep. Each axis is {param, start, end, steps}.
 *
 * Per-strategy sweepable params live in SWEEPABLE_PARAMS — these are
 * the numeric knobs of each built-in strategy in backtest/strategies.py.
 */

type StrategyType =
  | "threshold_entry"
  | "mean_reversion"
  | "time_before_resolution";

const TICKERS = ["BTC", "ETH", "SOL"] as const;

interface ParamSpec {
  key: string;
  label: string;
  defaultStart: number;
  defaultEnd: number;
  hint?: string;
}

// Source-of-truth for which params are sweepable. Mirrors the numeric
// kwargs of each strategy fn in backtest/strategies.py.
const SWEEPABLE_PARAMS: Record<StrategyType, ParamSpec[]> = {
  threshold_entry: [
    { key: "threshold", label: "Threshold (0-1)", defaultStart: 0.2, defaultEnd: 0.5, hint: "Implied probability cutoff" },
    { key: "size_usd",  label: "Position size $",  defaultStart: 5,   defaultEnd: 50,  hint: "USD notional per trade" },
  ],
  mean_reversion: [
    { key: "lookback",    label: "Lookback (bars)", defaultStart: 10,  defaultEnd: 60,  hint: "How many snapshots back for the mean" },
    { key: "z_threshold", label: "Z threshold",     defaultStart: 1.0, defaultEnd: 3.0, hint: "Std-devs from mean before firing" },
    { key: "size_usd",    label: "Position size $", defaultStart: 5,   defaultEnd: 50 },
  ],
  time_before_resolution: [
    { key: "minutes_before", label: "Minutes before resolution", defaultStart: 5,  defaultEnd: 60 },
    { key: "minutes_window", label: "Window (± min)",            defaultStart: 1,  defaultEnd: 10 },
    { key: "size_usd",       label: "Position size $",           defaultStart: 5,  defaultEnd: 50 },
  ],
};

interface AxisState {
  param: string;
  start: number;
  end: number;
  steps: number;
}

export default function SweepForm({
  maxMarketLimit,
  maxSweepCells,
}: {
  maxMarketLimit: number;
  maxSweepCells: number;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  // Universe
  const [ticker, setTicker] = useState<(typeof TICKERS)[number]>("BTC");
  const [marketLimit, setMarketLimit] = useState<number>(
    Math.min(50, maxMarketLimit)
  );

  // Strategy
  const [strategyType, setStrategyType] =
    useState<StrategyType>("threshold_entry");
  // Fixed-value spec keys (the params NOT being swept get held at these
  // values). Defaults match the single-backtest form.
  const [direction, setDirection] = useState<"below" | "above">("below");
  const [side, setSide] = useState<"buy_yes" | "buy_no">("buy_yes");
  const [pinnedSizeUsd, setPinnedSizeUsd] = useState<number>(10);
  const [pinnedThreshold, setPinnedThreshold] = useState<number>(0.3);
  const [pinnedLookback, setPinnedLookback] = useState<number>(30);
  const [pinnedZ, setPinnedZ] = useState<number>(2.0);
  const [pinnedMinBefore, setPinnedMinBefore] = useState<number>(60);
  const [pinnedMinWindow, setPinnedMinWindow] = useState<number>(5);

  // Axes — initialize from defaults of the first 1 or 2 sweepable params.
  const initialParams = SWEEPABLE_PARAMS["threshold_entry"];
  const [enableYAxis, setEnableYAxis] = useState<boolean>(true);
  const [xAxis, setXAxis] = useState<AxisState>({
    param: initialParams[0].key,
    start: initialParams[0].defaultStart,
    end: initialParams[0].defaultEnd,
    steps: 10,
  });
  const [yAxis, setYAxis] = useState<AxisState>({
    param: initialParams[1].key,
    start: initialParams[1].defaultStart,
    end: initialParams[1].defaultEnd,
    steps: 10,
  });

  // When the user switches strategy type, snap the axes to the new
  // strategy's sweepable params (otherwise the user sees a `lookback`
  // axis after switching to threshold_entry which doesn't have it).
  function switchStrategy(t: StrategyType) {
    setStrategyType(t);
    const params = SWEEPABLE_PARAMS[t];
    setXAxis({
      param: params[0].key,
      start: params[0].defaultStart,
      end: params[0].defaultEnd,
      steps: 10,
    });
    if (params.length > 1) {
      setYAxis({
        param: params[1].key,
        start: params[1].defaultStart,
        end: params[1].defaultEnd,
        steps: 10,
      });
    }
  }

  const totalCells = xAxis.steps * (enableYAxis ? yAxis.steps : 1);

  function buildBaseSpec(): Record<string, unknown> {
    switch (strategyType) {
      case "threshold_entry":
        return {
          type: "threshold_entry",
          threshold: pinnedThreshold,
          direction,
          side,
          size_usd: pinnedSizeUsd,
        };
      case "mean_reversion":
        return {
          type: "mean_reversion",
          lookback: pinnedLookback,
          z_threshold: pinnedZ,
          size_usd: pinnedSizeUsd,
        };
      case "time_before_resolution":
        return {
          type: "time_before_resolution",
          minutes_before: pinnedMinBefore,
          minutes_window: pinnedMinWindow,
          side,
          size_usd: pinnedSizeUsd,
        };
    }
  }

  async function submit() {
    if (submitting) return;
    if (totalCells > maxSweepCells) {
      toast.error(`Your tier caps sweep at ${maxSweepCells} cells.`);
      return;
    }
    if (marketLimit > maxMarketLimit) {
      toast.error(`Your tier caps market_limit at ${maxMarketLimit}.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/backtest/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: buildBaseSpec(),
          ticker,
          market_limit: marketLimit,
          x_axis: xAxis,
          ...(enableYAxis ? { y_axis: yAxis } : {}),
        }),
      });
      if (!res.ok && res.status !== 202) {
        const body = await res.json().catch(() => ({}));
        toast.error(body?.detail || body?.error || `Submit failed (${res.status})`);
        return;
      }
      const body = await res.json();
      if (!body?.job_id) {
        toast.error("Server didn't return a job_id");
        return;
      }
      router.push(`/dashboard/backtest/sweep/${encodeURIComponent(body.job_id)}`);
    } catch (e: any) {
      toast.error(e?.message || "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const sweepableForType = SWEEPABLE_PARAMS[strategyType];

  // Pro-quant panel layout — each logical section is a q-panel with a
  // numbered mono badge header, matching Strategy Builder so the two
  // configurator pages feel like one product. See globals.css `.q-panel`.
  return (
    <div className="space-y-4">
      {/* Universe */}
      <section className="q-panel">
        <header className="q-panel-header">
          <div className="flex items-center gap-2.5">
            <span className="q-num-badge">S1</span>
            <h3 className="q-section-title">Universe</h3>
          </div>
          <span className="q-section-subtitle">market scope</span>
        </header>
        <div className="p-5 grid grid-cols-2 gap-4">
          <label className="block">
            <span className="q-label">Ticker</span>
            <select
              className="select select-sm select-bordered w-full"
              value={ticker}
              onChange={(e) => setTicker(e.target.value as typeof ticker)}
            >
              {TICKERS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="q-label">Market limit · max {maxMarketLimit}</span>
            <input
              type="number"
              className="input input-sm input-bordered w-full"
              min={1}
              max={maxMarketLimit}
              value={marketLimit}
              onChange={(e) =>
                setMarketLimit(
                  Math.min(Math.max(parseInt(e.target.value) || 1, 1), maxMarketLimit)
                )
              }
            />
          </label>
        </div>
      </section>

      {/* Strategy + pinned params */}
      <section className="q-panel">
        <header className="q-panel-header">
          <div className="flex items-center gap-2.5">
            <span className="q-num-badge">S2</span>
            <h3 className="q-section-title">Strategy · pinned values</h3>
          </div>
          <span className="q-section-subtitle">params not swept</span>
        </header>
        <div className="p-5 space-y-3">
        <label className="block">
          <span className="q-label">Type</span>
          <select
            className="select select-sm select-bordered w-full"
            value={strategyType}
            onChange={(e) => switchStrategy(e.target.value as StrategyType)}
          >
            <option value="threshold_entry">Threshold entry</option>
            <option value="mean_reversion">Mean reversion</option>
            <option value="time_before_resolution">Time before resolution</option>
          </select>
        </label>

        {/* Non-numeric (un-sweepable) params still need values */}
        {strategyType === "threshold_entry" && (
          <div className="grid grid-cols-2 gap-4">
            <SelectField label="Direction" value={direction}
              options={[{ value: "below", label: "Below threshold" }, { value: "above", label: "Above threshold" }]}
              onChange={(v) => setDirection(v as typeof direction)} />
            <SelectField label="Side" value={side}
              options={[{ value: "buy_yes", label: "Buy Up" }, { value: "buy_no", label: "Buy Down" }]}
              onChange={(v) => setSide(v as typeof side)} />
          </div>
        )}
        {strategyType === "time_before_resolution" && (
          <SelectField label="Side" value={side}
            options={[{ value: "buy_yes", label: "Buy Up" }, { value: "buy_no", label: "Buy Down" }]}
            onChange={(v) => setSide(v as typeof side)} />
        )}

        <p className="text-xs opacity-60">
          The values below are used for params <em>not</em> being swept.
          Swept params are overridden cell-by-cell.
        </p>
        <div className="grid grid-cols-2 gap-4">
          {strategyType === "threshold_entry" && (
            <>
              <NumberField label="Threshold" value={pinnedThreshold} step={0.05} min={0} max={1} onChange={setPinnedThreshold} />
              <NumberField label="Size $" value={pinnedSizeUsd} step={5} min={1} onChange={setPinnedSizeUsd} />
            </>
          )}
          {strategyType === "mean_reversion" && (
            <>
              <NumberField label="Lookback" value={pinnedLookback} step={5} min={5} onChange={setPinnedLookback} />
              <NumberField label="Z threshold" value={pinnedZ} step={0.1} min={0.5} onChange={setPinnedZ} />
              <NumberField label="Size $" value={pinnedSizeUsd} step={5} min={1} onChange={setPinnedSizeUsd} />
            </>
          )}
          {strategyType === "time_before_resolution" && (
            <>
              <NumberField label="Minutes before" value={pinnedMinBefore} step={5} min={1} onChange={setPinnedMinBefore} />
              <NumberField label="Window ± min" value={pinnedMinWindow} step={1} min={0} onChange={setPinnedMinWindow} />
              <NumberField label="Size $" value={pinnedSizeUsd} step={5} min={1} onChange={setPinnedSizeUsd} />
            </>
          )}
        </div>
        </div>
      </section>

      {/* X axis */}
      <section className="q-panel">
        <header className="q-panel-header">
          <div className="flex items-center gap-2.5">
            <span className="q-num-badge">X</span>
            <h3 className="q-section-title">X axis · sweep this</h3>
          </div>
          <span className="q-section-subtitle">primary dimension</span>
        </header>
        <div className="p-5">
          <AxisFieldset
            axis={xAxis}
            onChange={setXAxis}
            sweepable={sweepableForType}
          />
        </div>
      </section>

      {/* Y axis */}
      <section className="q-panel">
        <header className="q-panel-header">
          <div className="flex items-center gap-2.5">
            <span className="q-num-badge">Y</span>
            <h3 className="q-section-title">Y axis · 2D sweep</h3>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="checkbox checkbox-xs checkbox-accent"
              checked={enableYAxis}
              onChange={(e) => setEnableYAxis(e.target.checked)}
            />
            <span className="q-section-subtitle">
              {enableYAxis ? "enabled · heatmap" : "disabled · 1D sweep"}
            </span>
          </label>
        </header>
        {enableYAxis && (
          <div className="p-5">
            <AxisFieldset
              axis={yAxis}
              onChange={setYAxis}
              sweepable={sweepableForType.filter((p) => p.key !== xAxis.param)}
            />
          </div>
        )}
      </section>

      {/* Summary + submit */}
      <section className="q-panel">
        <div className="px-5 py-4 flex items-center justify-between gap-4">
          <div className="font-mono text-xs text-base-content/70 tabular-nums">
            <span className="text-base-content font-semibold">{totalCells}</span> backtest{totalCells === 1 ? "" : "s"}
            <span className="text-base-content/30 mx-1.5">×</span>
            <span className="text-base-content font-semibold">{marketLimit}</span> markets
            <span className="text-base-content/30 mx-1.5">=</span>
            <span className="text-primary font-semibold">{(totalCells * marketLimit).toLocaleString()}</span> simulated runs
            {totalCells > maxSweepCells && (
              <div className="text-error text-[11px] mt-1">
                Exceeds tier cap of {maxSweepCells} cells.
              </div>
            )}
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={submitting || totalCells > maxSweepCells}
          >
            {submitting ? "Submitting…" : "Run sweep →"}
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small atoms
// ---------------------------------------------------------------------------

function AxisFieldset({
  axis,
  onChange,
  sweepable,
}: {
  axis: AxisState;
  onChange: (a: AxisState) => void;
  sweepable: ParamSpec[];
}) {
  return (
    <div className="grid grid-cols-4 gap-3">
      <label className="block">
        <span className="q-label">Param</span>
        <select
          className="select select-sm select-bordered w-full"
          value={axis.param}
          onChange={(e) => {
            const p = sweepable.find((s) => s.key === e.target.value);
            if (!p) return;
            onChange({
              ...axis,
              param: p.key,
              start: p.defaultStart,
              end: p.defaultEnd,
            });
          }}
        >
          {sweepable.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>
      </label>
      <NumberField
        label="From"
        value={axis.start}
        step={0.05}
        onChange={(v) => onChange({ ...axis, start: v })}
        small
      />
      <NumberField
        label="To"
        value={axis.end}
        step={0.05}
        onChange={(v) => onChange({ ...axis, end: v })}
        small
      />
      <NumberField
        label="Steps"
        value={axis.steps}
        step={1}
        min={2}
        max={50}
        onChange={(v) => onChange({ ...axis, steps: Math.round(v) })}
        small
      />
    </div>
  );
}

function NumberField({
  label, value, step, min, max, onChange, small,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
  small?: boolean;
}) {
  return (
    <label className="block">
      <span className="q-label">{label}</span>
      <input
        type="number"
        className={`input input-bordered w-full ${small ? "input-sm" : "input-sm"}`}
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
      />
    </label>
  );
}

function SelectField({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="q-label">{label}</span>
      <select
        className="select select-sm select-bordered w-full"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
