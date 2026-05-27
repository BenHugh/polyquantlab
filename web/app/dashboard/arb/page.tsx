import PageHeader from "@/components/PageHeader";
import ArbDashboard from "@/components/ArbDashboard";

export const dynamic = "force-dynamic";

export default function ArbPage() {
  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        prefix="/ LIVE"
        title="Arbitrage Scanner"
        subtitle="Polymarket binary markets vs Binance spot — real-time mispricing the bots haven't fixed yet. Updated every 4 seconds."
      />
      <ArbDashboard />
    </div>
  );
}
