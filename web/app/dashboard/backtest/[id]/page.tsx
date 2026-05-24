import BacktestResult from "@/components/BacktestResult";
import ButtonAccount from "@/components/ButtonAccount";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /dashboard/backtest/[id] — job status + result.
 *
 * The page shell is server-rendered (auth check + nav), but the actual
 * status/result fetching is in a client component because it polls
 * (typical jobs are 2-15 s). On COMPLETED we render the PnL sparkline +
 * stats + trades table; on FAILED we surface the worker's error.
 */
export default async function BacktestResultPage({
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
      <section className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Link
              href="/dashboard/backtest"
              className="link link-hover text-sm"
            >
              ← New backtest
            </Link>
            <h1 className="text-2xl md:text-3xl font-extrabold mt-1">
              Backtest result
            </h1>
            <p className="font-mono text-xs opacity-60 mt-1">{id}</p>
          </div>
          <ButtonAccount />
        </div>

        <BacktestResult jobId={id} />
      </section>
    </main>
  );
}
