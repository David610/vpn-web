export function MetricCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border bg-white p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-gray-500">{label}</div>
    </div>
  );
}
