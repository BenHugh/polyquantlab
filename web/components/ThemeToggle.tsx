"use client";

import { useEffect, useState } from "react";

/**
 * Three-state theme switcher: System / Dark / Light.
 *
 * Defaults to dark (the most common preference for our quant audience).
 * Preference is persisted to localStorage under `pql-theme` so it sticks
 * across reloads. The actual swap happens by writing `data-theme` on
 * <html> — both `quant-dark` and `quant-light` are already defined as
 * DaisyUI themes in app/globals.css, so the swap is purely a CSS-var
 * cascade (no re-mount, no flash).
 *
 * The "System" option follows `prefers-color-scheme`. We listen for
 * media-query changes so a user who toggles their OS at night gets the
 * dashboard switching with them.
 *
 * Rendered in two places:
 *   - Landing page header (matches Linear / Vercel marketing pages)
 *   - Dashboard sidebar footer (matches TradingView / Linear app shells)
 *
 * Single-source-of-truth: any page using <ThemeToggle/> shares the same
 * localStorage key, so toggling on the dashboard is immediately visible
 * on the marketing pages and vice versa.
 */

type Mode = "system" | "dark" | "light";

const STORAGE_KEY = "pql-theme";

function applyTheme(mode: Mode) {
  if (typeof window === "undefined") return;
  let actual: "quant-dark" | "quant-light";
  if (mode === "system") {
    actual = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "quant-dark"
      : "quant-light";
  } else {
    actual = mode === "dark" ? "quant-dark" : "quant-light";
  }
  document.documentElement.setAttribute("data-theme", actual);
}

export default function ThemeToggle({
  /** Compact = icon-only square button (sidebar); full = labelled cycle (header). */
  compact = false,
}: {
  compact?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("dark");
  const [mounted, setMounted] = useState(false);

  // On first render, read the saved preference + apply it. We delay
  // showing the icon until after this runs so we don't flash the wrong
  // icon (e.g. moon on a light page) for a frame.
  useEffect(() => {
    const saved = (localStorage.getItem(STORAGE_KEY) as Mode | null) ?? "dark";
    setMode(saved);
    applyTheme(saved);
    setMounted(true);

    // If the user picks "system", listen for OS theme changes so the
    // dashboard moves with them.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current = (localStorage.getItem(STORAGE_KEY) as Mode | null) ?? "dark";
      if (current === "system") applyTheme("system");
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  function cycle() {
    // dark → light → system → dark...
    const next: Mode = mode === "dark" ? "light" : mode === "light" ? "system" : "dark";
    setMode(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }

  if (!mounted) {
    // Reserve space so the layout doesn't shift on hydration.
    return <div className={compact ? "w-8 h-8" : "w-20 h-8"} aria-hidden />;
  }

  const icon =
    mode === "dark" ? <IconMoon /> : mode === "light" ? <IconSun /> : <IconLaptop />;
  const label =
    mode === "dark" ? "Dark" : mode === "light" ? "Light" : "System";

  if (compact) {
    return (
      <button
        type="button"
        onClick={cycle}
        title={`Theme: ${label} (click to cycle)`}
        aria-label={`Theme: ${label}`}
        className="btn btn-ghost btn-sm btn-square text-base-content/70 hover:text-base-content"
      >
        {icon}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={cycle}
      className="btn btn-ghost btn-sm gap-2 text-base-content/70 hover:text-base-content"
      title={`Theme: ${label} (click to cycle)`}
    >
      {icon}
      <span className="text-xs">{label}</span>
    </button>
  );
}

/* Inline SVG so we don't pull a fourth icon library just for this. */
function IconMoon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
function IconSun() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}
function IconLaptop() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M2 20h20" />
    </svg>
  );
}
