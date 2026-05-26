/**
 * Consistent page header across dashboard surfaces.
 *
 * Used inside DashboardShell — the shell owns global nav + account
 * button, so this only needs the per-page title, optional subtitle,
 * and optional right-aligned actions. Centralised so type / weight /
 * spacing stay identical from page to page.
 *
 * Phase AA.1 additions:
 *   - `prefix`  — a small mono "/ NN –" style numerical prefix
 *                 rendered to the left of the title in blue accent.
 *                 Used on Strategy Builder / Sweep to signal a
 *                 multi-step workflow ("01 — Strategy Builder").
 *   - `tag`     — a faint mono badge with a dashed underline to the
 *                 right of the title. Used for things like
 *                 "Untitled Strategy" — an editable in-flight hint
 *                 that the title row carries auxiliary state.
 */
import { ReactNode } from "react";

export default function PageHeader({
  title,
  subtitle,
  eyebrow,
  prefix,
  tag,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Small uppercase label above the title — e.g. "Backtest" on a result page */
  eyebrow?: string;
  /** Blue mono prefix before the title, e.g. "/ 01 –" */
  prefix?: string;
  /** Inline mono tag after the title, e.g. "Untitled Strategy" */
  tag?: string;
  /** Right-aligned controls (e.g. New backtest button) */
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div className="space-y-1">
        {eyebrow && (
          <div className="text-[11px] uppercase tracking-wider text-base-content/50 font-medium">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
          {prefix && <span className="q-page-prefix">{prefix}</span>}
          {title}
          {tag && <span className="q-page-tag">{tag}</span>}
        </h1>
        {subtitle && (
          <p className="text-sm text-base-content/60 max-w-2xl">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">{actions}</div>
      )}
    </header>
  );
}
