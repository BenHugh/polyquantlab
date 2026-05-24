import Link from "next/link";
import ButtonSignin from "@/components/ButtonSignin";
import Pricing from "@/components/Pricing";
import config from "@/config";

// Public landing page.
//
// Phase F will replace the hero copy with real product screenshots +
// FeaturesAccordion sections. For now we just need:
//   - A clear "what is this" headline so visitors don't bounce
//   - A pricing section anchored at /#pricing (the dashboard links here
//     when a Free user clicks "Upgrade")
//   - A sign-in button so existing users can get back into the dashboard
export default function Page() {
  return (
    <>
      <header className="p-4 flex items-center justify-between max-w-7xl mx-auto">
        <Link href="/" className="font-bold text-lg">
          {config.appName}
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/#pricing" className="link link-hover text-sm">
            Pricing
          </Link>
          <ButtonSignin text="Sign in" />
        </div>
      </header>

      <main>
        <section className="flex flex-col items-center justify-center text-center gap-8 px-8 py-24 max-w-3xl mx-auto">
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight">
            Backtest Polymarket crypto markets with{" "}
            <span className="text-primary">real orderbook depth</span>
          </h1>

          <p className="text-lg text-base-content/70">
            Sub-second orderbook snapshots, walk-the-book execution, full
            historical depth — and an interactive web UI so you don&apos;t
            have to wire up a notebook before your first backtest.
          </p>

          <div className="flex flex-col sm:flex-row items-center gap-4">
            <Link href="/#pricing" className="btn btn-primary btn-wide">
              See pricing
            </Link>
            <Link href="/signin" className="btn btn-ghost">
              Sign in →
            </Link>
          </div>

          <p className="text-sm text-base-content/60">
            BTC · ETH · SOL · Up/Down markets · 8 snapshots/sec/market
          </p>
        </section>

        <Pricing />
      </main>
    </>
  );
}
