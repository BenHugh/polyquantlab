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
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";

type Ticker = "BTC" | "ETH" | "SOL";
type EventType = "5m" | "15m" | "1h" | "4h" | "daily_up_down";
type Op =
  | ">="
  | ">"
  | "<="
  | "<"
  | "=="
  | "!="
  | "crosses_above"
  | "crosses_below";
type ConditionType =
  | "token_price"
  | "spread"
  | "time_to_resolution_s"
  | "time_since_market_open_s"
  | "coin_move_since_open_usd"
  | "coin_move_since_open_pct"
  | "coin_price_volatility"
  | "token_price_volatility";
type TokenSide = "yes" | "no";
type TradeLogic = "always_up" | "always_down";
type FillMode = "walk_book" | "mid";

// Parameter spec — mirrors backtest/conditions.py:PARAM_SPECS. The
// ConditionRow component reads from this to render the right set of
// operators / side toggle / window field per parameter type.
interface ParamSpec {
  label: string;
  description: string;
  unit: "probability" | "seconds" | "usd" | "percent" | "stddev";
  defaultValue: number;
  defaultOp: Op;
  validOps: readonly Op[];
  hasSide: boolean;
  needsWindow: boolean;
}

const BASIC_OPS: readonly Op[] = [">=", ">", "<=", "<", "==", "!="];
const ASYM_OPS: readonly Op[] = [">=", ">", "<=", "<"];
const CROSS_OPS: readonly Op[] = ["crosses_above", "crosses_below"];
const FULL_OPS: readonly Op[] = [...BASIC_OPS, ...CROSS_OPS];

const PARAM_SPECS: Record<ConditionType, ParamSpec> = {
  token_price: {
    label: "Token price",
    description: "Live mid of the UP or DOWN token, 0–1.",
    unit: "probability",
    defaultValue: 0.6,
    defaultOp: ">=",
    validOps: FULL_OPS,
    hasSide: true,
    needsWindow: false,
  },
  spread: {
    label: "Bid-ask spread",
    description: "Best ask − best bid on the side. Tight = real liquidity.",
    unit: "probability",
    defaultValue: 0.05,
    defaultOp: "<=",
    validOps: ASYM_OPS,
    hasSide: true,
    needsWindow: false,
  },
  time_to_resolution_s: {
    label: "Time until market close",
    description: "Seconds until the market resolves.",
    unit: "seconds",
    defaultValue: 300,
    defaultOp: "<=",
    validOps: ASYM_OPS,
    hasSide: false,
    needsWindow: false,
  },
  time_since_market_open_s: {
    label: "Time since market open",
    description: "Seconds since the first recorded snapshot.",
    unit: "seconds",
    defaultValue: 30,
    defaultOp: ">=",
    validOps: ASYM_OPS,
    hasSide: false,
    needsWindow: false,
  },
  coin_move_since_open_usd: {
    label: "Coin move since open ($)",
    description: "Current underlying minus underlying at market open.",
    unit: "usd",
    defaultValue: 50,
    defaultOp: ">=",
    validOps: FULL_OPS,
    hasSide: false,
    needsWindow: false,
  },
  coin_move_since_open_pct: {
    label: "Coin move since open (%)",
    description: "% change of underlying since market open.",
    unit: "percent",
    defaultValue: 0.1,
    defaultOp: ">=",
    validOps: FULL_OPS,
    hasSide: false,
    needsWindow: false,
  },
  coin_price_volatility: {
    label: "Coin price volatility",
    description: "σ of underlying over a recent window.",
    unit: "stddev",
    defaultValue: 5,
    defaultOp: ">=",
    validOps: ASYM_OPS,
    hasSide: false,
    needsWindow: true,
  },
  token_price_volatility: {
    label: "Token price volatility",
    description: "σ of token mid over a recent window.",
    unit: "stddev",
    defaultValue: 0.05,
    defaultOp: ">=",
    validOps: ASYM_OPS,
    hasSide: true,
    needsWindow: true,
  },
};

const OP_LABELS: Record<Op, string> = {
  ">=": "≥",
  ">": ">",
  "<=": "≤",
  "<": "<",
  "==": "=",
  "!=": "≠",
  crosses_above: "crosses ↑",
  crosses_below: "crosses ↓",
};

