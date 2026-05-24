/**
 * Locale-independent date formatters.
 *
 * Why this exists: `Date.toLocaleString("en-US", ...)` produces SUBTLY
 * different output between Node.js's ICU build (server-rendered HTML)
 * and Chrome's V8 ICU (client-rendered HTML) — e.g. Node emits
 * "May 23, 2026, 04:41 PM" while Chrome emits "May 23, 2026 at 04:41 PM".
 * That single comma-vs-"at" delta is enough to trip React's hydration
 * mismatch check.
 *
 * Solution: format everything ourselves with primitive Date getters.
 * Output is byte-identical regardless of runtime, system locale, or
 * browser locale. The tradeoff is no i18n — but our UI is English-only
 * for now and consistency matters more than auto-localised dates.
 *
 * All functions accept an ISO 8601 string OR a Date, and return "—" for
 * null/undefined/invalid input so callers don't have to null-check.
 */

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function toDate(input: string | Date | null | undefined): Date | null {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "May 23, 2026, 04:41 PM" */
export function formatDateTime(input: string | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return "—";
  const month = MONTHS_SHORT[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();
  let hour = d.getHours();
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  const minute = pad2(d.getMinutes());
  return `${month} ${day}, ${year}, ${pad2(hour)}:${minute} ${ampm}`;
}

/** "May 23, 2026" — date only */
export function formatDateShort(input: string | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return "—";
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "04:41:23 PM" — clock-time only */
export function formatTimeOnly(input: string | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return "—";
  let hour = d.getHours();
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${pad2(hour)}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${ampm}`;
}
