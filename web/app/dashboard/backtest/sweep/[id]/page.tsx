import ButtonAccount from "@/components/ButtonAccount";
import SweepResult from "@/components/SweepResult";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SweepResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Link
              href="/dashboard/backtest/sweep"
              className="link link-hover text-sm"
            >
              ← New sweep
            </Link>
            <h1 className="text-2xl md:text-3xl font-extrabold mt-1">
              Sweep result
            </h1>
            <p className="font-mono text-xs opacity-60 mt-1">{id}</p>
          </div>
          <ButtonAccount />
        </div>

        <SweepResult jobId={id} />
      </section>
    </main>
  );
}
