import PageHeader from "@/components/PageHeader";
import ArbVerification from "@/components/ArbVerification";

export const dynamic = "force-dynamic";

export default function ArbVerificationPage() {
  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        prefix="/ AUDIT"
        title="Calibration Report"
        subtitle="Every opportunity the engine surfaced — model EV at detection vs realised PnL after market resolution. No marketing transformation. The number is the number."
      />
      <ArbVerification />
    </div>
  );
}
