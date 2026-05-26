import PageHeader from "@/components/PageHeader";
import StrategyBuilder from "@/components/StrategyBuilder";

export const dynamic = "force-dynamic";

export default function StrategyBuilderPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        prefix="/ 01 –"
        title="Strategy Builder"
        tag="Untitled Strategy"
        subtitle="Build a custom Up/Down strategy from conditions — no Python required. Backtests run on the same engine as our preset strategies, with the real Polymarket 2026 fee model."
      />
      <StrategyBuilder />
    </div>
  );
}
