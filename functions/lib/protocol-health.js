/**
 * Phase 4 protocol-level fleet health: pure validation and decision logic
 * for the `protocol_probe` report an agent attaches to its heartbeat (see
 * singbox-vpn apps/provisioning-agent/src/protocol_probe.rs). No I/O; the
 * persistence lives in protocol-health-store.js.
 *
 * What is measured, and where: every handshake/egress dimension is taken on
 * a NODE by a real local sing-box client -- against a peer's public
 * endpoint ("peer" vantage) or its own endpoint over loopback ("self"
 * vantage, a fallback). The Worker never fabricates a UDP or handshake
 * result.
 *
 * What feeds lifecycle decisions (deliberately minimal):
 *   - per report, a target's `ok` = every reported protocol (REALITY,
 *     Hysteria2) achieved useful egress (handshake + IPv4 HTTPS);
 *   - peer results win; self results only count while no peer has
 *     reported on the target within PEER_FRESH_MS (a loopback probe cannot
 *     see a firewall that drops outside traffic);
 *   - the ok/fail streak goes through the SAME hysteresis as the Clash
 *     probe (evaluateProbeResult: 3 fails -> DEGRADED, 5 passes -> READY),
 *     on separate protocol_probe_* counters so one signal cannot reset the
 *     other's streak;
 *   - protocol evidence NEVER moves a node out of FAILED (peer evidence
 *     says nothing about the agent; FAILED recovery stays with the node's
 *     own heartbeat and its failed_reason rules) and never INTO FAILED
 *     (FAILED remains silence-only).
 * DNS, IPv6, egress-IP match, latency, loss and cert days are stored and
 * shown but do not drive transitions. IP reputation is a separate nodes
 * column that nothing here reads.
 */
import { evaluateProbeResult, HEARTBEAT_INTERVAL_MS } from "./node-health-transition.js";

// Only nodes in these states probe or get probed (and receive peer probe
// credentials). QUARANTINED/RETIRED nodes may be compromised.
export const PROBING_STATES = ["WARMING_UP", "READY", "DEGRADED"];
export const PROTOCOLS = ["reality", "hysteria2"];
export const VANTAGES = ["peer", "self"];
export const PEER_FRESH_MS = HEARTBEAT_INTERVAL_MS * 3;
export const MAX_RESULTS_PER_REPORT = 32;
export const PROBE_PEER_FANOUT = 3;
export const RETENTION_HOURS = 24;
export const MAX_ROWS_PER_TARGET = 5000;

const IPV6_STATES = new Set(["egress", "blocked", "unknown"]);
const ERROR_CLASSES = new Set([
  "tcp_unreachable",
  "client_start_failed",
  "client_not_ready",
  "client_build_failed",
  "handshake_failed",
  "no_ipv4_egress",
]);
const NODE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const IP_RE = /^[0-9a-f:.]{2,45}$/i;

const bool = (v) => (typeof v === "boolean" ? v : null);
const nonNegInt = (v, max) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null);
const ip = (v) => (typeof v === "string" && IP_RE.test(v) ? v : null);

/** Validates an untrusted agent report. Returns null when unusable. */
export function sanitizeProtocolReport(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.results)) return null;
  const certDays = Number.isSafeInteger(raw.hysteria2_cert_days_remaining)
    ? Math.max(-3650, Math.min(3650, raw.hysteria2_cert_days_remaining))
    : null;
  // An agent running with tls_insecure_for_tests skips Hysteria2
  // certificate verification; its Hysteria2 verdicts prove nothing about
  // what real clients see, so they are dropped (and the setting is
  // surfaced loudly rather than silently trusted).
  const tlsInsecure = raw.tls_insecure_for_tests === true;
  const results = [];
  for (const r of raw.results.slice(0, MAX_RESULTS_PER_REPORT)) {
    if (!r || typeof r !== "object") continue;
    if (tlsInsecure && r.protocol === "hysteria2") continue;
    if (typeof r.target_node_id !== "string" || !NODE_ID_RE.test(r.target_node_id)) continue;
    if (!VANTAGES.includes(r.vantage) || !PROTOCOLS.includes(r.protocol)) continue;
    if (typeof r.ok !== "boolean") continue;
    const d = r.dims && typeof r.dims === "object" ? r.dims : {};
    results.push({
      targetNodeId: r.target_node_id,
      vantage: r.vantage,
      protocol: r.protocol,
      ok: r.ok,
      dims: {
        tcp_connect: bool(d.tcp_connect),
        handshake: bool(d.handshake),
        https_ipv4: bool(d.https_ipv4),
        dns: bool(d.dns),
        ipv6: IPV6_STATES.has(d.ipv6) ? d.ipv6 : "unknown",
        egress_ipv4: ip(d.egress_ipv4),
        egress_ipv6: ip(d.egress_ipv6),
        egress_ip_match: bool(d.egress_ip_match),
      },
      latencyMs: nonNegInt(r.latency_ms, 600_000),
      lossPct: nonNegInt(r.loss_pct, 100),
      failureStreak: nonNegInt(r.failure_streak, 1_000_000),
      error: ERROR_CLASSES.has(r.error) ? r.error : null,
    });
  }
  return { certDays, results, tlsInsecure };
}

