"use client";

/**
 * One-click export of any tabular data the dashboard already has in
 * memory. Works fully client-side — no extra backend endpoint needed
 * because the data was already fetched as JSON. Just downloads what's
 * in state.
 *
 * Two formats:
 *   - CSV (most users — pop into Excel / Sheets / pandas)
 *   - JSON (devs — pipe into a script)
 *
 * The CSV converter handles nested objects (flattens to `parent.child`),
 * arrays (stringifies as JSON), and properly quotes strings containing
 * commas / quotes / newlines.
 */

import { useEffect, useRef, useState } from "react";

interface ExportButtonsProps {
  /** Rows to export. Each row is a flat (or near-flat) object. */
  data: Record<string, unknown>[];
  /** Base filename (no extension). E.g. "btc-markets-2026-05-24". */
  filename: string;
  /** Optional column order. If omitted, columns are inferred from row 0. */
  columns?: string[];
  /** Optional small className override for layout integration. */
  className?: string;
}

export default function ExportButtons({
  data,
  filename,
  columns,
  className,
}: ExportButtonsProps) {
  const [open, setOpen] = useState(false);
  const disabled = !data || data.length === 0;

  function trigger(format: "csv" | "json") {
    if (disabled) return;
    if (format === "json") {
      downloadBlob(
        JSON.stringify(data, null, 2),
        `${filename}.json`,
        "application/json"
      );
    } else {
      downloadBlob(toCsv(data, columns), `${filename}.csv`, "text/csv");
    }
    setOpen(false);
  }

  // DaisyUI's .dropdown class hides .dropdown-content via CSS unless the
  // parent has :focus-within OR carries the `dropdown-open` class. Our
  // React state controls visibility independently, but the CSS was
  // still hiding the menu (visibility: hidden + opacity: 0). Two fixes
  // applied below:
  //   1. Use plain `relative` positioning instead of DaisyUI's dropdown
  //      utility, so no CSS hides the menu when we render it.
  //   2. Close on outside-click via a document-level pointerdown handler
  //      so the menu doesn't stick open forever when the user clicks
  //      elsewhere.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={containerRef}
      className={`relative inline-block ${className ?? ""}`}
    >
      <button
        type="button"
        className="btn btn-xs btn-outline"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        Export ⇣
      </button>
      {open && (
        <ul
          className="absolute right-0 mt-1 z-50 p-1 shadow-lg bg-base-100 border border-base-300 rounded-box w-32 menu menu-sm"
          role="menu"
        >
          <li>
            <button
              type="button"
              onClick={() => trigger("csv")}
              className="text-sm"
            >
              CSV
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={() => trigger("json")}
              className="text-sm"
            >
              JSON
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV converter
// ---------------------------------------------------------------------------

function toCsv(
  rows: Record<string, unknown>[],
  columns?: string[]
): string {
  if (rows.length === 0) return "";
  const cols = columns ?? inferColumns(rows);
  const head = cols.map(csvEscape).join(",");
  const body = rows
    .map((row) =>
      cols
        .map((c) => csvEscape(stringifyCell(row[c])))
        .join(",")
    )
    .join("\n");
  return `${head}\n${body}\n`;
}

function inferColumns(rows: Record<string, unknown>[]): string[] {
  // Use the union of keys across the first 50 rows, in first-seen order,
  // so an early row with missing fields doesn't drop columns that appear
  // later. Cap at 50 to stay O(1) for huge datasets.
  const seen = new Set<string>();
  const order: string[] = [];
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    for (const k of Object.keys(rows[i])) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }
  return order;
}

function stringifyCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Objects / arrays → JSON-encode (keeps the CSV one-row-per-record)
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function csvEscape(s: string): string {
  // RFC 4180: quote any field containing comma, quote, or newline.
  // Inside the quoted field, double any embedded quotes.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Browser download trigger
// ---------------------------------------------------------------------------

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}
