const COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  online: "bg-green-100 text-green-800",
  done: "bg-green-100 text-green-800",
  past_due: "bg-yellow-100 text-yellow-800",
  degraded: "bg-yellow-100 text-yellow-800",
  pending: "bg-yellow-100 text-yellow-800",
  claimed: "bg-blue-100 text-blue-800",
  canceled: "bg-gray-100 text-gray-600",
  offline: "bg-red-100 text-red-800",
  failed: "bg-red-100 text-red-800",
  revoked: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: string }) {
  const color = COLORS[status] ?? "bg-gray-100 text-gray-600";
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>{status}</span>;
}
