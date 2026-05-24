"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";

type StrategyType =
  | "threshold_entry"
  | "mean_reversion"
  | "time_before_resolution";

const TICKERS = ["BTC", "ETH", "SOL"] as const;
const EVENT_TYPES = ["5m", "15m", "1h", "4h", "daily_up_down"] as const;

export default function NewPaperStrategyForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  // Identity
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState<(typeof TICKERS)[number] | "">("BTC");
  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number] | "">(
    "1h"
  );
  const [sizeUsd, setSizeUsd] = useState<number>(10);

  // Strategy
  const [strategyType, setStrategyType] = useState<StrategyType>("threshold_entry");
  const [threshold, setThreshold] = useState(0.5);
  const [direction, setDirection] = useState<"below" | "above">("above");
  const [side, setSide] = useState<"buy_yes" | "buy_no">("buy_no");
  const [lookback, setLookback] = useState(30);
  const [zThreshold, setZThreshold] = useState(2.0);
  const [minutesBefore, setMinutesBefore] = useState(60);
  const [minutesWindow, setMinutesWindow] = useState(5);

  function buildSpec(): Record<string, unknown> {
    switch (strategyType) {
      case "threshold_entry":
        return {
          type: "threshold_entry",
          threshold,
          direction,
          side,
          size_usd: sizeUsd,
        };
      case "mean_reversion":
        return {
          type: "mean_reversion",
          lookback,
          z_threshold: zThreshold,
          size_usd: sizeUsd,
        };
      case "time_before_resolution":
        return {
          type: "time_before_resolution",
          minutes_before: minutesBefore,
          minutes_window: minutesWindow,
          side,
          size_usd: sizeUsd,
        };
    }
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/paper/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || null,
          strategy_spec: buildSpec(),
          ticker: ticker || null,
          event_type: eventType || null,
          size_usd: sizeUsd,
        }),
      });
      if (!res.ok && res.status !== 201) {
        const body = await res.json().catch(() => ({}));
        toast.error(body?.detail || body?.error || `Create failed (${res.status})`);
        return;
      }
      const body = await res.json();
      toast.success("Strategy created — paper trading now");
      router.push(`/dashboard/paper/${encodeURIComponent(body.paper_strategy_id)}`);
    } catch (e: any) {
      toast.error(e?.message || "Create failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 rounded-lg border border-base-300 bg-base-100 p-6">
      <fieldset className="space-y-3">
        <legend className="font-semibold">Identity</legend>
        <label className="form-control">
          <span className="label-text">Name (optional)</span>
          <input
            type="text"
            className="input input-bordered"
            placeholder="e.g. BTC 1h contrarian"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={128}
          />
        </label>
      </fieldset>

      <fieldset className="space-y-3 border-t border-base-300 pt-4">
        <legend className="font-semibold">Universe</legend>
        <div className="grid grid-cols-3 gap-4">
          <label className="form-control">
            <span className="label-text">Ticker</span>
            <select
              className="select select-bordered"
              value={ticker}
              onChange={(e) => setTicker(e.target.value as typeof ticker)}
            >
              <option value="">Any</option>
              {TICKERS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="form-control">
            <span className="label-text">Window</span>
            <select
              className="select select-bordered"
              value={eventType}
              onChange={(e) => setEventType(e.target.value as typeof eventType)}
            >
              <option value="">Any</option>
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="form-control">
            <span className="label-text">Size $ / trade</span>
            <input
              type="number"
              className="input input-bordered"
              step={5}
              min={1}
              value={sizeUsd}
              onChange={(e) => setSizeUsd(parseFloat(e.target.value) || 10)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-3 border-t border-base-300 pt-4">
        <legend className="font-semibold">Strategy</legend>
        <label className="form-control">
          <span className="label-text">Type</span>
          <select
            className="select select-bordered"
            value={strategyType}
            onChange={(e) => setStrategyType(e.target.value as StrategyType)}
          >
            <option value="threshold_entry">Threshold entry</option>
            <option value="mean_reversion">Mean reversion (needs history — v0 limited)</option>
            <option value="time_before_resolution">Time before resolution</option>
          </select>
        </label>

        {strategyType === "threshold_entry" && (
          <div className="grid grid-cols-2 gap-4">
            <NumberField label="Threshold (0-1)" value={threshold} step={0.05} min={0} max={1} onChange={setThreshold} />
            <SelectField label="Direction" value={direction}
              options={[{ value: "below", label: "Below" }, { value: "above", label: "Above" }]}
              onChange={(v) => setDirection(v as typeof direction)} />
            <SelectField label="Side" value={side}
              options={[{ value: "buy_yes", label: "Buy Up" }, { value: "buy_no", label: "Buy Down" }]}
              onChange={(v) => setSide(v as typeof side)} />
          </div>
        )}
        {strategyType === "mean_reversion" && (
          <div className="grid grid-cols-2 gap-4">
            <NumberField label="Lookback" value={lookback} step={5} min={5} onChange={setLookback} />
            <NumberField label="Z threshold" value={zThreshold} step={0.1} min={0.5} onChange={setZThreshold} />
          </div>
        )}
        {strategyType === "time_before_resolution" && (
          <div className="grid grid-cols-2 gap-4">
            <NumberField label="Minutes before" value={minutesBefore} step={5} min={1} onChange={setMinutesBefore} />
            <NumberField label="Window ± min" value={minutesWindow} step={1} min={0} onChange={setMinutesWindow} />
            <SelectField label="Side" value={side}
              options={[{ value: "buy_yes", label: "Buy Up" }, { value: "buy_no", label: "Buy Down" }]}
              onChange={(v) => setSide(v as typeof side)} />
          </div>
        )}
      </fieldset>

      <div className="flex justify-end border-t border-base-300 pt-4">
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={submitting}
        >
          {submitting ? "Creating…" : "Start paper trading"}
        </button>
      </div>
    </div>
  );
}

function NumberField({ label, value, step, min, max, onChange }: {
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

function SelectField({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="form-control">
      <span className="label-text">{label}</span>
      <select className="select select-bordered" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
