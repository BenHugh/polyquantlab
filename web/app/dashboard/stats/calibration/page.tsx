import CalibrationView from "@/components/CalibrationView";
import PageHeader from "@/components/PageHeader";

export const dynamic = "force-dynamic";

export default function CalibrationPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        eyebrow="Analytics"
        title="Market calibration"
        subtitle="For each bucket of implied probability T minutes before resolution, how often did Polymarket markets actually resolve Up? Markets on the y=x line are well-calibrated; deviations are systematic mispricings — exploitable edge."
      />
      <CalibrationView />
    </div>
  );
}
