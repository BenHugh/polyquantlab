import ButtonAccount from "@/components/ButtonAccount";
import PaperStrategiesList from "@/components/PaperStrategiesList";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PaperListPage() {
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
            <Link href="/dashboard" className="link link-hover text-sm">
              ← Dashboard
            </Link>
            <h1 className="text-3xl md:text-4xl font-extrabold mt-1">
              Paper trading
            </h1>
            <p className="text-sm opacity-70 mt-1 max-w-2xl">
              Save a strategy and we&apos;ll run it on every new
              snapshot — virtual fills, virtual P&L, real out-of-sample
              data. 30 days of paper trading is worth more than any
              backtest for confidence-building.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/dashboard/paper/new" className="btn btn-primary btn-sm">
              + New strategy
            </Link>
            <ButtonAccount />
          </div>
        </div>

        <PaperStrategiesList />
      </section>
    </main>
  );
}
