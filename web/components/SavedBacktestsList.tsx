"use client";

/**
 * Tabular history of recent backtest jobs.
 *
 * Pulls from FastAPI's /v1/backtest list endpoint, which is backed by
 * the Redis JobStore. Records expire 24h after completion (see
 * api/job_store.py:RESULT_TTL_SECONDS) — long-term archival lives in
 * a future Postgres-backed history table.
 *
 * Note on multi-user: dashboard submissions all share api_key_id
 * "__internal__", so until per-user separation lands every dashboard
 * user sees every dashboard run. Fine while Ben is the only user;
 * tracked in [[open-decisions]].
 */

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Boxes,
  Clock,
  Grid3x3,
  Hash,
  Repeat,
  SlidersHorizontal,
} from "lucide-react";

interface Job {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  params: {
    strategy?: { type?: string };
    ticker?: string;
    event_type?: string;
    market_limit?: number;
    // sweeps also use this endpoint
    x_axis?: unknown;
  };
  result?: {
    total_pnl?: number;
    n_trades?: number;
    win_rate?: number;
    sharpe?: number | null;
    max_drawdown?: number;
  } | null;
  error?: string | null;
}

interface ListResponse {
  jobs: Job[];
  count: number;
}

export default function SavedBacktestsList() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/backtest?limit=100", { cache: "no-store" });
      if (!r.ok) throw new Error(`list ${r.status}`);
      const data: ListResponse = await r.json();
      setJobs(data.jobs || []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Refresh every 5s — picks up newly-queued + completed jobs without
    // requiring the user to reload.
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, [load]);

  if (loading && jobs.length === 0) {
    return (
      <div className="rounded-xl border border-base-300 bg-base-200/30 p-10 text-center text-sm text-base-content/50">
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="alert alert-error text-sm">
        <span>{error}</span>
      </div>
    );
  }
  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-base-300 bg-base-200/30 p-10 text-center text-sm text-base-content/60">
        <p>No backtests yet.</p>
        <p className="mt-2 text-xs text-base-content/40">
          Submit one from{" "}
          <Link
            href="/dashboard/backtest"
            className="link link-primary link-hover"
          >
            Backtest
          </Link>{" "}
          or{" "}
          <Link
            href="/dashboard/strategy-builder"
            className="link link-primary link-hover"
          >
            Strategy Builder
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-base-300 bg-base-200/30 overflow-hidden">
      <table className="table table-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-base-content/40">
            <th>Submitted</th>
            <th>Strategy</th>
            <th>Universe</th>
            <th>Status</th>
            <th className="text-right">Trades</th>
            <th className="text-right">PnL ($)</th>
            <th className="text-right">Sharpe</th>
            <th className="text-right">Max DD</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <Row key={j.job_id} job={j} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ job }: { job: Job }) {
  const isSweep = !!job.params.x_axis;
  const stratType =
    job.params.strategy?.type ??
    (isSweep ? "sweep" : "—");
  // Icon hint per strategy type so the list reads as a glance-able log
  // (custom condition_based, threshold, mean-reversion, time-before,
  // sweep). lucide stroke icons, accent-coloured by type-family.
  const iconAndColor: { icon: ReactNode; color: string } = (() => {
    if (isSweep) return { icon: <Grid3x3 size={12} strokeWidth={2} />, color: "text-warning" };
    switch (stratType) {
      case "condition_based":
        return { icon: <Boxes size={12} strokeWidth={2} />, color: "text-info" };
      case "threshold_entry":
        return { icon: <SlidersHorizontal size={12} strokeWidth={2} />, color: "text-secondary" };
      case "mean_reversion":
        return { icon: <Repeat size={12} strokeWidth={2} />, color: "text-success" };
      case "time_before_resolution":
        return { icon: <Clock size={12} strokeWidth={2} />, color: "text-base-content/60" };
      default:
        return { icon: <Hash size={12} strokeWidth={2} />, color: "text-base-content/40" };
    }
  })();
  const universe =
    [
      job.params.ticker,
      job.params.event_type,
      job.params.market_limit && `n=${job.params.market_limit}`,
    ]
      .filter(Boolean)
      .join(" · ") || "—";
  const detailHref = isSweep
    ? `/dashboard/backtest/sweep/${job.job_id}`
    : `/dashboard/backtest/${job.job_id}`;

  const pnl = job.result?.total_pnl;
  const pnlTone =
    pnl === undefined
      ? ""
      : pnl > 0
        ? "text-primary"
        : pnl < 0
          ? "text-error"
          : "";

  return (
    <tr className="hover:bg-base-300/40">
      <td className="font-mono text-xs text-base-content/70 whitespace-nowrap">
        {formatRelative(job.submitted_at)}
      </td>
      <td className="font-mono text-xs">
        <span className="inline-flex items-center gap-1.5">
          <span className={`shrink-0 ${iconAndColor.color}`} aria-hidden>
            {iconAndColor.icon}
          </span>
          <span>{stratType}</span>
        </span>
      </td>
      <td className="font-mono text-xs text-base-content/70 whitespace-nowrap">
        {universe}
      </td>
      <td>
        <StatusBadge status={job.status} />
      </td>
      <td className="text-right tabular-nums font-mono text-xs">
        {job.result?.n_trades ?? "—"}
      </td>
      <td className={`text-right tabular-nums font-mono text-xs ${pnlTone}`}>
        {pnl !== undefined ? formatUsd(pnl) : "—"}
      </td>
      <td className="text-right tabular-nums font-mono text-xs">
        {job.result?.sharpe !== null && job.result?.sharpe !== undefined
          ? job.result.sharpe.toFixed(2)
          : "—"}
      </td>
      <td className="text-right tabular-nums font-mono text-xs text-base-content/70">
        {job.result?.max_drawdown !== undefined
          ? formatUsd(job.result.max_drawdown)
          : "—"}
      </td>
      <td className="text-right">
        <Link
          href={detailHref}
          className="btn btn-ghost btn-xs"
        >
          View →
        </Link>
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: Job["status"] }) {
  const styles: Record<Job["status"], string> = {
    queued: "badge-ghost",
    running: "badge-info",
    completed: "badge-primary",
    failed: "badge-error",
  };
  return (
    <span className={`badge badge-sm ${styles[status]}`}>{status}</span>
  );
}

/* ─── Format helpers ─────────────────────────────────────────────── */

function formatUsd(n: number): string {
  const sign = n >= 0 ? "" : "−";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
