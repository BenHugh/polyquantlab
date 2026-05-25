import PageHeader from "@/components/PageHeader";
import PaperStrategiesList from "@/components/PaperStrategiesList";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function PaperListPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="Paper trading"
        subtitle="Save a strategy and we run it on every new snapshot — virtual fills, virtual P&L, real out-of-sample data. 30 days of paper trading is worth more than any backtest for confidence-building."
        actions={
          <Link href="/dashboard/paper/new" className="btn btn-primary btn-sm">
            + New strategy
          </Link>
        }
      />
      <PaperStrategiesList />
    </div>
  );
}
