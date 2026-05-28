"use client";

/**
 * ArbVerification — honest "model says vs reality" report.
 *
 * The point of this page is NOT to brag about edge. It's to prove the
 * engine is audited. Showing realized PnL = $0 is BETTER than hiding
 * data — it's the trust foundation other crypto-prediction tools
 * never built. Every breakdown surface (ticker / tier / event_type)
 * exposes both numbers side-by-side so a user can poke at "where
 * does the model break down?" themselves.
 *
 * No paywall — full audit data is public. The product value isn't
 * the data point, it's the discipline of having collected it.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  Globe2,
  Layers,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import CoinIcon from "@/components/CoinIcon";

interface BreakdownRow {
  bucket: string;
  total: number;
  resolved: number;
  avg_model_ev: number | null;
  avg_realized: number | null;
  total_realized: number | null;
}

interface AggregateResponse {
  window: string;
  since: string | null;
  as_of: string;
  overall: {
    total: number;
    resolved: number;
    open: number;
    logical_total: number;
    logical_resolved: number;
    avg_model_ev: number | null;
    avg_realized: number | null;
    total_realized: number | null;
    first_detection: string | null;
    last_detection: string | null;
  };
  by_ticker: BreakdownRow[];
  by_tier: BreakdownRow[];
  by_event_type: BreakdownRow[];
}

const WINDOWS = [
  { value: "24h", label: "Past 24 hours" },
  { value: "7d", label: "Past 7 days" },
  { value: "30d", label: "Past 30 days" },
  { value: "all", label: "All time" },
];

export default function ArbVerification() {
  const [data, setData] = useState<AggregateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [window, setWindow] = useState("all");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/arb/audit?window=${encodeURIComponent(window)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled)
            setError(body?.detail || body?.error || `HTTP ${res.status}`);
          return;
        }
        const body: AggregateResponse = await res.json();
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [window]);

  if (loading && !data) {
    return <div className="opacity-70 text-center py-12">Loading audit data…</div>;
  }
  if (error) {
    return (
      <div className="alert alert-error">
        <AlertTriangle size={16} />
        <span>{error}</span>
      </div>
    );
  }
  if (!data) return null;

  const calibrationPct =
    data.overall.avg_model_ev !== null &&
    data.overall.avg_model_ev !== 0 &&
    data.overall.avg_realized !== null
      ? (data.overall.avg_realized / data.overall.avg_model_ev) * 100
      : null;

  return (
    <div className="space-y-5">
      {/* Time-window selector */}
      <section className="q-panel">
        <header className="q-panel-header">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="shrink-0 text-info" aria-hidden>
              <Layers size={16} strokeWidth={2} />
            </span>
            <h3 className="q-section-title truncate">Audit window</h3>
          </div>
          <span className="q-section-subtitle">
            {data.overall.first_detection &&
              `${new Date(data.overall.first_detection).toLocaleString()} → ${
                data.overall.last_detection
                  ? new Date(data.overall.last_detection).toLocaleString()
                  : "now"
              }`}
          </span>
        </header>
        <div className="p-4 flex gap-2 flex-wrap">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              type="button"
              className={`btn btn-xs ${
                window === w.value ? "btn-primary" : "btn-ghost"
              }`}
              onClick={() => setWindow(w.value)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </section>

      {/* Hero KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={<Target size={13} strokeWidth={2} />}
          label="Detections"
          value={data.overall.total.toLocaleString()}
          sub={`${data.overall.resolved.toLocaleString()} resolved · ${data.overall.open.toLocaleString()} open`}
        />
        <Stat
          icon={<CheckCircle2 size={13} strokeWidth={2} />}
          label="Avg model EV"
          value={fmtCents(data.overall.avg_model_ev)}
          sub="per share at detection"
          tone={tone(data.overall.avg_model_ev)}
        />
        <Stat
          icon={<Award size={13} strokeWidth={2} />}
          label="Avg realised"
          value={fmtCents(data.overall.avg_realized)}
          sub={
            data.overall.resolved > 0
              ? `over ${data.overall.resolved.toLocaleString()} resolved`
              : "no data yet"
          }
          tone={tone(data.overall.avg_realized)}
        />
        <Stat
          icon={
            calibrationPct !== null && calibrationPct >= 50 ? (
              <TrendingUp size={13} strokeWidth={2} />
            ) : (
              <TrendingDown size={13} strokeWidth={2} />
            )
          }
          label="Calibration"
          value={
            calibrationPct === null
              ? "—"
              : `${calibrationPct >= 0 ? "+" : ""}${calibrationPct.toFixed(1)}%`
          }
          sub="realised / model"
          tone={
            calibrationPct === null
              ? undefined
              : calibrationPct >= 40
                ? "success"
                : calibrationPct >= 0
                  ? undefined
                  : "error"
          }
        />
      </div>

      {/* Honest framing — what the numbers mean */}
      <HonestExplainer overall={data.overall} calibrationPct={calibrationPct} />

      {/* Breakdowns */}
      <BreakdownTable
        title="By ticker"
        icon={<CoinIcon ticker="BTC" size={14} />}
        subtitle="Which underlying calibrates best"
        rows={data.by_ticker}
        renderBucket={(b) => (
          <span className="inline-flex items-center gap-1.5">
            <CoinIcon ticker={b} size={14} />
            <span className="font-mono">{b}</span>
          </span>
        )}
      />
      <BreakdownTable
        title="By tier"
        icon={<Award size={14} strokeWidth={2} />}
        subtitle="Stable maker-zone rows vs deep mispricings vs math-guaranteed logical arbs"
        rows={data.by_tier}
        renderBucket={(b) => (
          <span
            className={`font-mono uppercase tracking-wide text-xs ${
              b === "logical"
                ? "text-warning"
                : b === "stable"
                  ? "text-success"
                  : "text-base-content/60"
            }`}
          >
            {b === "logical" ? "🛡 " : ""}
            {b}
          </span>
        )}
      />
      <BreakdownTable
        title="By timeframe"
        icon={<Globe2 size={14} strokeWidth={2} />}
        subtitle="5m markets vs daily — short windows behave differently"
        rows={data.by_event_type}
        renderBucket={(b) => <span className="font-mono">{b}</span>}
      />

      {/* Footer epistemic disclosure */}
      <div className="text-xs text-base-content/50 px-3 py-2 border-t border-base-300/40 leading-relaxed">
        <strong className="text-base-content/70">Method:</strong> the engine
        runs every 30 seconds and records its <em>first</em> belief about each
        market — model_yes_prob, fill_price, expected_pnl_per_share, tier — into{" "}
        <span className="font-mono">arb_audit_log</span> (PostgreSQL). When the
        market resolves on Polymarket, a settler joins to the resolution
        outcome and computes <span className="font-mono">realized_pnl_per_share</span>{" "}
        ={" "}
        <span className="font-mono">payoff - fill_price - entry_fee</span>. No
        survivorship: every detection is written, no row is deleted after the
        fact. Realised PnL is before Polygon gas (~$0.10-0.30 per trade) and
        execution lag (5-30 s) — the &quot;Calibration&quot; ratio above is
        already a generous upper bound for actual user PnL.
      </div>
    </div>
  );
}

