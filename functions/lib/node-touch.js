// Optional per-process throttle for nodes.last_seen_at writes on the hot
// /api/agent/claim path. The heartbeat endpoint refreshes last_seen_at on its
// own schedule, so writing it on every poll is redundant. Disabled unless the
// long-lived Node API server configures it; Pages Functions are unchanged.
let throttle = null;

export function configureNodeTouchThrottle(intervalMs, now = Date.now) {
  throttle = intervalMs ? { intervalMs, now, last: new Map() } : null;
}

export function shouldTouchNode(nodeId) {
  if (!throttle) return true;
  const t = throttle.now();
  const previous = throttle.last.get(nodeId);
  if (previous !== undefined && t - previous < throttle.intervalMs) return false;
  throttle.last.set(nodeId, t);
  return true;
}
