import ButtonAccount from "@/components/ButtonAccount";
import PaperStrategyDetail from "@/components/PaperStrategyDetail";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PaperStrategyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Link href="/dashboard/paper" className="link link-hover text-sm">
              ← All paper strategies
            </Link>
            <h1 className="text-2xl md:text-3xl font-extrabold mt-1">
              Paper strategy
            </h1>
            <p className="font-mono text-xs opacity-60 mt-1">{id}</p>
          </div>
          <ButtonAccount />
        </div>

        <PaperStrategyDetail strategyId={id} />
      </section>
    </main>
  );
}