const UNIT_HINT: Record<ParamSpec["unit"], string> = {
  probability: "(0 – 1)",
  seconds: "seconds",
  usd: "$",
  percent: "%",
  stddev: "σ",
};

interface Condition {
  id: string;
  type: ConditionType;
  side?: TokenSide;       // only present when PARAM_SPECS[type].hasSide
  op: Op;
  value: number;
  window_sec?: number;    // only present when PARAM_SPECS[type].needsWindow
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

const newCondition = (
  type: ConditionType = "token_price",
  side: TokenSide = "yes",
): Condition => {
  const spec = PARAM_SPECS[type];
  return {
    id: Math.random().toString(36).slice(2),
    type,
    side: spec.hasSide ? side : undefined,
    op: spec.defaultOp,
    value: spec.defaultValue,
    window_sec: spec.needsWindow ? 60 : undefined,
  };
};

// ─── Templates registry ─────────────────────────────────────────────
// Each template returns a partial BuilderState that's merged on top of
// DEFAULT_STATE. Keep the list small + named after what real bot
// traders look for; the goal is to lower the cold-start gap so a new
// user has 8 useful strategies to compare before they have to invent
// their own. Adapted from the patterns we see on r/Polymarket and
// Polymarket Discord quant channels.
interface Template {
  key: string;
  name: string;
  description: string;
  build: () => Partial<BuilderState>;
}

const TEMPLATES: Template[] = [
  {
    key: "buy_and_hold_up",
    name: "Buy & Hold UP",
    description:
      "No conditions — enter at the first fillable snapshot, hold to resolution. Baseline to compare other strategies against.",
    build: () => ({ tradeLogic: "always_up", entry: [], takeProfit: [], stopLoss: [] }),
  },
  {
    key: "buy_and_hold_down",
    name: "Buy & Hold DOWN",
    description:
      "Mirror of Buy & Hold UP — bet DOWN every market. Useful for testing whether the data window is biased.",
    build: () => ({ tradeLogic: "always_down", entry: [], takeProfit: [], stopLoss: [] }),
  },
  {
    key: "threshold_buy_cheap_up",
    name: "Threshold buy (cheap UP)",
    description:
      "Buy UP when its price drops below 30¢ — classic contrarian mean-reversion.",
    build: () => ({
      tradeLogic: "always_up",
      entry: [{ ...newCondition("token_price", "yes"), op: "<=", value: 0.3 }],
    }),
  },
  {
    key: "momentum_follow",
    name: "Momentum (BTC rallying)",
    description:
      "Buy UP when BTC has rallied at least $50 since market open. Rides the trend.",
    build: () => ({
      tradeLogic: "always_up",
      entry: [{ ...newCondition("coin_move_since_open_usd"), op: ">=", value: 50 }],
    }),
  },
  {
    key: "contrarian_fade",
    name: "Contrarian fade",
    description:
      "Bet DOWN when BTC has rallied $100+ — fade overextended moves on the assumption short windows mean-revert.",
    build: () => ({
      tradeLogic: "always_down",
      entry: [{ ...newCondition("coin_move_since_open_usd"), op: ">=", value: 100 }],
    }),
  },
  {
    key: "last_minute_scalp",
    name: "Last-minute scalp",
    description:
      "Enter when there are 30 seconds or less until resolution. Tries to capture the late-resolution skew.",
    build: () => ({
      tradeLogic: "always_up",
      entry: [{ ...newCondition("time_to_resolution_s"), op: "<=", value: 30 }],
    }),
  },
  {
    key: "tight_book_only",
    name: "Tight-book filter",
    description:
      "Only enter when the UP order book is tight (≤ 3¢ spread). Avoids the wide-book trap that ruins walk-book fills.",
    build: () => ({
      tradeLogic: "always_up",
      entry: [{ ...newCondition("spread", "yes"), op: "<=", value: 0.03 }],
    }),
  },
  {
    key: "breakout_50",
    name: "Breakout 50¢",
    description:
      "Buy UP the moment its price crosses above 50¢ — event-based momentum trigger.",
    build: () => ({
      tradeLogic: "always_up",
      entry: [{ ...newCondition("token_price", "yes"), op: "crosses_above", value: 0.5 }],
    }),
  },
  {
    key: "mean_reversion_tp_sl",
    name: "Mean reversion (TP + SL)",
    description:
      "Buy UP at ≤30¢, take profit at 50¢, stop loss at 15¢. Full round-trip example showing TP/SL exits.",
    build: () => ({
      tradeLogic: "always_up",
      entry: [{ ...newCondition("token_price", "yes"), op: "<=", value: 0.3 }],
      takeProfit: [{ ...newCondition("token_price", "yes"), op: ">=", value: 0.5 }],
      stopLoss: [{ ...newCondition("token_price", "yes"), op: "<=", value: 0.15 }],
    }),
  },
];

const SAVED_KEY = "pql-saved-strategies";

interface SavedStrategy {
  id: string;
  name: string;
  saved_at: string;
  state: BuilderState;
}

function loadSaved(): SavedStrategy[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    return raw ? (JSON.parse(raw) as SavedStrategy[]) : [];
  } catch {
    return [];
  }
}

