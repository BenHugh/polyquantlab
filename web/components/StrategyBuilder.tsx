"use client";

/**
 * Visual no-code strategy builder.
 *
 * Output is a `condition_based` strategy spec consumed by the backtest
 * worker (see backtest/conditions.py + backtest/strategies.py).
 *
 * Sections mirror PolyBackTest's UI so a trader migrating from there
 * recognises the layout, but the underlying engine is ours — meaning
 * fills walk the actual recorded order book, fees use Polymarket's
 * 2026 price-dependent formula, and the result page surfaces the
 * Sharpe / max-DD / win-rate columns straight from our engine.
 *
 * Submit goes to /api/backtest → redirects to /dashboard/backtest/[id].
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import toast from "react-hot-toast";

type Ticker = "BTC" | "ETH" | "SOL";
type EventType = "5m" | "15m" | "1h" | "4h" | "daily_up_down";
type Op = ">=" | ">" | "<=" | "<" | "==";
type ConditionType = "token_price" | "spread" | "time_to_resolution_s";
type TokenSide = "yes" | "no";
type TradeLogic = "always_up" | "always_down";
type FillMode = "walk_book" | "mid";

interface Condition {
  id: string;
  type: ConditionType;
  side?: TokenSide; // only used for token_price / spread
  op: Op;
  value: number;
}

interface BuilderState {
  // Setup
  ticker: Ticker;
  eventType: EventType;
  marketLimit: number;
  sizeUsd: number;
  maxTradesPerMarket: number;
  fillMode: FillMode;
  maxFillPrice: number;
  since: string;
  until: string;
  // Conditions
  tradeLogic: TradeLogic;
  entry: Condition[];
  takeProfit: Condition[];
  stopLoss: Condition[];
}

const TYPE_LABELS: Record<ConditionType, string> = {
  token_price: "Token price",
  spread: "Spread",
  time_to_resolution_s: "Time to resolution (s)",
};

const TYPE_DEFAULT_VALUE: Record<ConditionType, number> = {
  token_price: 0.6,
  spread: 0.05,
  time_to_resolution_s: 300,
};

const newCondition = (
  type: ConditionType,
  side: TokenSide = "yes",
): Condition => ({
  id: Math.random().toString(36).slice(2),
  type,
  side: type === "time_to_resolution_s" ? undefined : side,
  op: type === "time_to_resolution_s" ? "<=" : ">=",
  value: TYPE_DEFAULT_VALUE[type],
});

const DEFAULT_STATE: BuilderState = {
  ticker: "BTC",
  eventType: "5m",
  marketLimit: 50,
  sizeUsd: 10,
  maxTradesPerMarket: 1,
  fillMode: "walk_book",
  // 0.85 default: refuses fills above 85¢. Catches the wide-book trap
  // where mid=0.60 but best ask is 0.90 (extremely common for short-
  // dated markets near resolution). Users can disable by setting 1.0.
  maxFillPrice: 0.85,
  since: "",
  until: "",
  tradeLogic: "always_up",
  entry: [newCondition("token_price")],
  takeProfit: [],
  stopLoss: [],
};

const LOCAL_KEY = "pql-strategy-builder";

function loadStored(): BuilderState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Merge into DEFAULT_STATE so any fields added since the last save
    // (e.g. fillMode / maxFillPrice in Phase O) fall back to defaults
    // instead of arriving as undefined and exploding on .toFixed().
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return null;
  }
}

export default function StrategyBuilder() {
  const router = useRouter();
  const [state, setState] = useState<BuilderState>(
    () => loadStored() ?? DEFAULT_STATE,
  );
  const [submitting, setSubmitting] = useState(false);

  function persist(next: BuilderState) {
    setState(next);
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
    } catch {
      // localStorage full / disabled — silently skip persistence.
    }
  }

  function update<K extends keyof BuilderState>(key: K, value: BuilderState[K]) {
    persist({ ...state, [key]: value });
  }

  function addCond(section: "entry" | "takeProfit" | "stopLoss") {
    persist({ ...state, [section]: [...state[section], newCondition("token_price")] });
  }
  function removeCond(section: "entry" | "takeProfit" | "stopLoss", id: string) {
    persist({ ...state, [section]: state[section].filter((c) => c.id !== id) });
  }
  function patchCond(
    section: "entry" | "takeProfit" | "stopLoss",
    id: string,
    patch: Partial<Condition>,
  ) {
    persist({
      ...state,
      [section]: state[section].map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...patch };
        if (patch.type) {
          // Reset value + side when condition type changes so the form
          // never holds stale fields that don't match the new primitive
          // (e.g. a "side: yes" hanging on a time_to_resolution row).
          next.value = TYPE_DEFAULT_VALUE[patch.type];
          next.side = patch.type === "time_to_resolution_s" ? undefined : "yes";
          next.op = patch.type === "time_to_resolution_s" ? "<=" : ">=";
        }
        return next;
      }),
    });
  }

  // -- Plain English summary (mirrors backtest/conditions.py:humanise) --

  function humanise(c: Condition): string {
    const op =
      { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=" }[c.op] || c.op;
    if (c.type === "token_price") {
      return `${c.side?.toUpperCase()} price ${op} ${c.value}`;
    }
    if (c.type === "spread") {
      return `${c.side?.toUpperCase()} spread ${op} ${c.value}`;
    }
    return `time to res ${op} ${c.value}s`;
  }

  const readsAs = useMemo(() => {
    const entryEn =
      state.entry.length === 0
        ? "(no entry rules)"
        : state.entry.map(humanise).join(" AND ");
    const tpEn =
      state.takeProfit.length === 0
        ? null
        : state.takeProfit.map(humanise).join(" AND ");
    const slEn =
      state.stopLoss.length === 0
        ? null
        : state.stopLoss.map(humanise).join(" AND ");
    const dir = state.tradeLogic === "always_up" ? "UP" : "DOWN";
    return { entryEn, tpEn, slEn, dir };
  }, [state]);

  // -- Submit ------------------------------------------------------------

  async function submit() {
    if (state.entry.length === 0) {
      toast.error("Add at least one entry condition before running.");
      return;
    }
    setSubmitting(true);

    const strategy = {
      type: "condition_based",
      entry: state.entry.map(stripId),
      take_profit: state.takeProfit.map(stripId),
      stop_loss: state.stopLoss.map(stripId),
      trade_logic: state.tradeLogic,
      size_usd: state.sizeUsd,
      max_trades_per_market: state.maxTradesPerMarket,
      fill_mode: state.fillMode,
      max_fill_price: state.maxFillPrice,
    };
    const payload = {
      strategy,
      ticker: state.ticker,
      event_type: state.eventType,
      market_limit: state.marketLimit,
      since: state.since || undefined,
      until: state.until || undefined,
    };

    try {
      const r = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data?.error || `Submit failed (${r.status})`);
        setSubmitting(false);
        return;
      }
      const id = data.job_id || data.id;
      if (!id) {
        toast.error("Backend returned no job_id");
        setSubmitting(false);
        return;
      }
      router.push(`/dashboard/backtest/${id}`);
    } catch (e: any) {
      toast.error(e?.message || "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <Section
        n="01"
        title="Setup"
        subtitle="Pick the universe and bet size"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="Coin">
            <select
              className="select select-sm select-bordered w-full"
              value={state.ticker}
              onChange={(e) => update("ticker", e.target.value as Ticker)}
            >
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
              <option value="SOL">SOL</option>
            </select>
          </Field>
          <Field label="Timeframe">
            <select
              className="select select-sm select-bordered w-full"
              value={state.eventType}
              onChange={(e) => update("eventType", e.target.value as EventType)}
            >
              <option value="5m">5m</option>
              <option value="15m">15m</option>
              <option value="1h">1h</option>
              <option value="4h">4h</option>
              <option value="daily_up_down">Daily</option>
            </select>
          </Field>
          <Field label={`Markets · ${state.marketLimit}`}>
            <input
              type="range"
              min={5}
              max={200}
              step={5}
              className="range range-xs range-primary"
              value={state.marketLimit}
              onChange={(e) =>
                update("marketLimit", parseInt(e.target.value, 10))
              }
            />
          </Field>
          <Field label="Position size ($)">
            <input
              type="number"
              min={1}
              step={1}
              className="input input-sm input-bordered w-full"
              value={state.sizeUsd}
              onChange={(e) =>
                update("sizeUsd", parseFloat(e.target.value) || 0)
              }
            />
          </Field>
          <Field label="Trades / market">
            <input
              type="number"
              min={1}
              max={10}
              className="input input-sm input-bordered w-full"
              value={state.maxTradesPerMarket}
              onChange={(e) =>
                update("maxTradesPerMarket", parseInt(e.target.value, 10) || 1)
              }
            />
          </Field>
          <Field
            label="Fill mode"
          >
            <select
              className="select select-sm select-bordered w-full"
              value={state.fillMode}
              onChange={(e) => update("fillMode", e.target.value as FillMode)}
              title="Walk-book = realistic (hit best ask). Mid = optimistic, matches PolyBackTest."
            >
              <option value="walk_book">Walk book (realistic)</option>
              <option value="mid">Mid fill (optimistic)</option>
            </select>
          </Field>
          <Field label={`Max fill price · ${state.maxFillPrice.toFixed(2)}`}>
            <input
              type="range"
              min={0.50}
              max={1.00}
              step={0.01}
              className="range range-xs range-primary"
              value={state.maxFillPrice}
              onChange={(e) =>
                update("maxFillPrice", parseFloat(e.target.value))
              }
              title="Refuse entries when the best ask exceeds this. 1.00 = no limit."
            />
          </Field>
          <Field label="Since (optional)">
            <input
              type="datetime-local"
              className="input input-sm input-bordered w-full"
              value={state.since}
              onChange={(e) => update("since", e.target.value)}
            />
          </Field>
          <Field label="Until (optional)">
            <input
              type="datetime-local"
              className="input input-sm input-bordered w-full"
              value={state.until}
              onChange={(e) => update("until", e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        n="02"
        title="Entry Conditions"
        subtitle="When should we look for a trade?"
        readsAs={`Enter when ${readsAs.entryEn}.`}
      >
        <ConditionList
          conditions={state.entry}
          onAdd={() => addCond("entry")}
          onRemove={(id) => removeCond("entry", id)}
          onPatch={(id, patch) => patchCond("entry", id, patch)}
        />
      </Section>

      <Section
        n="03"
        title="Trade Logic"
        subtitle="Buy UP or DOWN token?"
        readsAs={`Every trade buys the ${readsAs.dir} token.`}
      >
        <select
          className="select select-sm select-bordered max-w-xs"
          value={state.tradeLogic}
          onChange={(e) => update("tradeLogic", e.target.value as TradeLogic)}
        >
          <option value="always_up">Always UP</option>
          <option value="always_down">Always DOWN</option>
        </select>
      </Section>

      <Section
        n="04"
        title="Take Profit"
        subtitle="Exit when conditions match (winning side)"
        readsAs={
          readsAs.tpEn ? `Exit on profit when ${readsAs.tpEn}.` : null
        }
        emptyHint="No TP rules — positions hold to resolution unless stopped out."
      >
        <ConditionList
          conditions={state.takeProfit}
          onAdd={() => addCond("takeProfit")}
          onRemove={(id) => removeCond("takeProfit", id)}
          onPatch={(id, patch) => patchCond("takeProfit", id, patch)}
        />
      </Section>

      <Section
        n="05"
        title="Stop Loss"
        subtitle="Exit when conditions match (losing side)"
        readsAs={
          readsAs.slEn ? `Exit on loss when ${readsAs.slEn}.` : null
        }
        emptyHint="No SL rules — positions ride to resolution unless TP triggers."
      >
        <ConditionList
          conditions={state.stopLoss}
          onAdd={() => addCond("stopLoss")}
          onRemove={(id) => removeCond("stopLoss", id)}
          onPatch={(id, patch) => patchCond("stopLoss", id, patch)}
        />
      </Section>

      {state.takeProfit.length === 0 && state.stopLoss.length === 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
          Heads up — Take Profit and Stop Loss are both empty. Trades will
          only exit on resolution.
        </div>
      )}

      {state.fillMode === "mid" && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
          Mid-fill mode is <strong>optimistic</strong> — you can&apos;t actually
          fill at mid when the book is wide. Use it to compare against
          PolyBackTest&apos;s curve, but trust walk-book results for sizing.
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => persist(DEFAULT_STATE)}
          disabled={submitting}
        >
          Reset
        </button>
        <button
          className="btn btn-primary btn-sm rounded-lg"
          onClick={submit}
          disabled={submitting}
        >
          {submitting ? "Submitting…" : "Run backtest →"}
        </button>
      </div>
    </div>
  );
}

/* ─── Layout sub-components ──────────────────────────────────────── */

