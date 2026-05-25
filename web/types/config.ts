// Project-local theme names. We define `quant-dark` + `quant-light`
// as custom DaisyUI themes in app/globals.css; the built-in DaisyUI
// variants below are kept here for legacy reference but unused.
export type Theme =
  | "quant-dark"
  | "quant-light"
  | "light"
  | "dark"
  | "";

export interface ConfigProps {
  appName: string;
  appDescription: string;
  domainName: string;
  crisp: {
    id?: string;
    onlyShowOnRoutes?: string[];
  };
  stripe: {
    plans: {
      isFeatured?: boolean;
      priceId: string;
      // Internal tier identifier — matches the keys in api/tiers.py.
      // The Stripe webhook reads this off the matched plan and forwards
      // it to our FastAPI's /v1/internal/sync-subscription so the API
      // server applies the right rate limits.
      tierKey: "pro" | "plus" | "boost" | "premium";
      name: string;
      description?: string;
      price: number;
      priceAnchor?: number;
      features: {
        name: string;
      }[];
    }[];
  };
  aws?: {
    bucket?: string;
    bucketUrl?: string;
    cdn?: string;
  };
  resend: {
    fromNoReply: string;
    fromAdmin: string;
    supportEmail?: string;
  };
  colors: {
    theme: Theme;
    main: string;
  };
  auth: {
    loginUrl: string;
    callbackUrl: string;
  };
}
