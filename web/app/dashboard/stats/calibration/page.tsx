import ButtonAccount from "@/components/ButtonAccount";
import CalibrationView from "@/components/CalibrationView";
import { createClient } from "@/libs/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /dashboard/stats/calibration — "is Polymarket well-calibrated?"
 *
 * Shows a scatter / bar combo: for each bucket of implied probability
 * (Up share at T-N min before resolution), what fraction of markets
 * actually resolved Up. A perfectly-calibrated market lies on y=x.
 * Systematic bias = exploitable edge.
 *
 * This page exists for two reasons:
 *   - End-user value: traders see WHERE Polymarket is mispriced and
 *     can build strategies around the bias.
 *   - Marketing: the data here is unique to us (Polymarket itself
 *     never publishes it). Each bucket bar is a screenshot we can put
 *     on Twitter / a blog post.
 */
export default async function CalibrationPage() {
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
              href="/dashboard"
              className="link link-hover text-sm"
            >
              ← Dashboard
            </Link>
            <h1 className="text-3xl md:text-4xl font-extrabold mt-1">
              Market calibration
            </h1>
            <p className="text-sm opacity-70 mt-1 max-w-2xl">
              For each bucket of implied probability T minutes before
              resolution, how often did Polymarket markets actually
              resolve Up? Bars on the y=x line mean perfect calibration;
              deviations are systematic mispricings.
            </p>
          </div>
          <ButtonAccount />
        </div>

        <CalibrationView />
      </section>
    </main>
  );
}
