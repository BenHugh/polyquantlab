import PageHeader from "@/components/PageHeader";
import SweepResult from "@/components/SweepResult";

export const dynamic = "force-dynamic";

export default async function SweepResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        eyebrow="Parameter sweep"
        title="Result"
        subtitle={<span className="font-mono text-xs">{id}</span>}
      />
      <SweepResult jobId={id} />
    </div>
  );
}
