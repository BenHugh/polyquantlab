"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Counts up to `value` once when scrolled into view. Used on the
 * landing-page hero stats line — gives the page a "Lovable / linear
 * homepage" feel without committing to a chart library.
 *
 * Implementation:
 *   - IntersectionObserver watches the element; animation starts only
 *     when the user can actually see it (avoids wasted requestAnimationFrame
 *     work when below the fold).
 *   - rAF-driven easing so it stays smooth at 60-120 Hz refresh rates.
 *   - `prefix` / `suffix` props let the caller render the number with
 *     a unit (e.g. "$" / "k" / "/sec") without string-templating outside.
 */
export default function AnimatedCounter({
  value,
  prefix = "",
  suffix = "",
  duration = 1200,
  decimals = 0,
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  /** Animation duration in ms. */
  duration?: number;
  /** Decimal places to render. */
  decimals?: number;
}) {
  const [display, setDisplay] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !started.current) {
            started.current = true;
            const start = performance.now();
            function tick(now: number) {
              const elapsed = now - start;
              const t = Math.min(1, elapsed / duration);
              // ease-out-cubic — feels like the number lands rather than
              // ramps linearly through the final values.
              const eased = 1 - Math.pow(1 - t, 3);
              setDisplay(eased * value);
              if (t < 1) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
          }
        }
      },
      { threshold: 0.3 }
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [value, duration]);

  return (
    <span ref={ref} className="tabular-nums">
      {prefix}
      {display.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </span>
  );
}