function Section({
  n,
  title,
  subtitle,
  children,
  readsAs,
  emptyHint,
}: {
  n: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  readsAs?: string | null;
  emptyHint?: string;
}) {
  return (
    <section className="rounded-xl border border-base-300 bg-base-200/30 overflow-hidden">
      <div className="px-5 py-4 border-b border-base-300/60 flex items-baseline justify-between">
        <div>
          <span className="badge badge-sm badge-ghost font-mono mr-2">
            {n}
          </span>
          <span className="font-semibold tracking-tight">{title}</span>
        </div>
        <span className="text-xs text-base-content/50">{subtitle}</span>
      </div>
      <div className="p-5 space-y-3">{children}</div>
      {(readsAs || emptyHint) && (
        <div className="px-5 py-3 border-t border-base-300/60 bg-base-200/40 text-xs">
          <div className="text-[10px] uppercase tracking-widest text-base-content/40 mb-1">
            Reads as
          </div>
          <div className="text-base-content/70 font-mono">
            {readsAs ?? emptyHint}
          </div>
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-widest text-base-content/50 block mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

function ConditionList({
  conditions,
  onAdd,
  onRemove,
  onPatch,
}: {
  conditions: Condition[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onPatch: (id: string, patch: Partial<Condition>) => void;
}) {
  return (
    <div className="space-y-2">
      {conditions.length === 0 && (
        <div className="text-center text-xs text-base-content/40 py-3 font-mono">
          No conditions yet — add one below
        </div>
      )}
      {conditions.map((c) => (
        <ConditionRow
          key={c.id}
          c={c}
          onRemove={() => onRemove(c.id)}
          onPatch={(patch) => onPatch(c.id, patch)}
        />
      ))}
      <button
        onClick={onAdd}
        className="btn btn-ghost btn-sm w-full justify-start border border-dashed border-base-300/60"
      >
        + Add condition
      </button>
    </div>
  );
}

function ConditionRow({
  c,
  onRemove,
  onPatch,
}: {
  c: Condition;
  onRemove: () => void;
  onPatch: (patch: Partial<Condition>) => void;
}) {
  const showSide = c.type !== "time_to_resolution_s";
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-base-100 border border-base-300/60">
      <select
        className="select select-xs select-bordered"
        value={c.type}
        onChange={(e) => onPatch({ type: e.target.value as ConditionType })}
      >
        <option value="token_price">{TYPE_LABELS.token_price}</option>
        <option value="spread">{TYPE_LABELS.spread}</option>
        <option value="time_to_resolution_s">
          {TYPE_LABELS.time_to_resolution_s}
        </option>
      </select>
      {showSide && (
        <select
          className="select select-xs select-bordered"
          value={c.side ?? "yes"}
          onChange={(e) => onPatch({ side: e.target.value as TokenSide })}
        >
          <option value="yes">UP</option>
          <option value="no">DOWN</option>
        </select>
      )}
      <select
        className="select select-xs select-bordered"
        value={c.op}
        onChange={(e) => onPatch({ op: e.target.value as Op })}
      >
        <option value=">=">≥</option>
        <option value=">">{">"}</option>
        <option value="<=">≤</option>
        <option value="<">{"<"}</option>
        <option value="==">=</option>
      </select>
      <input
        type="number"
        className="input input-xs input-bordered w-28 tabular-nums"
        step={c.type === "time_to_resolution_s" ? 30 : 0.01}
        value={c.value}
        onChange={(e) =>
          onPatch({ value: parseFloat(e.target.value) || 0 })
        }
      />
      <span className="text-[10px] text-base-content/40 font-mono">
        {c.type === "token_price" || c.type === "spread"
          ? "(0 – 1)"
          : "(seconds)"}
      </span>
      <button
        className="btn btn-ghost btn-xs btn-square ml-auto text-base-content/50 hover:text-error"
        onClick={onRemove}
        aria-label="Remove condition"
      >
        ×
      </button>
    </div>
  );
}

/* ─── Helpers ────────────────────────────────────────────────────── */

function stripId(c: Condition) {
  const { id: _, ...rest } = c;
  return rest;
}
