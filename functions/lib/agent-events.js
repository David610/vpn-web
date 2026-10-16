// Long-poll wake-up hub for provisioning agents. Lives in the long-running
// Node API server only (Pages Functions cannot hold a connection cheaply).
//
// Agents hold ONE request open per node (GET /api/agent/events). One shared
// watcher loop asks the database for secret-free change fingerprints of the
// nodes that are currently waiting -- a constant number of queries per tick,
// however many agents are connected -- and releases a waiter as soon as one of
// its fingerprints moves. Fingerprints are only a hint to go and fetch the
// authoritative state; agents still reconcile on a timer, so a lost wake-up
// costs latency, never correctness.

const CHANNELS = { jobs: "jobs", auth: "authorizations", ent: "authorizations", lease: "leases" };
const ALL_CHANNELS = ["authorizations", "jobs", "leases"];
const MAX_BACKOFF_MS = 10_000;

function encodeCursor(t) {
  return Buffer.from(JSON.stringify([t.jobs, t.auth, t.lease, t.ent])).toString("base64url");
}

function decodeCursor(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 512) return null;
  try {
    const [jobs, auth, lease, ent] = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (typeof jobs !== "string" || typeof lease !== "string" || typeof ent !== "string") return null;
    if (!Number.isSafeInteger(auth)) return null;
    return { jobs, auth, lease, ent };
  } catch {
    return null;
  }
}

function diff(from, to) {
  const changed = new Set();
  for (const key of Object.keys(CHANNELS)) if (from[key] !== to[key]) changed.add(CHANNELS[key]);
  return [...changed].sort();
}

export function createEventHub({
  fetchWakeTokens,
  fetchEntitlementTokens,
  intervalMs = 1_000,
  entitlementIntervalMs = 5_000,
  now = () => Date.now(),
  random = Math.random,
}) {
  const waiters = new Map(); // nodeId -> { cursorText, cursor, resolve, timer, cleanup }
  const current = new Map(); // nodeId -> tokens
  let timer = null;
  let failures = 0;
  let lastEntitlementAt = -Infinity;

  async function refresh(nodeIds, { withEntitlement }) {
    const wake = await fetchWakeTokens(nodeIds);
    const ent = withEntitlement ? await fetchEntitlementTokens(nodeIds) : null;
    for (const id of nodeIds) {
      const w = wake.get(id);
      if (!w) continue;
      const previous = current.get(id);
      current.set(id, { ...w, ent: ent ? (ent.get(id) ?? "") : (previous?.ent ?? "") });
    }
    if (withEntitlement) lastEntitlementAt = now();
  }

  function settle(nodeId, result) {
    const waiter = waiters.get(nodeId);
    if (!waiter) return;
    waiters.delete(nodeId);
    waiter.cleanup();
    waiter.resolve(result);
  }

  function evaluate() {
    for (const [nodeId, waiter] of [...waiters]) {
      const tokens = current.get(nodeId);
      if (!tokens) continue;
      const changed = diff(waiter.cursor, tokens);
      if (changed.length > 0) settle(nodeId, { reason: "change", changed, cursor: encodeCursor(tokens) });
    }
  }

  function schedule(delay) {
    if (timer || waiters.size === 0) return;
    timer = setTimeout(tick, delay);
    timer.unref?.();
  }

  async function tick() {
    timer = null;
    if (waiters.size === 0) return;
    try {
      const ids = [...waiters.keys()];
      await refresh(ids, { withEntitlement: now() - lastEntitlementAt >= entitlementIntervalMs });
      failures = 0;
      evaluate();
      schedule(intervalMs);
    } catch {
      failures += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures);
      schedule(Math.round(backoff * (0.5 + random() * 0.5)));
    }
  }

  async function wait(nodeId, cursorText, { timeoutMs, signal } = {}) {
    const known = decodeCursor(cursorText);
    const stale = waiters.get(nodeId);
    if (stale) settle(nodeId, { reason: "superseded", changed: [], cursor: stale.cursorText ?? "" });
    if (signal?.aborted) return { reason: "aborted", changed: [], cursor: cursorText ?? "" };

    if (!current.has(nodeId) || !known) await refresh([nodeId], { withEntitlement: true });
    const tokens = current.get(nodeId);
    if (!tokens) throw new Error("node not found");
    if (!known) return { reason: "resync", changed: [...ALL_CHANNELS], cursor: encodeCursor(tokens) };
    const changedNow = diff(known, tokens);
    if (changedNow.length > 0) return { reason: "change", changed: changedNow, cursor: encodeCursor(tokens) };

    return new Promise((resolve) => {
      const onAbort = () => settle(nodeId, { reason: "aborted", changed: [], cursor: cursorText });
      const expiry = setTimeout(() => settle(nodeId, { reason: "timeout", changed: [], cursor: cursorText }), timeoutMs ?? 25_000);
      expiry.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.set(nodeId, {
        cursorText,
        cursor: known,
        resolve,
        cleanup: () => { clearTimeout(expiry); signal?.removeEventListener("abort", onAbort); },
      });
      schedule(intervalMs);
    });
  }

  return {
    wait,
    waiterCount: () => waiters.size,
    close() {
      clearTimeout(timer); timer = null;
      for (const nodeId of [...waiters.keys()]) settle(nodeId, { reason: "closed", changed: [], cursor: "" });
    },
  };
}
