"use client";

/**
 * Persistent sidebar + main-content shell for every /dashboard/* page.
 *
 * Design choices:
 *
 *   - 240px sidebar on desktop; collapses to a top bar on < md screens.
 *   - Active route gets a soft accent background, not a heavy fill —
 *     same convention as Linear, Vercel, Notion.
 *   - User account button + plan badge live at the bottom of the
 *     sidebar so the main content area stays clean.
 *   - Mobile menu uses a slide-in drawer (DaisyUI's `drawer` primitive)
 *     so the same component tree works on phones.
 *
 * We deliberately don't put a search box in the global chrome — each
 * page has its own local search (Markets list does). A global "command
 * palette" is a future Phase F polish item.
 */

import ButtonAccount from "@/components/ButtonAccount";
import ThemeToggle from "@/components/ThemeToggle";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";
import {
  Activity,
  BookmarkCheck,
  Boxes,
  Grid2x2,
  Grid3x3,
  KeyRound,
  LayoutDashboard,
  ListOrdered,
  PlayCircle,
  Sparkles,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** Matches /dashboard, /dashboard/* by prefix unless `exact` */
  exact?: boolean;
}

// lucide stroke icons, 16px, 1.75 weight — keeps the same visual mass
// as the previous inline SVGs but with consistent corner-radius and
// optical alignment across the icon family.
const ICON_PROPS = { size: 16, strokeWidth: 1.75 } as const;

const NAV: NavItem[] = [
  {
    href: "/dashboard",
    label: "Overview",
    exact: true,
    icon: <LayoutDashboard {...ICON_PROPS} />,
  },
  {
    href: "/dashboard/markets",
    label: "Markets",
    icon: <ListOrdered {...ICON_PROPS} />,
  },
  {
    href: "/dashboard/live",
    label: "Live Terminal",
    icon: <Activity {...ICON_PROPS} />,
  },
  {
    href: "/dashboard/strategy-builder",
    label: "Strategy Builder",
    icon: <Boxes {...ICON_PROPS} />,
  },
  {
    href: "/dashboard/backtest/sweep",
    label: "Sweep",
    icon: <Grid3x3 {...ICON_PROPS} />,
  },
  {
    href: "/dashboard/backtests",
    label: "Saved backtests",
    icon: <BookmarkCheck {...ICON_PROPS} />,
  },
  {
    href: "/dashboard/stats/calibration",
    label: "Calibration",
    icon: <Sparkles {...ICON_PROPS} />,
  },
  {
    href: "/dashboard/paper",
    label: "Paper trading",
    icon: <PlayCircle {...ICON_PROPS} />,
  },
  {
    href: "/dashboard/api-keys",
    label: "API keys",
    icon: <KeyRound {...ICON_PROPS} />,
  },
];

// Silence "unused import" lint for icons exported but only consumed as
// JSX above. (Grid2x2 reserved for a future grouped dashboard view.)
void Grid2x2;

export default function DashboardShell({
  children,
  tierDisplay,
  userEmail,
}: {
  children: ReactNode;
  tierDisplay?: string;
  userEmail?: string;
}) {
  const pathname = usePathname() || "";

  function isActive(item: NavItem): boolean {
    return item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(item.href + "/");
  }

  return (
    <div className="drawer lg:drawer-open min-h-screen bg-base-100">
      <input id="dash-drawer" type="checkbox" className="drawer-toggle" />

      {/* ── Main content ───────────────────────────────────────────── */}
      <div className="drawer-content flex flex-col">
        {/* Mobile top bar */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-base-300 bg-base-100 lg:hidden">
          <label
            htmlFor="dash-drawer"
            className="btn btn-ghost btn-sm btn-square"
            aria-label="Open navigation"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </label>
          <Link href="/dashboard" className="font-semibold tracking-tight">
            PolyQuantLab
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle compact />
            <ButtonAccount />
          </div>
        </header>

        <main className="flex-1 px-4 sm:px-8 py-6 sm:py-10">{children}</main>
      </div>

      {/* ── Sidebar ────────────────────────────────────────────────── */}
      <div className="drawer-side z-30">
        <label htmlFor="dash-drawer" aria-label="close sidebar" className="drawer-overlay" />
        <aside className="w-60 min-h-full bg-base-200 border-r border-base-300 flex flex-col">
          {/* Logo */}
          <div className="px-5 py-5 border-b border-base-300">
            <Link href="/dashboard" className="flex items-center gap-2 group">
              <span className="w-2 h-2 rounded-full bg-primary group-hover:scale-110 transition-transform" />
              <span className="font-semibold tracking-tight text-base">
                PolyQuantLab
              </span>
            </Link>
            <p className="text-[11px] uppercase tracking-wider opacity-50 mt-1">
              Polymarket research
            </p>
          </div>

          {/* Nav */}
          <nav className="flex-1 py-3 px-2 overflow-y-auto">
            <ul className="space-y-0.5">
              {NAV.map((item) => {
                const active = isActive(item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`group flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                        active
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-base-content/70 hover:bg-base-300 hover:text-base-content"
                      }`}
                    >
                      <span
                        className={`shrink-0 transition-colors ${active ? "text-primary" : "opacity-60 group-hover:opacity-100"}`}
                      >
                        {item.icon}
                      </span>
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Footer: account + tier */}
          <div className="border-t border-base-300 p-3 space-y-2">
            {tierDisplay && (
              <div className="px-2 py-1 rounded-md bg-base-300/50 text-xs">
                <div className="opacity-60 uppercase tracking-wider text-[10px]">
                  Plan
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{tierDisplay}</span>
                  {tierDisplay === "Free" && (
                    <Link
                      href="/#pricing"
                      className="text-primary text-[11px] hover:underline"
                    >
                      Upgrade →
                    </Link>
                  )}
                </div>
              </div>
            )}
            {userEmail && (
              <div
                className="text-[11px] opacity-60 truncate px-2"
                title={userEmail}
              >
                {userEmail}
              </div>
            )}
            <div className="flex items-center justify-between px-1">
              <ButtonAccount />
              <ThemeToggle compact />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* Inline SVG icon components removed in favour of lucide-react —
 * see imports at the top of this file. Each maps directly:
 *   IconGrid → LayoutDashboard, IconList → ListOrdered,
 *   IconActivity → Activity,    IconBlocks → Boxes,
 *   IconGridDense → Grid3x3,    IconBookmark → BookmarkCheck,
 *   IconSparkles → Sparkles,    IconPlay → PlayCircle,
 *   IconKey → KeyRound.
 */
