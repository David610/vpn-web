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

  // Fleet node lifecycle states (spec §7) — distinct key space from the
  // heartbeat-derived connectivity statuses above, uppercase to match the
  // DB's lifecycle_state values verbatim (no case conversion needed).
  READY: "bg-green-100 text-green-800",
  WARMING_UP: "bg-blue-100 text-blue-800",
  PROVISIONING: "bg-blue-100 text-blue-800",
  DEGRADED: "bg-yellow-100 text-yellow-800",
  DRAINING: "bg-yellow-100 text-yellow-800",
  MAINTENANCE: "bg-gray-100 text-gray-600",
  FAILED: "bg-red-100 text-red-800",
  QUARANTINED: "bg-red-100 text-red-800",
  RETIRED: "bg-gray-100 text-gray-600",
};

export function StatusBadge({ status }: { status: string }) {
  const color = COLORS[status] ?? "bg-gray-100 text-gray-600";
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>{status}</span>;
}
