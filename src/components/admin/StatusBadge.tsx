// Monochrome by design (black/white/gray visual language): state is carried
// by weight, outline and fill, never hue. Only the "needs attention now"
// states get the single dark treatment.
const SOLID_DARK = "bg-gray-900 text-white font-semibold";
const FILLED = "bg-gray-900/5 text-gray-900 ring-1 ring-inset ring-gray-900 font-semibold";
const OUTLINE = "bg-white text-gray-800 ring-1 ring-inset ring-gray-400";
const DASHED = "bg-white text-gray-700 outline-dashed outline-1 -outline-offset-1 outline-gray-500";
const MUTED = "bg-gray-100 text-gray-500";

const STYLES: Record<string, string> = {
  active: FILLED,
  online: FILLED,
  done: FILLED,
  past_due: DASHED,
  degraded: DASHED,
  pending: DASHED,
  claimed: OUTLINE,
  canceled: MUTED,
  offline: SOLID_DARK,
  failed: SOLID_DARK,
  revoked: SOLID_DARK,

  // Fleet node lifecycle states (spec §7), uppercase as in lifecycle_state.
  READY: FILLED,
  CANARY: OUTLINE,
  WARMING_UP: OUTLINE,
  PROVISIONING: OUTLINE,
  DEGRADED: DASHED,
  DRAINING: DASHED,
  MAINTENANCE: MUTED,
  FAILED: SOLID_DARK,
  QUARANTINED: SOLID_DARK,
  RETIRED: MUTED,
};

export function StatusBadge({ status }: { status: string }) {
  const style = STYLES[status] ?? MUTED;
  return <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${style}`}>{status}</span>;
}