/* ─── Sub-components ────────────────────────────────────────────── */

function HonestExplainer({
  overall,
  calibrationPct,
}: {
  overall: AggregateResponse["overall"];
  calibrationPct: number | null;
}) {
  if (overall.resolved < 50) {
    return (
      <div className="rounded-lg border border-info/30 bg-info/5 p-3 text-sm leading-relaxed">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="text-info shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Collecting data…</div>
            <div className="text-base-content/70">
              Only {overall.resolved} markets have resolved so far —
              calibration numbers will become meaningful once we cross ~200
              resolutions (typically 2-3 days of tracker runtime).
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (calibrationPct === null) return null;
  const tone =
    calibrationPct >= 40
      ? "success"
      : calibrationPct >= 0
        ? "warning"
        : "error";
  const message =
    calibrationPct >= 60
      ? "Model is well-calibrated — most of its predicted EV translates to realised PnL."
      : calibrationPct >= 30
        ? "Partial calibration — model has some signal but Polygon gas + execution lag eat most of the predicted edge."
        : calibrationPct >= 0
          ? "Model EV is essentially noise — Polymarket maker bots appear well-calibrated for crypto Up/Down books, and our log-normal probability adds no demonstrable edge."
          : "Model is anti-correlated with reality — actively pick the WORSE side. Time to retire this model or rebuild it.";
  return (
    <div
      className={`rounded-lg border p-3 text-sm leading-relaxed ${
        tone === "success"
          ? "border-success/40 bg-success/5"
          : tone === "warning"
            ? "border-warning/40 bg-warning/5"
            : "border-error/40 bg-error/5"
      }`}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          size={16}
          className={`shrink-0 mt-0.5 ${
            tone === "success"
              ? "text-success"
              : tone === "warning"
                ? "text-warning"
                : "text-error"
          }`}
        />
        <div>
          <div className="font-semibold mb-1">
            What this means
          </div>
          <div className="text-base-content/70">{message}</div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: "success" | "error";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "error"
        ? "text-error"
        : "";
  const iconColor =
    tone === "success"
      ? "text-success/70"
      : tone === "error"
        ? "text-error/70"
        : "text-base-content/40";
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-3">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide opacity-60">
        <span className={`shrink-0 ${iconColor}`}>{icon}</span>
        <span>{label}</span>
      </div>
      <div className={`font-semibold mt-1 font-mono tabular-nums text-lg ${color}`}>
        {value}
      </div>
      {sub && (
        <div className="text-[11px] text-base-content/40 mt-0.5">{sub}</div>
      )}
    </div>
  );
}

function BreakdownTable({
  title,
  icon,
  subtitle,
  rows,
  renderBucket,
}: {
  title: string;
  icon: ReactNode;
  subtitle: string;
  rows: BreakdownRow[];
  renderBucket: (b: string) => ReactNode;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="q-panel">
      <header className="q-panel-header">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="shrink-0 text-secondary" aria-hidden>
            {icon}
          </span>
          <h3 className="q-section-title truncate">{title}</h3>
        </div>
        <span className="q-section-subtitle hidden sm:inline">{subtitle}</span>
      </header>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Bucket</th>
              <th className="text-right">Detections</th>
              <th className="text-right">Resolved</th>
              <th className="text-right">Model EV</th>
              <th className="text-right">Realised</th>
              <th className="text-right">Total Realised</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.bucket} className="hover:bg-base-200/40">
                <td>{renderBucket(r.bucket)}</td>
                <td className="text-right font-mono tabular-nums text-xs">
                  {r.total.toLocaleString()}
                </td>
                <td className="text-right font-mono tabular-nums text-xs text-base-content/60">
                  {r.resolved.toLocaleString()}
                </td>
                <td className="text-right font-mono tabular-nums text-xs">
                  {fmtCents(r.avg_model_ev)}
                </td>
                <td
                  className={`text-right font-mono tabular-nums text-xs font-semibold ${
                    r.avg_realized === null
                      ? ""
                      : r.avg_realized > 0
                        ? "text-success"
                        : r.avg_realized < 0
                          ? "text-error"
                          : ""
                  }`}
                >
                  {fmtCents(r.avg_realized)}
                </td>
                <td
                  className={`text-right font-mono tabular-nums text-xs ${
                    r.total_realized === null
                      ? ""
                      : r.total_realized > 0
                        ? "text-success"
                        : r.total_realized < 0
                          ? "text-error"
                          : ""
                  }`}
                >
                  {r.total_realized === null
                    ? "—"
                    : `${r.total_realized >= 0 ? "+" : ""}$${r.total_realized.toFixed(2)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtCents(v: number | null): string {
  if (v === null || v === undefined) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}$${v.toFixed(4)}`;
}

function tone(v: number | null): "success" | "error" | undefined {
  if (v === null || v === undefined) return undefined;
  if (v > 0.001) return "success";
  if (v < -0.001) return "error";
  return undefined;
}
