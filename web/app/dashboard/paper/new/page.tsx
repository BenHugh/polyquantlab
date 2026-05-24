import ButtonAccount from "@/components/ButtonAccount";
import NewPaperStrategyForm from "@/components/NewPaperStrategyForm";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function NewPaperStrategyPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Link href="/dashboard/paper" className="link link-hover text-sm">
              ← Paper trading
            </Link>
            <h1 className="text-3xl md:text-4xl font-extrabold mt-1">
              New paper strategy
            </h1>
            <p className="text-sm opacity-70 mt-1 max-w-2xl">
              Same strategy shape as backtest, but instead of replaying
              history we evaluate it on every NEW snapshot from now on.
              Check back in a few hours / days to see your virtual P&L.
            </p>
          </div>
          <ButtonAccount />
        </div>

        <NewPaperStrategyForm />
      </section>
    </main>
  );
}
