import BacktestResult from "@/components/BacktestResult";
import PageHeader from "@/components/PageHeader";

export const dynamic = "force-dynamic";

export default async function BacktestResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        eyebrow="Backtest"
        title="Result"
        subtitle={<span className="font-mono text-xs">{id}</span>}
      />
      <BacktestResult jobId={id} />
    </div>
  );
}
