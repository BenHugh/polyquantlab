"use client";

import { useState } from "react";
import apiClient from "@/libs/api";

// Stripe Checkout launcher.
//
// We default `mode` to "subscription" because our 4 paid plans
// (Pro/Plus/Boost/Premium in config.ts) are all monthly recurring. The
// success URL routes the user into the dashboard so they can immediately
// mint an API key — without this, Stripe's default success page leaves
// them stranded after paying.
//
// `label` is optional — callers (e.g. <Pricing />) typically pass the
// plan name so each card has its own CTA copy.
const ButtonCheckout = ({
  priceId,
  mode = "subscription",
  label,
}: {
  priceId: string;
  mode?: "payment" | "subscription";
  label?: string;
}) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const handlePayment = async () => {
    setIsLoading(true);

    try {
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const { url }: { url: string } = await apiClient.post(
        "/stripe/create-checkout",
        {
          priceId,
          // After successful payment, drop the user straight into the
          // API-keys page — the Stripe webhook will already have synced
          // their tier into FastAPI by the time this page loads.
          successUrl: `${origin}/dashboard/api-keys?upgraded=1`,
          cancelUrl: `${origin}/#pricing`,
          mode,
        }
      );

      window.location.href = url;
    } catch (e) {
      console.error(e);
    }

    setIsLoading(false);
  };

  return (
    <button
      className="btn btn-primary btn-block group"
      onClick={() => handlePayment()}
      disabled={isLoading}
    >
      {isLoading ? (
        <span className="loading loading-spinner loading-xs"></span>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="w-5 h-5 group-hover:scale-110 transition-transform duration-200"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
            clipRule="evenodd"
          />
        </svg>
      )}
      {label ? `Subscribe to ${label}` : "Subscribe"}
    </button>
  );
};

export default ButtonCheckout;
