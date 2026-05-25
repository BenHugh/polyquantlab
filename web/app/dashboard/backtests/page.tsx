import PageHeader from "@/components/PageHeader";
import SavedBacktestsList from "@/components/SavedBacktestsList";

export const dynamic = "force-dynamic";

export default function SavedBacktestsPage() {
  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Saved Backtests"
        subtitle="Every backtest you've run, newest first. Click a row to revisit the equity curve + trade list. Results auto-expire after 24h."
      />
      <SavedBacktestsList />
    </div>
  );
}
