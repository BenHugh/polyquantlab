/**
 * Compile a Strategy Builder spec into a standalone, downloadable
 * Python script that — given a PolyQuantLab API key — replays the
 * same strategy on the user's own machine. The output mirrors the
 * shape of PolyBackTest's compiled strategy (parameter block, walk-
 * the-book helpers, condition translation, main loop, aggregation)
 * so a trader switching tools sees familiar code.
 *
 * Why a separate module: keeps the codegen pure-function and
 * easily testable, decoupled from the React component that just
 * calls `generatePython(state)` to render the "Generated Code" tab.
 */

// We deliberately don't import from StrategyBuilder.tsx to avoid a
// circular import; the wire shapes live here as their own structural
// types matching the builder's runtime state.

export type GroupOp = "AND" | "OR";

export interface CodegenCondition {
  type:
    | "token_price"
    | "spread"
    | "time_to_resolution_s"
    | "time_since_market_open_s"
    | "coin_move_since_open_usd"
    | "coin_move_since_open_pct"
    | "coin_price_volatility"
    | "token_price_volatility";
  side?: "yes" | "no";
  op:
    | ">="
    | ">"
    | "<="
    | "<"
    | "=="
    | "!="
    | "crosses_above"
    | "crosses_below";
  value: number;
  window_sec?: number;
}

export interface CodegenGroup {
  op: GroupOp;
  children: CodegenNode[];
  connectors?: GroupOp[];
}

export type CodegenNode = CodegenCondition | CodegenGroup;

export interface CodegenSpec {
  ticker: "BTC" | "ETH" | "SOL";
  eventType: "5m" | "15m" | "1h" | "4h" | "daily_up_down";
  marketLimit: number;
  sizeUsd: number;
  maxTradesPerMarket: number;
  fillMode: "walk_book" | "mid";
  maxFillPrice: number;
  tradeLogic: "always_up" | "always_down";
  entry: CodegenGroup;
  takeProfit: CodegenGroup;
  stopLoss: CodegenGroup;
}

function isGroup(n: CodegenNode): n is CodegenGroup {
  return (n as CodegenGroup).children !== undefined;
}

// ─── Condition → Python expression ───────────────────────────────
// Each leaf renders as a Python expression that evaluates to a
// boolean against the variables exposed in the generated runtime:
//
//   snap            current snapshot dict
//   market_open     first snapshot we saw for this market
//   history         list of past snapshots (newest last)
//   resolution_at   ISO datetime of scheduled close
//
// Inputs are validated by the upstream Pydantic schema; here we
// just translate.

function leafExpr(c: CodegenCondition): string {
  const sideKey =
    c.side === "no" ? "no" : "yes"; // default to yes when side is meaningless
  const opPy =
    c.op === "==" ? "==" :
    c.op === "!=" ? "!=" :
    c.op === ">=" ? ">=" :
    c.op === "<=" ? "<=" :
    c.op === ">" ? ">" :
    c.op === "<" ? "<" :
    c.op; // crosses_* handled below
  switch (c.type) {
    case "token_price": {
      const expr = `snap["mid_${sideKey}"]`;
      return basicOrCross(c, expr, opPy, c.value);
    }
    case "spread": {
      const expr = `snap["spread_${sideKey}"]`;
      return basicOrCross(c, expr, opPy, c.value);
    }
    case "time_to_resolution_s":
      return `time_to_resolution_s(snap, resolution_at) ${opPy} ${c.value}`;
    case "time_since_market_open_s":
      return `time_since_market_open_s(snap, market_open) ${opPy} ${c.value}`;
    case "coin_move_since_open_usd": {
      const expr = "coin_move_since_open_usd(snap, market_open)";
      return basicOrCross(c, expr, opPy, c.value);
    }
    case "coin_move_since_open_pct": {
      const expr = "coin_move_since_open_pct(snap, market_open)";
      return basicOrCross(c, expr, opPy, c.value);
    }
    case "coin_price_volatility": {
      const w = c.window_sec ?? 60;
      const expr = `coin_volatility(history, snap, ${w})`;
      return `${expr} ${opPy} ${c.value}`;
    }
    case "token_price_volatility": {
      const w = c.window_sec ?? 60;
      const expr = `token_volatility(history, snap, ${w}, "${sideKey}")`;
      return `${expr} ${opPy} ${c.value}`;
    }
  }
}

