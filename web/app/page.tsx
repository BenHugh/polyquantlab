import type { ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Boxes,
  CandlestickChart,
  CheckCircle2,
  Clock,
} from "lucide-react";
import AnimatedCounter from "@/components/AnimatedCounter";
import ButtonSignin from "@/components/ButtonSignin";
import Pricing from "@/components/Pricing";
import ThemeToggle from "@/components/ThemeToggle";
import config from "@/config";
import Link from "next/link";

/**
 * Public landing page.
 *
 * Visual language: a balance between Linear's professional restraint
 * (for credibility with serious quants) and Lovable / Vercel-V0's
 * premium feel (for marketing impact). Specifically:
 *
 *   - Aurora gradient background (3 soft brand-colour blobs, animated)
 *     behind a faint data-grid overlay — colour without flash.
 *   - Frosted-glass sticky nav.
 *   - Animated number counters in the credibility row.
 *   - Tinted halo glow on the primary CTA.
 *   - Feature cards with hover-lift + tinted shadow.
 *   - Subtle conic-gradient border on the "live demo" card.
 *
 * Phase F polish later: product screenshots, comparison table vs
 * PolyBackTest, testimonials block once we have customers.
 */
export default function Page() {
  return (
    <div className="min-h-screen bg-base-100 text-base-content">
      {/* ─── Sticky frosted-glass header ─────────────────────────────── */}
      <header className="sticky top-0 z-30 glass-strong border-b border-base-300/40">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 group">
            <span className="w-2 h-2 rounded-full bg-primary group-hover:scale-125 transition-transform" />
            <span className="font-semibold tracking-tight">
              {config.appName}
            </span>
          </Link>
          <nav className="flex items-center gap-2 sm:gap-6">
            <Link
              href="/#features"
              className="hidden sm:inline text-sm text-base-content/70 hover:text-base-content transition-colors"
            >
              Features
            </Link>
            <Link
              href="/#pricing"
              className="text-sm text-base-content/70 hover:text-base-content transition-colors"
            >
              Pricing
            </Link>
            <a
              href="https://github.com/BenHugh/polyquantlab"
              target="_blank"
              rel="noopener"
              className="hidden sm:inline text-sm text-base-content/70 hover:text-base-content transition-colors"
            >
              GitHub
            </a>
            <ThemeToggle />
            <ButtonSignin text="Sign in" />
          </nav>
        </div>
      </header>

      <main>
        {/* ─── Hero (aurora background) ─────────────────────────────── */}
        <section className="aurora-bg relative overflow-hidden">
          <div className="max-w-6xl mx-auto px-6 py-24 sm:py-32 lg:py-40 text-center relative">
            {/* Status pill */}
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full glass text-xs text-base-content/80 mb-8">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
              </span>
              <span>Live collector · 110+ snapshots / second · 24×7</span>
            </div>

            {/* Hero title */}
            <h1 className="text-4xl sm:text-6xl md:text-7xl lg:text-[5.5rem] font-bold tracking-tight leading-[1.02]">
              <span className="block">Backtest Polymarket</span>
              <span className="block mt-2 text-gradient">
                with real depth.
              </span>
            </h1>

            {/* Sub */}
            <p className="text-base sm:text-lg lg:text-xl text-base-content/60 mt-7 max-w-2xl mx-auto leading-relaxed">
              Sub-second orderbook snapshots. Walk-the-book execution.
              Polymarket&apos;s real 2026 fee schedule. Calibration plots,
              parameter sweeps, paper trading — the analysis layer
              PolyBackTest doesn&apos;t ship.
            </p>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-10">
              <Link
                href="/signin"
                className="btn btn-primary btn-lg btn-halo glow-primary rounded-xl px-7"
              >
                Start free →
              </Link>
              <Link
                href="/#pricing"
                className="btn btn-ghost btn-lg rounded-xl"
              >
                See pricing
              </Link>
            </div>

            {/* Trust / stats row with animated counters */}
            <div className="mt-16 sm:mt-20 grid grid-cols-2 md:grid-cols-4 gap-4 max-w-3xl mx-auto">
              <Stat
                value={9}
                suffix="M+"
                label="snapshots / day"
              />
              <Stat
                value={2730}
                label="active markets"
              />
              <Stat
                value={120}
                label="days retention"
              />
              <Stat
                value={26}
                suffix="×"
                label="data compression"
              />
            </div>

            {/* Credibility line */}
            <div className="mt-14 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[11px] font-mono text-base-content/40 uppercase tracking-widest">
              <span>BTC</span>
              <span className="text-base-content/20">·</span>
              <span>ETH</span>
              <span className="text-base-content/20">·</span>
              <span>SOL</span>
              <span className="text-base-content/20">|</span>
              <span>5m · 15m · 1h · 4h · Daily</span>
            </div>
          </div>
        </section>

        {/* ─── Feature block — three columns with tinted glow ──────────── */}
        <section id="features" className="relative">
          <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
            <div className="text-center max-w-2xl mx-auto mb-16">
              <p className="text-xs uppercase tracking-widest text-primary font-medium mb-3">
                What you get
              </p>
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
                The analysis stack PolyBackTest skipped.
              </h2>
              <p className="text-base-content/60 mt-3 leading-relaxed">
                Data alone is table stakes. Our differentiation is the
                workflow on top — calibration, sweep, paper trading — that
                turns raw orderbook into deployable strategies.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <FeatureCard
                title="Sub-second orderbook depth"
                body="8 snapshots/sec/market across BTC, ETH, SOL. Walk-the-book backtests with realistic partial fills and Polymarket's 2026 taker fees."
                icon={<CandlestickChart size={20} strokeWidth={1.75} />}
              />
              <FeatureCard
                title="Find real mispricing"
                body="Calibration plots reveal where Polymarket's implied probability diverges from observed Up rates — exactly the signal that bot operators turn into edge."
                icon={<BarChart3 size={20} strokeWidth={1.75} />}
                accent
              />
              <FeatureCard
                title="Validate before deploying"
                body="Parameter sweeps surface robust plateaus over isolated spikes. Paper trading runs your strategy live for out-of-sample confirmation."
                icon={<CheckCircle2 size={20} strokeWidth={1.75} />}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
              <FeatureCard
                title="Live Terminal"
                body="Currently-trading 5m/15m/1h/4h/daily markets side by side with Binance spot. Mispricing badges surface when implied probability diverges from historical Up rate by 5pp+."
                icon={<Activity size={20} strokeWidth={1.75} />}
              />
              <FeatureCard
                title="No-code Strategy Builder"
                body="Compose Entry / Take Profit / Stop Loss from typed conditions — Token price, Spread, Time to resolution. Same engine, same fees, no Python required."
                icon={<Boxes size={20} strokeWidth={1.75} />}
              />
              <FeatureCard
                title="120-day retention"
                body="Twice the lookback window PolyBackTest offers. Long enough to backtest across regime shifts, not just last month's tape."
                icon={<Clock size={20} strokeWidth={1.75} />}
              />
            </div>
          </div>
        </section>

        {/* ─── Workflow strip ─────────────────────────────────────────── */}
        <section className="border-t border-base-300/40 bg-base-200/30">
          <div className="max-w-6xl mx-auto px-6 py-20">
            <div className="text-center max-w-2xl mx-auto mb-12">
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
                A 4-step quant workflow, end to end.
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Step n="01" title="Discover" body="Calibration plot reveals systematic mispricing buckets per ticker × window." />
              <Step n="02" title="Build" body="Backtest engine prices in walk-the-book fills + real Polymarket fees." />
              <Step n="03" title="Stress-test" body="Parameter sweep finds the robust plateau, not the overfit spike." />
              <Step n="04" title="Validate live" body="Paper trading runs your strategy on every new snapshot for out-of-sample proof." />
            </div>
          </div>
        </section>

        {/* ─── Pricing ────────────────────────────────────────────────── */}
        <div className="border-t border-base-300/40" id="pricing">
          <Pricing />
        </div>
      </main>

      <footer className="border-t border-base-300/40">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row justify-between items-center gap-3 text-sm text-base-content/50">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary" />
            <span>© 2026 {config.appName}. Not affiliated with Polymarket.</span>
          </div>
          <div className="flex gap-5">
            <Link href="/tos" className="hover:text-base-content transition-colors">
              Terms
            </Link>
            <Link href="/privacy-policy" className="hover:text-base-content transition-colors">
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ─── Sub-components ───────────────────────────────────────────────── */

function Stat({
  value,
  suffix,
  prefix,
  label,
  decimals,
}: {
  value: number;
  suffix?: string;
  prefix?: string;
  label: string;
  decimals?: number;
}) {
  return (
    <div className="glass rounded-xl p-5 text-left">
      <div className="text-2xl md:text-3xl font-bold tracking-tight">
        <AnimatedCounter
          value={value}
          prefix={prefix}
          suffix={suffix}
          decimals={decimals}
        />
      </div>
      <div className="text-xs uppercase tracking-wider text-base-content/50 mt-1">
        {label}
      </div>
    </div>
  );
}

function FeatureCard({
  title,
  body,
  icon,
  accent,
}: {
  title: string;
  body: string;
  icon: ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={`feature-card rounded-2xl p-6 ${accent ? "gradient-border bg-base-200/30 glow-card" : "bg-base-200/30"}`}
    >
      <div className="w-11 h-11 rounded-lg bg-base-300/50 border border-base-300 flex items-center justify-center mb-5 text-primary">
        {icon}
      </div>
      <h3 className="font-semibold text-lg tracking-tight mb-2">{title}</h3>
      <p className="text-sm text-base-content/60 leading-relaxed">{body}</p>
    </div>
  );
}

function Step({
  n,
  title,
  body,
}: {
  n: string;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-base-300/60 bg-base-100 p-5 hover-card-lift">
      <div className="text-xs font-mono text-primary mb-3">{n}</div>
      <div className="font-semibold tracking-tight mb-1">{title}</div>
      <p className="text-sm text-base-content/60 leading-relaxed">{body}</p>
    </div>
  );
}

/* Inline icon components removed — feature cards now use lucide-react
 * icons imported at the top of this file. Visual mass (20px, 1.75
 * stroke) is preserved so layout doesn't shift. */
