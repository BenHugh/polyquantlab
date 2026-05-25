import NewPaperStrategyForm from "@/components/NewPaperStrategyForm";
import PageHeader from "@/components/PageHeader";

export const dynamic = "force-dynamic";

export default function NewPaperStrategyPage() {
  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        eyebrow="Paper trading"
        title="New paper strategy"
        subtitle="Same strategy shape as backtest, but instead of replaying history we evaluate it on every new snapshot from now on. Check back in a few hours / days to see your virtual P&L."
      />
      <NewPaperStrategyForm />
    </div>
  );
}
