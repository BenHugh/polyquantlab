/**
 * Consistent page header across dashboard surfaces.
 *
 * Used inside DashboardShell — the shell owns global nav + account
 * button, so this only needs the per-page title, optional subtitle,
 * and optional right-aligned actions. Centralised so type / weight /
 * spacing stay identical from page to page.
 */
import { ReactNode } from "react";

export default function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Small uppercase label above the title — e.g. "Backtest" on a result page */
  eyebrow?: string;
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
          {title}
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