function basicOrCross(
  c: CodegenCondition,
  expr: string,
  op: string,
  value: number,
): string {
  if (c.op === "crosses_above") {
    return `crosses_above(${expr}, prev_${exprKey(expr)}, ${value})`;
  }
  if (c.op === "crosses_below") {
    return `crosses_below(${expr}, prev_${exprKey(expr)}, ${value})`;
  }
  return `${expr} ${op} ${value}`;
}

function exprKey(expr: string): string {
  // Stable variable suffix used by the runtime's prev-value tracker.
  return expr
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function nodeExpr(n: CodegenNode): string {
  if (isGroup(n)) return groupExpr(n);
  return leafExpr(n);
}

function groupExpr(g: CodegenGroup): string {
  if (g.children.length === 0) return "False";
  if (g.children.length === 1) return nodeExpr(g.children[0]);
  // Left-to-right reduce with per-pair connectors (Phase W). Python
  // already short-circuits `and`/`or` and has no precedence between
  // them inside an explicit chain (`A and B or C` = `(A and B) or C`),
  // so we just emit the literal chain.
  let acc = `(${nodeExpr(g.children[0])})`;
  for (let i = 1; i < g.children.length; i++) {
    const connector =
      g.connectors && i - 1 < g.connectors.length
        ? g.connectors[i - 1]
        : g.op;
    const joiner = connector === "OR" ? "or" : "and";
    acc = `(${acc} ${joiner} (${nodeExpr(g.children[i])}))`;
  }
  return acc;
}

function sectionExpr(g: CodegenGroup, defaultEmpty: string): string {
  if (g.children.length === 0) return defaultEmpty;
  return groupExpr(g);
}

// ─── Main entry — emit a self-contained Python script ─────────────

export function generatePython(spec: CodegenSpec): string {
  const entryExpr = sectionExpr(spec.entry, "True"); // empty entry = fire on first fillable
  const tpExpr = sectionExpr(spec.takeProfit, "False");
  const slExpr = sectionExpr(spec.stopLoss, "False");
  const side = spec.tradeLogic === "always_up" ? "Up" : "Down";
  const sideTokenKey = side === "Up" ? "yes" : "no";

  const now = new Date().toISOString();

  return `# ─────────────────────────────────────────────────────────────────────────
# Strategy compiled by PolyQuantLab Strategy Builder · ${now}
# Edit visually at https://polyquantlab.com/dashboard/strategy-builder
#
# Run:  pip install polyquantlab && export POLYQUANTLAB_API_KEY=...
#       python this_strategy.py
#
# What this does:
#   1. Loads the most-recent ${spec.marketLimit} resolved ${spec.ticker} ${spec.eventType}
#      markets from PolyQuantLab.
#   2. For each market, replays the orderbook snapshot stream and
#      fires the Entry / Take Profit / Stop Loss rules below.
#   3. Walks the recorded book (or uses mid, see FILL_MODE) — same
#      engine as the website backtest.
#   4. Reports per-trade P&L, equity curve, Sharpe, max DD.
#
# This is BACKTEST-mode (historical replay). To run it LIVE — paper
# or real — swap the loop body for the websocket stream + send orders
# to the Polymarket CLOB. See https://polyquantlab.com/docs/live-bot.
# ─────────────────────────────────────────────────────────────────────────

import asyncio
import datetime
import math
import os
import sys
from typing import Any

import httpx  # pip install httpx

# ─── Strategy parameters ────────────────────────────────────────────
POSITION_SIZE        = ${spec.sizeUsd}
TICKER               = "${spec.ticker}"
MARKET_TYPE          = "${spec.eventType}"
MARKET_LIMIT         = ${spec.marketLimit}
MAX_TRADES_PER_MKT   = ${spec.maxTradesPerMarket}
FILL_MODE            = "${spec.fillMode}"        # "walk_book" or "mid"
MAX_FILL_PRICE       = ${spec.maxFillPrice}        # refuse entries above this best-ask
TRADE_LOGIC          = "${spec.tradeLogic}"   # always_up | always_down
# Polymarket 2026 fee at midpoint price; scales by p × (1 − p).
TAKER_FEE_RATE       = 0.072

API_BASE             = "https://api.polyquantlab.com"
API_KEY              = os.environ.get("POLYQUANTLAB_API_KEY")
if not API_KEY:
    print("Set POLYQUANTLAB_API_KEY before running.", file=sys.stderr)
    sys.exit(1)


# ─── Walk-the-book helpers ──────────────────────────────────────────
def walk_buy_book(orderbook: dict, dollars_to_spend: float) -> tuple[float, float, bool]:
    """Walk asks lowest-first, spend up to dollars_to_spend.
    Returns (tokens_acquired, avg_fill_price, fully_filled)."""
    asks = (orderbook or {}).get("asks") or []
    remaining = dollars_to_spend
    tokens = 0.0
    for level in asks:
        price = float(level["price"])
        size = float(level["size"])
        cost_full = price * size
        if remaining >= cost_full:
            tokens += size
            remaining -= cost_full
        else:
            tokens += remaining / price
            remaining = 0.0
            break
    spent = dollars_to_spend - remaining
    avg = spent / tokens if tokens > 0 else 0.0
    return tokens, avg, remaining < 1e-4


def walk_sell_book(orderbook: dict, tokens_to_sell: float) -> tuple[float, float, bool]:
    """Walk bids highest-first to convert N tokens back to USD."""
    bids = (orderbook or {}).get("bids") or []
    remaining = tokens_to_sell
    proceeds = 0.0
    for level in bids:
        price = float(level["price"])
        size = float(level["size"])
        if remaining >= size:
            proceeds += price * size
            remaining -= size
        else:
            proceeds += price * remaining
            remaining = 0.0
            break
    sold = tokens_to_sell - remaining
    avg = proceeds / sold if sold > 0 else 0.0
    return proceeds, avg, remaining < 1e-4


def calc_taker_fee(num_tokens: float, price: float) -> float:
    """Polymarket taker fee: tokens × feeRate × p × (1 − p). Zero at the
    extremes (1.0 / 0.0) where market truth is unambiguous; peak ~1.8%
    at the 0.5 midpoint."""
    if TAKER_FEE_RATE <= 0 or num_tokens <= 0:
        return 0.0
    p = max(0.0, min(1.0, price))
    return num_tokens * TAKER_FEE_RATE * p * (1.0 - p)


# ─── Condition primitives ───────────────────────────────────────────
def parse_ts(s: str | None) -> datetime.datetime | None:
    if not s:
        return None
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))


def time_to_resolution_s(snap: dict, resolution_at: str | None) -> float | None:
    res = parse_ts(resolution_at)
    ts = parse_ts(snap.get("ts"))
    if res is None or ts is None:
        return None
    return (res - ts).total_seconds()


def time_since_market_open_s(snap: dict, market_open: dict | None) -> float | None:
    if market_open is None:
        return None
    open_ts = parse_ts(market_open.get("ts"))
    cur_ts = parse_ts(snap.get("ts"))
    if open_ts is None or cur_ts is None:
        return None
    return (cur_ts - open_ts).total_seconds()


def coin_move_since_open_usd(snap: dict, market_open: dict | None) -> float | None:
    if market_open is None:
        return None
    cur = snap.get("underlying_price")
    start = market_open.get("underlying_price")
    if cur is None or start is None:
        return None
    return float(cur) - float(start)


def coin_move_since_open_pct(snap: dict, market_open: dict | None) -> float | None:
    if market_open is None:
        return None
    cur = snap.get("underlying_price")
    start = market_open.get("underlying_price")
    if cur is None or start is None or float(start) == 0:
        return None
    return (float(cur) - float(start)) / float(start) * 100.0


def _stddev_over_window(snap, history, window_sec, value_fn):
    """Population stddev of value_fn over snapshots in the last
    window_sec. Returns None if fewer than 2 samples available."""
    cur_ts = parse_ts(snap.get("ts"))
    if cur_ts is None:
        return None
    values = []
    v0 = value_fn(snap)
    if v0 is not None:
        values.append(v0)
    for past in reversed(history):
        past_ts = parse_ts(past.get("ts"))
        if past_ts is None:
            continue
        if (cur_ts - past_ts).total_seconds() > window_sec:
            break
        v = value_fn(past)
        if v is not None:
            values.append(v)
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    var = sum((x - mean) ** 2 for x in values) / len(values)
    return math.sqrt(var)


def coin_volatility(history, snap, window_sec):
    return _stddev_over_window(
        snap, history, window_sec,
        lambda s: float(s["underlying_price"]) if s.get("underlying_price") is not None else None,
    )


def token_volatility(history, snap, window_sec, side):
    key = f"mid_{side}"
    return _stddev_over_window(
        snap, history, window_sec,
        lambda s: float(s[key]) if s.get(key) is not None else None,
    )


def crosses_above(curr, prev, threshold):
    return prev is not None and prev < threshold <= curr


def crosses_below(curr, prev, threshold):
    return prev is not None and prev > threshold >= curr


# ─── Condition closures (translated from Strategy Builder) ──────────
def check_entry(snap: dict, market_open: dict | None, history: list, resolution_at: str | None, prev_state: dict) -> bool:
    return ${entryExpr}


def check_take_profit(snap: dict, market_open: dict | None, history: list, resolution_at: str | None, prev_state: dict) -> bool:
    return ${tpExpr}


def check_stop_loss(snap: dict, market_open: dict | None, history: list, resolution_at: str | None, prev_state: dict) -> bool:
    return ${slExpr}


# ─── Main loop ──────────────────────────────────────────────────────
async def fetch_universe(client: httpx.AsyncClient) -> list[dict]:
    r = await client.get(
        f"{API_BASE}/v1/markets/resolved",
        params={"ticker": TICKER, "event_type": MARKET_TYPE, "limit": MARKET_LIMIT},
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    r.raise_for_status()
    return (r.json() or {}).get("markets", [])


async def fetch_snapshots(client: httpx.AsyncClient, market_id: str) -> list[dict]:
    r = await client.get(
        f"{API_BASE}/v1/snapshots",
        params={"market_id": market_id, "start": "1970-01-01T00:00:00", "end": "2999-12-31T23:59:59", "limit": 100000},
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    r.raise_for_status()
    return (r.json() or {}).get("snapshots", [])


def fill_at(snap: dict, side: str) -> tuple[float, float, float] | None:
    """Apply FILL_MODE + MAX_FILL_PRICE. Returns (avg_price, filled_usd,
    tokens) or None if can't fill."""
    ob_key = "orderbook_up" if side == "Up" else "orderbook_down"
    ob = snap.get(ob_key) or {}
    asks = ob.get("asks") or []
    if not asks:
        return None
    best_ask = float(asks[0]["price"])
    if best_ask > MAX_FILL_PRICE:
        return None
    if FILL_MODE == "mid":
        bids = ob.get("bids") or []
        if not bids:
            return None
        mid = (float(bids[0]["price"]) + best_ask) / 2
        tokens = POSITION_SIZE / mid
        return mid, POSITION_SIZE, tokens
    # walk_book
    tokens, avg, filled = walk_buy_book(ob, POSITION_SIZE)
    if not filled or tokens <= 0:
        return None
    return avg, POSITION_SIZE, tokens


async def process_market(client: httpx.AsyncClient, m: dict) -> list[dict]:
    snaps = await fetch_snapshots(client, m["market_id"])
    if not snaps:
        return []
    market_open = snaps[0]
    resolution_at = m.get("resolution_at") or m.get("resolved_at")
    trades = []
    scan_from = 0

    for _ in range(MAX_TRADES_PER_MKT):
        prev_state: dict = {}
        entry_idx = None
        for i in range(scan_from, len(snaps)):
            history = snaps[max(0, i - 60):i]
            if check_entry(snaps[i], market_open, history, resolution_at, prev_state):
                entry_idx = i
                break
        if entry_idx is None:
            break
        fill = fill_at(snaps[entry_idx], "${side}")
        if fill is None:
            scan_from = entry_idx + 1
            continue
        entry_price, entry_usd, tokens = fill
        entry_fee = calc_taker_fee(tokens, entry_price)

        # Exit scan: TP / SL or resolution
        exit_price = None
        exit_reason = "Resolution"
        exit_proceeds = 0.0
        prev_state = {}
        for i in range(entry_idx + 1, len(snaps)):
            history = snaps[max(0, i - 60):i]
            if check_take_profit(snaps[i], market_open, history, resolution_at, prev_state):
                ob_key = "orderbook_${sideTokenKey}"
                proceeds, avg, filled = walk_sell_book(snaps[i].get(ob_key) or {}, tokens)
                if filled and avg > 0:
                    exit_price = avg
                    exit_proceeds = proceeds
                    exit_reason = "TP"
                    scan_from = i + 1
                    break
            if check_stop_loss(snaps[i], market_open, history, resolution_at, prev_state):
                ob_key = "orderbook_${sideTokenKey}"
                proceeds, avg, filled = walk_sell_book(snaps[i].get(ob_key) or {}, tokens)
                if filled and avg > 0:
                    exit_price = avg
                    exit_proceeds = proceeds
                    exit_reason = "SL"
                    scan_from = i + 1
                    break

        if exit_price is None:
            won = (m.get("resolution_outcome") or "").lower().startswith("${side.toLowerCase()}")
            exit_price = 1.0 if won else 0.0
            exit_proceeds = tokens * exit_price
            scan_from = len(snaps)

        exit_fee = calc_taker_fee(tokens, exit_price)
        pnl = round(exit_proceeds - entry_usd - entry_fee - exit_fee, 2)
        trades.append({
            "market_id": m["market_id"],
            "side": "${side}",
            "entry_price": round(entry_price, 4),
            "exit_price": round(exit_price, 4),
            "exit_reason": exit_reason,
            "tokens": round(tokens, 4),
            "pnl": pnl,
        })
        if exit_reason == "Resolution":
            break
    return trades


async def main() -> None:
    async with httpx.AsyncClient(timeout=30) as client:
        universe = await fetch_universe(client)
        print(f"Loaded {len(universe)} markets · running backtest…")
        all_trades: list[dict] = []
        for m in universe:
            t = await process_market(client, m)
            all_trades.extend(t)
        all_trades.sort(key=lambda t: t.get("entry_price", 0))

    if not all_trades:
        print("No trades fired.")
        return

    total_pnl = sum(t["pnl"] for t in all_trades)
    wins = sum(1 for t in all_trades if t["pnl"] > 0)
    losses = len(all_trades) - wins
    best = max((t["pnl"] for t in all_trades), default=0)
    worst = min((t["pnl"] for t in all_trades), default=0)
    print(f"Trades: {len(all_trades)} · {wins}W {losses}L")
    print(f"Net P&L: {'+'if total_pnl>=0 else ''}{total_pnl:.2f}")
    print(f"Win rate: {wins / len(all_trades) * 100:.1f}%")
    print(f"Best:  {'+' if best > 0 else ''}{best:.2f}")
    print(f"Worst: {worst:.2f}")


if __name__ == "__main__":
    asyncio.run(main())
`;
}
