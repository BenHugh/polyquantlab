import PageHeader from "@/components/PageHeader";
import ArbDashboard from "@/components/ArbDashboard";

export const dynamic = "force-dynamic";

export default function ArbPage() {
  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        prefix="/ LIVE"
        title="Mispricing Monitor"
        subtitle="Polymarket binary markets vs Binance spot, plus logical arbs (yes+no < $1). Research view — not a trading signal. Real-money results disclosed below."
      />
      <ArbDashboard />
    </div>
  );
}
