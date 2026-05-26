/**
 * CoinIcon — small monogram disc per supported ticker.
 *
 * lucide doesn't ship crypto-brand icons, and pulling in a
 * crypto-icon package for 3 tickers is overkill. So we render an
 * inline circle in the canonical brand colour with the first letter
 * — exactly how Hyperliquid / Drift / dYdX render compact ticker
 * tags in their UI. Single-character monogram keeps it readable at
 * 14-20px without depending on any binary asset.
 *
 * Colours match each project's brand sheet:
 *   BTC #F7931A   ETH #627EEA   SOL gradient → solid #9945FF
 */
type Ticker = "BTC" | "ETH" | "SOL" | string;

const PALETTE: Record<string, { bg: string; fg: string }> = {
  BTC: { bg: "#F7931A", fg: "#FFFFFF" },
  ETH: { bg: "#627EEA", fg: "#FFFFFF" },
  SOL: { bg: "#9945FF", fg: "#FFFFFF" },
};

export default function CoinIcon({
  ticker,
  size = 16,
  className = "",
}: {
  ticker: Ticker;
  size?: number;
  className?: string;
}) {
  const palette = PALETTE[ticker] ?? { bg: "#3F4756", fg: "#FFFFFF" };
  const letter = ticker.charAt(0).toUpperCase();
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full shrink-0 select-none ${className}`}
      style={{
        width: size,
        height: size,
        background: palette.bg,
        color: palette.fg,
        fontFamily: "var(--font-mono)",
        fontSize: Math.max(8, Math.round(size * 0.55)),
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: "-0.02em",
      }}
      aria-hidden
    >
      {letter}
    </span>
  );
}
