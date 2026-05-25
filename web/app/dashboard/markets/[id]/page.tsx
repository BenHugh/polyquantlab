import MarketDetail, {
  type MarketMeta,
  type OrderbookSnapshot,
  type TimeseriesPayload,
} from "@/components/MarketDetail";
import PageHeader from "@/components/PageHeader";
import { fastapiGet } from "@/libs/fastapi";

export const dynamic = "force-dynamic";

/**
 * /dashboard/markets/[id] — single market detail. Server-renders
 * metadata + orderbook + timeseries in parallel; falls back gracefully
 * if any of the three fail.
 */
export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);

  const [metaR, bookR, tsR] = await Promise.allSettled([
    fastapiGet<MarketMeta>(`/v1/markets/${encodeURIComponent(id)}`),
    fastapiGet<OrderbookSnapshot>(
      `/v1/markets/${encodeURIComponent(id)}/orderbook`
    ),
    fastapiGet<TimeseriesPayload>(
      `/v1/markets/${encodeURIComponent(id)}/timeseries?limit=500`
    ),
  ]);

  const meta = metaR.status === "fulfilled" ? metaR.value : null;
  const book = bookR.status === "fulfilled" ? bookR.value : null;
  const series = tsR.status === "fulfilled" ? tsR.value : null;

  if (!meta) {
    return (
      <div className="max-w-3xl mx-auto">
        <PageHeader eyebrow="Market" title="Not found" />
        <div className="alert alert-error">
          <span>
            Market <code className="font-mono">{id}</code> not found, or upstream API unavailable.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        eyebrow="Market"
        title={meta.slug || "Untitled market"}
        subtitle={<span className="font-mono text-xs">{meta.market_id}</span>}
      />
      <MarketDetail meta={meta} book={book} series={series} />
    </div>
  );
}