function writeSaved(list: SavedStrategy[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  } catch {
    // ignore quota errors — saved strategies are nice-to-have
  }
}

const DEFAULT_STATE: BuilderState = {
  ticker: "BTC",
  eventType: "5m",
  marketLimit: 50,
  sizeUsd: 10,
  maxTradesPerMarket: 1,
  fillMode: "walk_book",
  // 0.95 default: catches obvious wide-book traps (mid=0.60 but best
  // ask is 0.99) without introducing strong selection bias. Lower
  // values like 0.65 filter to "UP token is cheap" markets — i.e.,
  // markets the consensus thinks will lose — which biases an Always-UP
  // backtest toward 0% win rate. Users who want a strict cap can
  // dial it down explicitly.
  maxFillPrice: 0.95,
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
  // First render must match what the server produced — otherwise React
  // throws a hydration error when localStorage values differ from
  // DEFAULT_STATE. So we render DEFAULT_STATE on the initial pass and
  // swap in the stored state after mount.
  const [state, setState] = useState<BuilderState>(DEFAULT_STATE);
  const [submitting, setSubmitting] = useState(false);
  // Advanced section (since/until) hidden by default — PolyBackTest
  // doesn't expose them either, and the universe loader's "last N
  // markets" default is what most users want.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saved, setSaved] = useState<SavedStrategy[]>([]);
  // Picker panel open state — single dropdown housing both Templates
  // (read-only presets) and My Strategies (user-saved).
  const [pickerOpen, setPickerOpen] = useState(false);

  // Origin banner shown when a strategy was pushed in from Calibration
  // or Sweep ("Applied — Calibration edge · BTC 5m · UP under-priced…").
  // Cleared as soon as the user edits anything substantial.
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    // One-shot prefill from Calibration / Sweep hand-off — takes
    // precedence over the user's saved state for this mount only.
    let prefilled = false;
    try {
      const raw = localStorage.getItem("pql-strategy-builder-prefill");
      if (raw) {
        const incoming = JSON.parse(raw) as Partial<BuilderState> & { origin?: string };
        const { origin: o, ...rest } = incoming;
        // Re-stamp condition ids so they're unique in this session
        const rehydrate = (cs?: Condition[]) =>
          (cs || []).map((c) => ({ ...c, id: Math.random().toString(36).slice(2) }));
        setState({
          ...DEFAULT_STATE,
          ...rest,
          entry: rehydrate(rest.entry),
          takeProfit: rehydrate(rest.takeProfit),
          stopLoss: rehydrate(rest.stopLoss),
        });
        if (typeof o === "string") setOrigin(o);
        localStorage.removeItem("pql-strategy-builder-prefill");
        prefilled = true;
      }
    } catch {
      // Bad JSON in prefill — drop it and fall back to stored state.
      try { localStorage.removeItem("pql-strategy-builder-prefill"); } catch {}
    }
    if (!prefilled) {
      const stored = loadStored();
      if (stored) setState(stored);
    }
    setSaved(loadSaved());
  }, []);

  function applyTemplate(t: Template) {
    persist({ ...DEFAULT_STATE, ...t.build() });
    setPickerOpen(false);
    toast.success(`Loaded: ${t.name}`);
  }

  function saveCurrent() {
    const name = window.prompt(
      "Save current strategy as:",
      `Custom ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    );
    if (!name) return;
    const rec: SavedStrategy = {
      id: Math.random().toString(36).slice(2),
      name: name.slice(0, 60),
      saved_at: new Date().toISOString(),
      state,
    };
    const next = [rec, ...saved].slice(0, 20); // cap at 20 saved
    writeSaved(next);
    setSaved(next);
    toast.success("Saved");
  }

  function loadSavedStrategy(rec: SavedStrategy) {
    persist({ ...DEFAULT_STATE, ...rec.state });
    setPickerOpen(false);
    toast.success(`Loaded: ${rec.name}`);
  }

  function deleteSaved(id: string) {
    const next = saved.filter((s) => s.id !== id);
    writeSaved(next);
    setSaved(next);
  }

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
          // Reset to the new type's spec — value / side / op / window
          // from the old type don't survive a type change so the form
          // never holds inconsistent fields.
          const fresh = newCondition(patch.type);
          next.value = fresh.value;
          next.side = fresh.side;
          next.op = fresh.op;
          next.window_sec = fresh.window_sec;
        }
        // If the user changed op manually, validate it's still in the
        // type's allowed set (e.g. switching from token_price=crosses
        // to spread, which doesn't support crosses).
        const spec = PARAM_SPECS[next.type];
        if (!spec.validOps.includes(next.op)) {
          next.op = spec.defaultOp;
        }
        return next;
      }),
    });
  }

  // -- Plain English summary (mirrors backtest/conditions.py:humanise) --

  function humanise(c: Condition): string {
    const op = OP_LABELS[c.op] || c.op;
    const spec = PARAM_SPECS[c.type];
    const sidePrefix = spec.hasSide ? `${c.side?.toUpperCase() ?? ""} ` : "";
    const windowSuffix = spec.needsWindow ? ` (${c.window_sec}s window)` : "";
    const unit =
      spec.unit === "usd" ? "$" :
      spec.unit === "percent" ? "%" :
      spec.unit === "seconds" ? "s" :
      "";
    return `${sidePrefix}${spec.label} ${op} ${unit}${c.value}${windowSuffix}`;
  }

  const readsAs = useMemo(() => {
    const entryEn =
      state.entry.length === 0
        ? "no rules — enter as soon as a fill is possible"
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
    // Empty entry is allowed — backend treats it as "enter at first
    // acceptable fill" (still gated by max_fill_price), matching
    // PolyBackTest's buy-and-hold default.
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
      {origin && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 flex items-baseline justify-between gap-3">
          <div className="text-sm">
            <span className="text-[10px] font-mono uppercase tracking-widest text-primary/70 mr-2">
              Pre-filled
            </span>
            <span className="text-base-content/80">{origin}</span>
          </div>
          <button
            onClick={() => setOrigin(null)}
            className="btn btn-ghost btn-xs"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Strategy picker — Templates + My Strategies + Save current */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="btn btn-sm rounded-lg border border-base-300 bg-base-200/40 hover:bg-base-200"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            Load template
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6,9 12,15 18,9" />
            </svg>
          </button>
          {pickerOpen && (
            <>
              <button
                className="fixed inset-0 z-10 cursor-default"
                aria-label="Close picker"
                onClick={() => setPickerOpen(false)}
              />
              <div className="absolute left-0 top-full mt-1 z-20 w-96 max-h-[28rem] overflow-y-auto rounded-xl border border-base-300 bg-base-100 shadow-xl">
                <div className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-base-content/40 border-b border-base-300/60">
                  Templates
                </div>
                {TEMPLATES.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => applyTemplate(t)}
                    className="w-full text-left px-3 py-2 hover:bg-base-200/60 border-b border-base-300/40 last:border-b-0"
                  >
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="text-xs text-base-content/60 mt-0.5 leading-snug">
                      {t.description}
                    </div>
                  </button>
                ))}
                {saved.length > 0 && (
                  <>
                    <div className="px-3 py-2 mt-2 text-[10px] font-mono uppercase tracking-widest text-base-content/40 border-y border-base-300/60 bg-base-200/40">
                      My strategies
                    </div>
                    {saved.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center px-3 py-2 hover:bg-base-200/60 border-b border-base-300/40 last:border-b-0 gap-2"
                      >
                        <button
                          onClick={() => loadSavedStrategy(s)}
                          className="flex-1 text-left"
                        >
                          <div className="text-sm font-medium">{s.name}</div>
                          <div className="text-xs text-base-content/40 font-mono mt-0.5">
                            {new Date(s.saved_at).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSaved(s.id);
                          }}
                          className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
                          aria-label="Delete saved strategy"
                          title="Delete"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <button
          onClick={saveCurrent}
          className="btn btn-sm btn-ghost rounded-lg"
          title="Save current builder state to local storage"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          Save current
        </button>
        <span className="text-[11px] text-base-content/40 font-mono ml-auto">
          {saved.length > 0
            ? `${saved.length} saved`
            : "Saved to this browser only"}
        </span>
      </div>

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
              title="More markets = wider time window = better regime mix. 50 markets of 5m = ~4 hours; 200 = ~16 hours."
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
        </div>

        <div className="mt-2 pt-3 border-t border-base-300/50">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-xs text-base-content/50 hover:text-base-content transition-colors flex items-center gap-1.5"
          >
            <span className="inline-block transition-transform" style={{ transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)" }}>
              ▸
            </span>
            Advanced — time window
          </button>
          {showAdvanced && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
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
              <p className="md:col-span-2 text-[11px] text-base-content/40 leading-relaxed">
                Restrict the market universe to a specific window. Leave blank
                to use the {state.marketLimit} most-recently-resolved markets
                (PolyBackTest&apos;s default). Useful for train/test splits or
                isolating a regime — e.g. test on January, validate on February.
              </p>
            </div>
          )}
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

      {state.maxFillPrice < 0.80 && state.tradeLogic === "always_up" && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
          Max fill price below 0.80 with Always UP filters to markets where
          the UP token is cheap — i.e., markets consensus thinks UP will{" "}
          <strong>lose</strong>. Betting UP into them is a contrarian trade
          and routinely produces 0% win rate. Dial the cap back up (≥ 0.95)
          to remove the bias, or flip Trade Logic to Always DOWN.
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
  const spec = PARAM_SPECS[c.type];
  const step =
    spec.unit === "seconds" ? 30 :
    spec.unit === "usd" ? 10 :
    spec.unit === "stddev" ? 0.01 :
    0.01;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-base-100 border border-base-300/60">
      {/* Parameter type */}
      <select
        className="select select-xs select-bordered min-w-[8.5rem]"
        value={c.type}
        onChange={(e) => onPatch({ type: e.target.value as ConditionType })}
        title={spec.description}
      >
        {(Object.keys(PARAM_SPECS) as ConditionType[]).map((t) => (
          <option key={t} value={t}>{PARAM_SPECS[t].label}</option>
        ))}
      </select>

      {/* Side (UP/DOWN) — only when the parameter has a side */}
      {spec.hasSide && (
        <select
          className="select select-xs select-bordered"
          value={c.side ?? "yes"}
          onChange={(e) => onPatch({ side: e.target.value as TokenSide })}
        >
          <option value="yes">UP</option>
          <option value="no">DOWN</option>
        </select>
      )}

      {/* Operator — only those valid for this parameter */}
      <select
        className="select select-xs select-bordered"
        value={c.op}
        onChange={(e) => onPatch({ op: e.target.value as Op })}
      >
        {spec.validOps.map((op) => (
          <option key={op} value={op}>{OP_LABELS[op]}</option>
        ))}
      </select>

      {/* Threshold value */}
      <input
        type="number"
        className="input input-xs input-bordered w-24 tabular-nums"
        step={step}
        value={c.value}
        onChange={(e) =>
          onPatch({ value: parseFloat(e.target.value) || 0 })
        }
      />
      <span className="text-[10px] text-base-content/40 font-mono">
        {UNIT_HINT[spec.unit]}
      </span>

      {/* Lookback window — only for volatility primitives */}
      {spec.needsWindow && (
        <>
          <span className="text-[10px] text-base-content/40 font-mono uppercase tracking-widest">
            over
          </span>
          <input
            type="number"
            className="input input-xs input-bordered w-20 tabular-nums"
            step={10}
            min={10}
            max={3600}
            value={c.window_sec ?? 60}
            onChange={(e) =>
              onPatch({ window_sec: parseInt(e.target.value, 10) || 60 })
            }
          />
          <span className="text-[10px] text-base-content/40 font-mono">s</span>
        </>
      )}

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
