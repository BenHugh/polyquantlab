import DashboardShell from "@/components/DashboardShell";
import config from "@/config";
import { getSubscription } from "@/libs/fastapi";
import { createClient } from "@/libs/supabase/server";
import { redirect } from "next/navigation";
import { ReactNode } from "react";

/**
 * Private dashboard layout — auth gate + persistent sidebar shell.
 *
 * Every /dashboard/* page renders inside `DashboardShell`, which owns
 * the sidebar nav, the mobile drawer, and the account/plan footer. The
 * children prop is just the per-page content area.
 *
 * We resolve the user's tier here (one Postgres-via-internal-API call
 * per page render) so the sidebar can show "Plan: Premium" without
 * each page having to fetch it separately. Tier lookup failures are
 * silently downgraded to "Free" — we never block dashboard rendering
 * on the FastAPI side being healthy.
 */
export default async function LayoutPrivate({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(config.auth.loginUrl);
  }

  let tierDisplay = "Free";
  if (user.email) {
    try {
      const sub = await getSubscription(user.email);
      tierDisplay = sub.tier_display;
    } catch {
      // FastAPI down → keep default Free, dashboard still renders
    }
  }

  return (
    <DashboardShell
      tierDisplay={tierDisplay}
      userEmail={user.email ?? undefined}
    >
      {children}
    </DashboardShell>
  );
}
