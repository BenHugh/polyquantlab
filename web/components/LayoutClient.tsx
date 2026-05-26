"use client";

import { User } from "@supabase/supabase-js";
import { createClient } from "@/libs/supabase/client";
import { useEffect, useState, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Crisp } from "crisp-sdk-web";
import NextTopLoader from "nextjs-toploader";
import { Toaster } from "react-hot-toast";
import { Tooltip } from "react-tooltip";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import config from "@/config";

// Crisp customer chat support:
// This component is separated from ClientLayout because it needs to be wrapped with <SessionProvider> to use useSession() hook
const CrispChat = (): null => {
  const pathname = usePathname();

  const supabase = createClient();
  const [data, setData] = useState<{ user: User }>(null);

  // This is used to get the user data from Supabase Auth (if logged in) => user ID is used to identify users in Crisp
  useEffect(() => {
    const getUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        setData({ user });
      }
    };
    getUser();
  }, [supabase, pathname]);

  useEffect(() => {
    if (config?.crisp?.id) {
      // Set up Crisp
      Crisp.configure(config.crisp.id);

      // (Optional) If onlyShowOnRoutes array is not empty in config.js file, Crisp will be hidden on the routes in the array.
      // Use <AppButtonSupport> instead to show it (user clicks on the button to show Crisp—it cleans the UI)
      if (
        config.crisp.onlyShowOnRoutes &&
        !config.crisp.onlyShowOnRoutes?.includes(pathname)
      ) {
        Crisp.chat.hide();
        Crisp.chat.onChatClosed(() => {
          Crisp.chat.hide();
        });
      }
    }
  }, [pathname]);

  // Add User Unique ID to Crisp to easily identify users when reaching support (optional)
  useEffect(() => {
    if (data?.user && config?.crisp?.id) {
      Crisp.session.setData({ userId: data.user?.id });
    }
  }, [data]);

  return null;
};

// All the client wrappers are here (they can't be in server components)
// 1. NextTopLoader: Show a progress bar at the top when navigating between pages
// 2. Toaster: Show Success/Error messages anywhere from the app with toast()
// 3. Tooltip: Show tooltips if any JSX elements has these 2 attributes: data-tooltip-id="tooltip" data-tooltip-content=""
// 4. CrispChat: Set Crisp customer chat support (see above)
const ClientLayout = ({ children }: { children: ReactNode }) => {
  return (
    <>
      {/* Show a progress bar at the top when navigating between pages */}
      <NextTopLoader color={config.colors.main} showSpinner={false} />

      {/* Content inside app/page.js files  */}
      {children}

      {/* Show Success/Error messages anywhere from the app with toast().
       *
       * Phase AD: swap default emoji-style icons for crisp lucide
       * strokes that match the rest of the app. Also tighten the
       * default styling — flatter background, hairline border, mono
       * font + smaller padding so a toast looks like a quant terminal
       * notification rather than a marketing alert. */}
      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 3000,
          style: {
            background: "oklch(13% 0.012 250)",
            color: "oklch(94% 0.005 250)",
            border: "1px solid oklch(28% 0.013 250 / 0.85)",
            fontFamily: "var(--font-display, Inter), system-ui, sans-serif",
            fontSize: "13px",
            padding: "10px 14px",
            borderRadius: "6px",
            boxShadow:
              "0 1px 0 0 oklch(100% 0 0 / 0.05) inset, 0 18px 40px -12px oklch(0% 0 0 / 0.55)",
          },
          success: {
            icon: (
              <CheckCircle2
                size={16}
                strokeWidth={2}
                color="oklch(72% 0.18 150)"
              />
            ),
          },
          error: {
            icon: (
              <XCircle
                size={16}
                strokeWidth={2}
                color="oklch(65% 0.22 25)"
              />
            ),
          },
          loading: {
            icon: (
              <Loader2
                size={16}
                strokeWidth={2}
                color="oklch(70% 0.005 250 / 0.8)"
                className="animate-spin"
              />
            ),
          },
        }}
      />

      {/* Show tooltips if any JSX elements has these 2 attributes: data-tooltip-id="tooltip" data-tooltip-content="" */}
      <Tooltip
        id="tooltip"
        className="z-[60] !opacity-100 max-w-sm shadow-lg"
      />

      {/* Set Crisp customer chat support */}
      <CrispChat />
    </>
  );
};

export default ClientLayout;
