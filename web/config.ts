import { ConfigProps } from "./types/config";

const config = {
  // REQUIRED
  appName: "PolyQuantLab",
  // REQUIRED: a short description of your app for SEO tags (can be overwritten)
  appDescription:
    "Polymarket research workbench: sub-second orderbook data, walk-the-book backtests, and an interactive UI for BTC/ETH/SOL Up/Down markets. Built for quants, usable by anyone.",
  // REQUIRED (no https://, not trailing slash at the end, just the naked domain)
  // The Next.js app will live at this domain (Vercel). FastAPI lives at
  // api.polyquantlab.com (Cloudflare → Hetzner VPS).
  domainName: "polyquantlab.com",
  crisp: {
    // Crisp website ID. IF YOU DON'T USE CRISP: just remove this => Then add a support email in this config file (resend.supportEmail) otherwise customer support won't work.
    id: "",
    // Hide Crisp by default, except on route "/". Crisp is toggled with <ButtonSupport/>. If you want to show Crisp on every routes, just remove this below
    onlyShowOnRoutes: ["/"],
  },
  stripe: {
    // 4 paid tiers (Free is implicit — any signed-in user with no active
    // subscription gets the Free limits on the API automatically).
    //
    // priceId is set in your Stripe Dashboard. Create one Price per tier
    // (Subscription, monthly). Use Stripe TEST mode price IDs for dev,
    // LIVE mode for production. `tierKey` must match the keys in
    // /api/tiers.py — the webhook forwards it to the FastAPI server.
    plans: [
      {
        priceId:
          process.env.NODE_ENV === "development"
            ? "price_TEST_PRO"
            : "price_LIVE_PRO",
        tierKey: "pro",
        name: "Pro",
        description: "For solo quants prototyping strategies.",
        price: 19.9,
        features: [
          { name: "BTC, ETH, SOL — all timeframes" },
          { name: "Sub-second orderbook snapshots" },
          { name: "Walk-the-book backtest engine" },
          { name: "10 req/sec · 300 req/min" },
          { name: "2 concurrent backtests" },
          { name: "20 markets per backtest" },
          { name: "Full historical depth (vs PolyBackTest's 31 d cap)" },
        ],
      },
      {
        priceId:
          process.env.NODE_ENV === "development"
            ? "price_TEST_PLUS"
            : "price_LIVE_PLUS",
        isFeatured: true,
        tierKey: "plus",
        name: "Plus",
        description: "For active researchers running parameter sweeps.",
        price: 39.9,
        features: [
          { name: "Everything in Pro" },
          { name: "25 req/sec · 1,000 req/min" },
          { name: "3 concurrent backtests" },
          { name: "50 markets per backtest" },
          { name: "Bybit linear futures markPrice feed" },
          { name: "Binance aggTrade order-flow imbalance" },
        ],
      },
      {
        priceId:
          process.env.NODE_ENV === "development"
            ? "price_TEST_BOOST"
            : "price_LIVE_BOOST",
        tierKey: "boost",
        name: "Boost",
        description: "Shops running many strategies in parallel.",
        price: 47.9,
        features: [
          { name: "Everything in Plus" },
          { name: "30 req/sec · 1,225 req/min" },
          { name: "4 concurrent backtests" },
          { name: "100 markets per backtest" },
          { name: "Priority email support" },
        ],
      },
      {
        priceId:
          process.env.NODE_ENV === "development"
            ? "price_TEST_PREMIUM"
            : "price_LIVE_PREMIUM",
        tierKey: "premium",
        name: "Premium",
        description: "Maximum throughput; for desks evaluating Polymarket alpha.",
        price: 99.9,
        priceAnchor: 199.9,
        features: [
          { name: "Everything in Boost" },
          { name: "50 req/sec · 2,000 req/min" },
          { name: "6 concurrent backtests" },
          { name: "200 markets per backtest" },
          { name: "Priority support · same-day responses" },
        ],
      },
    ],
  },
  aws: {
    // If you use AWS S3/Cloudfront, put values in here
    bucket: "bucket-name",
    bucketUrl: `https://bucket-name.s3.amazonaws.com/`,
    cdn: "https://cdn-id.cloudfront.net/",
  },
  resend: {
    // REQUIRED — Email 'From' field to be used when sending magic login links
    fromNoReply: `PolyQuantLab <noreply@polyquantlab.com>`,
    // REQUIRED — Email 'From' field to be used when sending other emails, like abandoned carts, updates etc..
    fromAdmin: `PolyQuantLab <hello@polyquantlab.com>`,
    // Email shown to customer if need support. Leave empty if not needed => if empty, set up Crisp above, otherwise you won't be able to offer customer support."
    supportEmail: "support@polyquantlab.com",
  },
  colors: {
    // Custom DaisyUI theme defined in app/globals.css (`quant-dark`).
    // Dark by default — matches the "quant tool" aesthetic of
    // Linear / Vercel / Stripe Dashboard. Light variant available as
    // `quant-light` if a page needs it (marketing screenshots, etc.).
    theme: "quant-dark",
    // Emerald accent — drives the browser theme-color (URL bar, tab
    // colour on supported platforms). Matches --color-primary in CSS.
    main: "#1fb874",
  },
  auth: {
    // REQUIRED — the path to log in users. It's use to protect private routes (like /dashboard). It's used in apiClient (/libs/api.js) upon 401 errors from our API
    loginUrl: "/signin",
    // REQUIRED — the path you want to redirect users after successfull login (i.e. /dashboard, /private). This is normally a private page for users to manage their accounts. It's used in apiClient (/libs/api.js) upon 401 errors from our API & in ButtonSignin.js
    callbackUrl: "/dashboard",
  },
} as ConfigProps;

export default config;
