import PageHeader from "@/components/PageHeader";
import PaperStrategyDetail from "@/components/PaperStrategyDetail";

export const dynamic = "force-dynamic";

export default async function PaperStrategyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        eyebrow="Paper trading"
        title="Strategy detail"
        subtitle={<span className="font-mono text-xs">{id}</span>}
      />
      <PaperStrategyDetail strategyId={id} />
    </div>
  );
}
