import MarketsTable, { type ResolvedMarket } from "@/components/MarketsTable";
import PageHeader from "@/components/PageHeader";
import { fastapiGet } from "@/libs/fastapi";

export const dynamic = "force-dynamic";

interface ResolvedMarketsResponse {
  markets: ResolvedMarket[];
  count: number;
}

export default async function MarketsPage() {
  let markets: ResolvedMarket[] = [];
  let fetchError: string | null = null;
  try {
    const data = await fastapiGet<ResolvedMarketsResponse>(
      "/v1/markets/resolved?limit=500&with_underlying=true"
    );
    markets = data.markets ?? [];
  } catch (e: any) {
    fetchError = e?.message || "Failed to load markets";
    console.error("[markets page]", e);
  }

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Markets"
        subtitle="Resolved Polymarket crypto Up/Down markets. Click any row to inspect the orderbook + price history."
      />
      {fetchError ? (
        <div className="alert alert-error">
          <span>{fetchError}</span>
        </div>
      ) : (
        <MarketsTable initial={markets} />
      )}
    </div>
  );
}
