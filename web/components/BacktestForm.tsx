"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";

/**
 * Strategy builder for the dashboard.
 *
 * Mirrors `backtest/strategies.py:STRATEGY_REGISTRY`:
 *   - threshold_entry    {threshold, direction, side, size_usd}
 *   - mean_reversion     {lookback, z_threshold, size_usd}
 *   - time_before_resolution {minutes_before, minutes_window, side, size_usd}
 *
 * On submit we POST /api/backtest. FastAPI returns 202 + job_id; we
 * navigate to /dashboard/backtest/[id] which handles the polling UI.
 */

type StrategyType =
  | "threshold_entry"
  | "mean_reversion"
  | "time_before_resolution";

const TICKERS = ["BTC", "ETH", "SOL"] as const;

interface FormState {
  ticker: (typeof TICKERS)[number];
  marketLimit: number;
  strategyType: StrategyType;
  // threshold_entry
  threshold: number;
  direction: "below" | "above";
  side: "buy_yes" | "buy_no";
  sizeUsd: number;
  // mean_reversion
  lookback: number;
  zThreshold: number;
  // time_before_resolution
  minutesBefore: number;
  minutesWindow: number;
}

const DEFAULTS: FormState = {
  ticker: "BTC",
  marketLimit: 10,
  strategyType: "threshold_entry",
  threshold: 0.3,
  direction: "below",
  side: "buy_yes",
  sizeUsd: 100,
  lookback: 30,
  zThreshold: 2.0,
  minutesBefore: 60,
  minutesWindow: 5,
};

export default function BacktestForm({
  maxMarketLimit,
}: {
  maxMarketLimit: number;
}) {
  const router = useRouter();
  const [s, setS] = useState<FormState>({
    ...DEFAULTS,
    marketLimit: Math.min(DEFAULTS.marketLimit, maxMarketLimit),
  });
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof FormState>(k: K, v: FormState[K]) {
    setS((prev) => ({ ...prev, [k]: v }));
  }

  function buildStrategySpec(): Record<string, unknown> {
    switch (s.strategyType) {
      case "threshold_entry":
        return {
          type: "threshold_entry",
          threshold: s.threshold,
          direction: s.direction,
          side: s.side,
          size_usd: s.sizeUsd,
        };
      case "mean_reversion":
        return {
          type: "mean_reversion",
          lookback: s.lookback,
          z_threshold: s.zThreshold,
          size_usd: s.sizeUsd,
        };
      case "time_before_resolution":
        return {
          type: "time_before_resolution",
          minutes_before: s.minutesBefore,
          minutes_window: s.minutesWindow,
          side: s.side,
          size_usd: s.sizeUsd,
        };
    }
  }

  async function submit() {
    if (submitting) return;
    if (s.marketLimit > maxMarketLimit) {
      toast.error(`Your tier caps market_limit at ${maxMarketLimit}.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: buildStrategySpec(),
          ticker: s.ticker,
          market_limit: s.marketLimit,
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
      router.push(`/dashboard/backtest/${encodeURIComponent(body.job_id)}`);
    } catch (e: any) {
      toast.error(e?.message || "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 rounded-lg border border-base-300 bg-base-100 p-6">
      {/* Universe */}
      <fieldset className="space-y-3">
        <legend className="font-semibold">Universe</legend>
        <div className="grid grid-cols-2 gap-4">
          <label className="form-control">
            <span className="label-text">Ticker</span>
            <select
              className="select select-bordered"
              value={s.ticker}
              onChange={(e) => update("ticker", e.target.value as typeof s.ticker)}
            >
              {TICKERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="form-control">
            <span className="label-text">
              Market limit{" "}
              <span className="opacity-60">
                (max {maxMarketLimit} on your tier)
              </span>
            </span>
            <input
              type="number"
              className="input input-bordered"
              min={1}
              max={maxMarketLimit}
              value={s.marketLimit}
              onChange={(e) =>
                update("marketLimit", clamp(parseInt(e.target.value) || 1, 1, maxMarketLimit))
              }
            />
          </label>
        </div>
      </fieldset>

      {/* Strategy */}
      <fieldset className="space-y-3">
        <legend className="font-semibold">Strategy</legend>
        <label className="form-control">
          <span className="label-text">Type</span>
          <select
            className="select select-bordered"
            value={s.strategyType}
            onChange={(e) =>
              update("strategyType", e.target.value as StrategyType)
            }
          >
            <option value="threshold_entry">Threshold entry</option>
            <option value="mean_reversion">Mean reversion</option>
            <option value="time_before_resolution">Time before resolution</option>
          </select>
        </label>

        {s.strategyType === "threshold_entry" && (
          <div className="grid grid-cols-2 gap-4">
            <NumberField
              label="Threshold (0-1)"
              value={s.threshold}
              step={0.01}
              min={0}
              max={1}
              onChange={(v) => update("threshold", v)}
            />
            <SelectField
              label="Direction"
              value={s.direction}
              options={[
                { value: "below", label: "Below threshold" },
                { value: "above", label: "Above threshold" },
              ]}
              onChange={(v) => update("direction", v as typeof s.direction)}
            />
            <SelectField
              label="Side"
              value={s.side}
              options={SIDE_OPTIONS}
              onChange={(v) => update("side", v as typeof s.side)}
            />
            <NumberField
              label="Size (USD)"
              value={s.sizeUsd}
              step={10}
              min={1}
              onChange={(v) => update("sizeUsd", v)}
            />
          </div>
        )}

        {s.strategyType === "mean_reversion" && (
          <div className="grid grid-cols-2 gap-4">
            <NumberField
              label="Lookback (snapshots)"
              value={s.lookback}
              step={1}
              min={5}
              onChange={(v) => update("lookback", v)}
            />
            <NumberField
              label="Z-score threshold"
              value={s.zThreshold}
              step={0.1}
              min={0.5}
              onChange={(v) => update("zThreshold", v)}
            />
            <NumberField
              label="Size (USD)"
              value={s.sizeUsd}
              step={10}
              min={1}
              onChange={(v) => update("sizeUsd", v)}
            />
          </div>
        )}

        {s.strategyType === "time_before_resolution" && (
          <div className="grid grid-cols-2 gap-4">
            <NumberField
              label="Minutes before resolution"
              value={s.minutesBefore}
              step={1}
              min={1}
              onChange={(v) => update("minutesBefore", v)}
            />
            <NumberField
              label="Window (± minutes)"
              value={s.minutesWindow}
              step={1}
              min={0}
              onChange={(v) => update("minutesWindow", v)}
            />
            <SelectField
              label="Side"
              value={s.side}
              options={SIDE_OPTIONS}
              onChange={(v) => update("side", v as typeof s.side)}
            />
            <NumberField
              label="Size (USD)"
              value={s.sizeUsd}
              step={10}
              min={1}
              onChange={(v) => update("sizeUsd", v)}
            />
          </div>
        )}
      </fieldset>

      <div className="flex justify-end">
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={submitting}
        >
          {submitting ? "Submitting…" : "Run backtest"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small form atoms — kept inline so the strategy switcher stays readable
// ---------------------------------------------------------------------------

const SIDE_OPTIONS = [
  { value: "buy_yes", label: "Buy Up (YES)" },
  { value: "buy_no", label: "Buy Down (NO)" },
];

function NumberField({
  label,
  value,
  step,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="form-control">
      <span className="label-text">{label}</span>
      <input
        type="number"
        className="input input-bordered"
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
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="form-control">
      <span className="label-text">{label}</span>
      <select
        className="select select-bordered"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
