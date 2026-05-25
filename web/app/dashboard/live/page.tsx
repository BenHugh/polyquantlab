import PageHeader from "@/components/PageHeader";
import LiveTerminal from "@/components/LiveTerminal";

export const dynamic = "force-dynamic";

export default function LiveTerminalPage() {
  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        title="Live Terminal"
        subtitle="Currently-trading Polymarket Up/Down markets across timeframes, side-by-side with Binance spot."
      />
      <LiveTerminal />
    </div>
  );
}
