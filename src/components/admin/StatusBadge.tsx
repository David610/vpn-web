// A coloured pill plus the state's own text: the colour is a hint, never the
// only carrier of meaning.
type Tone = "ok" | "warn" | "bad" | "off";

const TONES: Record<string, Tone> = {
  active: "ok",
  online: "ok",
  done: "ok",
  trialing: "ok",
  past_due: "warn",
  degraded: "warn",
  pending: "warn",
  claimed: "warn",
  cancelling: "warn",
  canceled: "off",
  offline: "bad",
  failed: "bad",
  revoked: "off",
  unpaid: "bad",

  // Fleet node lifecycle states (spec §7), uppercase as in lifecycle_state.
  READY: "ok",
  CANARY: "warn",
  WARMING_UP: "warn",
  PROVISIONING: "warn",
  DEGRADED: "warn",
  DRAINING: "warn",
  MAINTENANCE: "off",
  FAILED: "bad",
  QUARANTINED: "bad",
  RETIRED: "off",
};

/** "past_due" → "Past due", "WARMING_UP" → "Warming up". */
function label(status: string) {
  const text = status.replace(/_/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function StatusBadge({ status }: { status: string }) {
  const tone = TONES[status] ?? "off";
  return <span className={`badge badge--${tone}`}>{label(status)}</span>;
}