/**
 * One row per (result, dimension) for node_probe_results. `ok` is the
 * boolean verdict where the dimension has one; value_text/value_num carry
 * the observation (egress IP, ipv6 state, latency, loss).
 */
export function probeResultRows(reporterNodeId, report, observedAt) {
  const rows = [];
  for (const r of report.results) {
    const base = {
      reporter_node_id: reporterNodeId,
      target_node_id: r.targetNodeId,
      vantage: r.vantage,
      protocol: r.protocol,
      observed_at: observedAt,
    };
    const push = (dimension, ok, valueNum = null, valueText = null) =>
      rows.push({ ...base, dimension, ok, value_num: valueNum, value_text: valueText });
    push("useful_egress", r.ok, r.failureStreak, r.error);
    if (r.dims.tcp_connect !== null) push("tcp_connect", r.dims.tcp_connect);
    push("handshake", r.dims.handshake);
    push("https_ipv4", r.dims.https_ipv4);
    push("dns", r.dims.dns);
    push("ipv6", r.dims.ipv6 === "unknown" ? null : r.dims.ipv6 === "egress", null, r.dims.ipv6);
    push("egress_ip", r.dims.egress_ip_match, null, r.dims.egress_ipv4);
    push("latency", r.latencyMs !== null, r.latencyMs, null);
    push("loss", r.lossPct === 0, r.lossPct, null);
  }
  return rows;
}

/**
 * Chooses which of a report's results about one target count, and folds
 * them into one verdict. Returns null when nothing should count (e.g. only
 * self results while a fresh peer view exists).
 */
export function targetVerdict(results, { lastPeerProbeAt, nowMs }) {
  const peer = results.filter((r) => r.vantage === "peer");
  let chosen = peer;
  if (chosen.length === 0) {
    const lastPeerMs = lastPeerProbeAt ? new Date(lastPeerProbeAt).getTime() : NaN;
    const peerFresh = Number.isFinite(lastPeerMs) && nowMs - lastPeerMs <= PEER_FRESH_MS;
    if (peerFresh) return null;
    chosen = results.filter((r) => r.vantage === "self");
  }
  if (chosen.length === 0) return null;
  const protocols = {};
  for (const r of chosen) {
    // Any failing observation of a protocol in this report fails it.
    protocols[r.protocol] = (protocols[r.protocol] ?? true) && r.ok;
  }
  return {
    vantage: chosen[0].vantage,
    ok: Object.values(protocols).every(Boolean),
    protocols,
  };
}

/**
 * Streak + transition decision for protocol evidence about a target. Same
 * thresholds as the Clash probe; never leaves or enters FAILED.
 */
export function evaluateProtocolHealth({ ok, currentFailures, currentSuccesses, lifecycleState, failedReason, clashFailures }) {
  if (lifecycleState === "FAILED") {
    return { failures: ok ? 0 : currentFailures + 1, successes: ok ? currentSuccesses + 1 : 0, nextState: null };
  }
  const r = evaluateProbeResult({ probeOk: ok, currentFailures, currentSuccesses, lifecycleState, failedReason });
  // DEGRADED -> READY needs BOTH signals healthy: protocol recovery must
  // not paper over a still-failing Clash data-plane probe.
  if (r.nextState === "READY" && (clashFailures ?? 0) > 0) return { ...r, nextState: null };
  return r;
}

/**
 * Gate for the node's own Clash-probe-driven DEGRADED -> READY: blocked
 * while protocol evidence is currently failing.
 */
export function protocolAllowsRecovery(node) {
  return (node?.protocol_probe_failures ?? 0) === 0;
}

/** Latest per-protocol summary stored on nodes.protocol_health. */
export function summarizeForTarget(existing, results, verdictVantage, reporterNodeId, observedAt) {
  const summary = existing && typeof existing === "object" ? { ...existing } : {};
  for (const r of results) {
    if (r.vantage !== verdictVantage) continue;
    summary[r.protocol] = {
      ok: r.ok,
      vantage: r.vantage,
      reporter: reporterNodeId,
      at: observedAt,
      latencyMs: r.latencyMs,
      lossPct: r.lossPct,
      error: r.error,
      dims: r.dims,
    };
  }
  return summary;
}

/** Deterministic rotating peer choice so probing stays O(n * fanout). */
export function choosePeers(reporterId, peers, nowMs, fanout = PROBE_PEER_FANOUT) {
  const bucket = Math.floor(nowMs / 3_600_000);
  const score = (id) => {
    let h = 2166136261;
    for (const c of `${reporterId}|${id}|${bucket}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return h;
  };
  return [...peers].sort((a, b) => score(a.node_id) - score(b.node_id)).slice(0, fanout);
}

const URI_MAX = 2048;
export function validProbeUri(value, scheme) {
  return typeof value === "string" && value.length <= URI_MAX && value.startsWith(`${scheme}://`) && !/\s/.test(value);
}
