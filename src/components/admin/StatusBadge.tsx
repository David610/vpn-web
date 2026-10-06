// A coloured dot plus the state's own text: the colour is a hint, never the
// only carrier of meaning.
type Tone = "ok" | "warn" | "bad" | "off";

const TONES: Record<string, Tone> = {
  active: "ok",
  online: "ok",
  done: "ok",
  past_due: "warn",
  degraded: "warn",
  pending: "warn",
  claimed: "warn",
  canceled: "off",
  offline: "bad",
  failed: "bad",
  revoked: "bad",

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

export function StatusBadge({ status }: { status: string }) {
  const tone = TONES[status] ?? "off";
  return <span className={`status status--${tone}`}>{status}</span>;
}
