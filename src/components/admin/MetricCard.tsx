import { AdminMetric } from "./AdminPrimitives";

/** @deprecated Use AdminMetric from "./AdminPrimitives" directly; kept as a thin alias for existing call sites. */
export function MetricCard({ label, value }: { label: string; value: number | string }) {
  return <AdminMetric label={label} value={value} />;
}
