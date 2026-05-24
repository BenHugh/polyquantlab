"use client";

import { formatDateTime } from "@/libs/formatDate";
import Link from "next/link";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";

interface PaperStrategy {
  paper_strategy_id: string;
  user_email: string;
  name: string | null;
  strategy_spec: Record<string, unknown>;
  ticker: string | null;
  event_type: string | null;
  size_usd: number;
  started_at: string;
  paused_at: string | null;
  active: boolean;
}

export default function PaperStrategiesList() {
  const [strategies, setStrategies] = useState<PaperStrategy[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/paper/strategies", { cache: "no-store" });
      if (!res.ok) {
        setError(`Failed (${res.status})`);
        return;
      }
      const body = await res.json();
      setStrategies(body.strategies ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Network error");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function setActive(id: string, active: boolean) {
    const path = active ? "resume" : "pause";
    const res = await fetch(
      `/api/paper/strategies/${encodeURIComponent(id)}/${path}`,
      { method: "PATCH" }
    );
    if (!res.ok) {
      toast.error(`${active ? "Resume" : "Pause"} failed (${res.status})`);
      return;
    }
    toast.success(active ? "Resumed" : "Paused");
    refresh();
  }

  async function remove(id: string) {
    if (!confirm("Delete this paper strategy and all its virtual trades?")) {
      return;
    }
    const res = await fetch(
      `/api/paper/strategies/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      toast.error(`Delete failed (${res.status})`);
      return;
    }
    toast.success("Deleted");
    refresh();
  }

  if (error) {
    return <div className="alert alert-error"><span>{error}</span></div>;
  }
  if (strategies === null) {
    return <div className="opacity-70">Loading…</div>;
  }
  if (strategies.length === 0) {
    return (
      <div className="rounded-lg border border-base-300 bg-base-100 p-8 text-center">
        <p className="opacity-70 mb-4">
          No paper strategies yet. Create one to start tracking real-time
          virtual P&L.
        </p>
        <Link href="/dashboard/paper/new" className="btn btn-primary">
          + New strategy
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-base-300 overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Name</th>
            <th>Filter</th>
            <th>Size</th>
            <th>Started</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {strategies.map((s) => {
            const specType =
              typeof s.strategy_spec === "object" && s.strategy_spec
                ? String((s.strategy_spec as Record<string, unknown>).type ?? "?")
                : "?";
            return (
              <tr key={s.paper_strategy_id} className="hover">
                <td>
                  <Link
                    href={`/dashboard/paper/${encodeURIComponent(s.paper_strategy_id)}`}
                    className="link link-hover font-semibold"
                  >
                    {s.name || "(untitled)"}
                  </Link>
                  <div className="text-xs opacity-60">{specType}</div>
                </td>
                <td className="text-xs">
                  {[s.ticker, s.event_type].filter(Boolean).join(" · ") || "any"}
                </td>
                <td className="tabular-nums">${s.size_usd.toFixed(2)}</td>
                <td className="text-xs">{formatDateTime(s.started_at)}</td>
                <td>
                  {s.active ? (
                    <span className="badge badge-success">Active</span>
                  ) : (
                    <span className="badge badge-ghost">Paused</span>
                  )}
                </td>
                <td className="text-right whitespace-nowrap">
                  <button
                    className="btn btn-xs btn-outline mr-1"
                    onClick={() => setActive(s.paper_strategy_id, !s.active)}
                  >
                    {s.active ? "Pause" : "Resume"}
                  </button>
                  <button
                    className="btn btn-xs btn-error btn-outline"
                    onClick={() => remove(s.paper_strategy_id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
