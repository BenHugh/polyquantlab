import ButtonSignin from "@/components/ButtonSignin";
import Pricing from "@/components/Pricing";
import config from "@/config";
import Link from "next/link";

/**
 * Public landing page.
 *
 * Visual language deliberately matches the dashboard:
 *   - dark surface with subtle radial accent + faint grid
 *   - monospace stats line for credibility
 *   - hairline borders, single emerald accent
 *
 * Phase F polish later: add product screenshots, testimonials block,
 * comparison-to-PolyBackTest table.
 */
export default function Page() {
  return (
    <div className="min-h-screen bg-base-100 text-base-content">
      {/* Header */}
      <header className="sticky top-0 z-20 backdrop-blur bg-base-100/70 border-b border-base-300/60">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 group">
            <span className="w-2 h-2 rounded-full bg-primary" />
            <span className="font-semibold tracking-tight">
              {config.appName}
            </span>
          </Link>
          <nav className="flex items-center gap-6">
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
              className="text-sm text-base-content/70 hover:text-base-content transition-colors"
            >
              GitHub
            </a>
            <ButtonSignin text="Sign in" />
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="hero-grid-bg relative">
          <div className="max-w-6xl mx-auto px-6 py-20 sm:py-28 lg:py-32 text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-base-300 bg-base-200/50 text-xs text-base-content/70 mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              <span>110+ snapshots/sec · 24×7 collector live</span>
            </div>

            <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05]">
              <span className="block">Backtest Polymarket</span>
              <span className="block">
                with{" "}
                <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
                  real orderbook depth
                </span>
              </span>
            </h1>

            <p className="text-lg sm:text-xl text-base-content/60 mt-6 max-w-2xl mx-auto leading-relaxed">
              Sub-second snapshots. Walk-the-book execution. Real
              Polymarket fees. Calibration plots, parameter sweeps, and
              live paper trading — the analysis layer PolyBackTest
              doesn&apos;t ship.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
              <Link href="/signin" className="btn btn-primary btn-lg">
                Start free
              </Link>
              <Link
                href="/#pricing"
                className="btn btn-ghost btn-lg"
              >
                See pricing
              </Link>
            </div>

            <div className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-xs font-mono text-base-content/50 uppercase tracking-wider">
              <span>BTC · ETH · SOL</span>
              <span className="hidden sm:inline">|</span>
              <span>5m · 15m · 1h · 4h · Daily</span>
              <span className="hidden sm:inline">|</span>
              <span>120-day history retention</span>
            </div>
          </div>
        </section>

        {/* Feature strip — light density, scannable */}
        <section className="max-w-6xl mx-auto px-6 py-20 border-t border-base-300/40">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <FeatureBlock
              title="Sub-second orderbook depth"
              body="8 snapshots/sec/market with the same density PolyBackTest charges for. Walk-the-book backtests with realistic fills + Polymarket's 2026 fee schedule."
            />
            <FeatureBlock
              title="Find real mispricing"
              body="Calibration plots show exactly where Polymarket's implied probability diverges from realised outcomes — per ticker, per window."
            />
            <FeatureBlock
              title="Validate before trading"
              body="Parameter sweep finds robust parameter plateaus, then paper trading runs your strategy live for out-of-sample confirmation."
            />
          </div>
        </section>

        <div className="border-t border-base-300/40" id="pricing">
          <Pricing />
        </div>
      </main>

      <footer className="border-t border-base-300/40 mt-10">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row justify-between items-center gap-3 text-sm text-base-content/50">
          <div>© 2026 {config.appName}. Not affiliated with Polymarket.</div>
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

function FeatureBlock({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="w-10 h-10 rounded-lg border border-base-300 bg-base-200/50 flex items-center justify-center mb-4">
        <span className="w-2 h-2 rounded-full bg-primary" />
      </div>
      <h3 className="font-semibold tracking-tight text-lg mb-2">{title}</h3>
      <p className="text-sm text-base-content/60 leading-relaxed">{body}</p>
    </div>
  );
}
