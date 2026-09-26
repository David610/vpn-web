"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { FleetTabs } from "@/components/admin/FleetTabs";
import { TypedConfirmDialog } from "@/components/admin/TypedConfirmDialog";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type Traffic = {
  sampledAt: string | null;
  connectionsOpen: number | null;
  bpsUp: number | null;
  bpsDown: number | null;
  todayBytesUp: number;
  todayBytesDown: number;
};

type Location = { displayName: string; countryCode: string };

type Node = {
  nodeId: string;
  status: string;
  lastSeenAt: string | null;
  telemetryAt: string | null;
  agentVersion: string | null;
  vpnVersion: string | null;
  singboxVersion: string | null;
  uptimeSeconds: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  networkRxBps: number | null;
  networkTxBps: number | null;
  configuredUsers: number | null;
  activeUsersRecent: number | null;
  role: string;
  lifecycleState: string;
  location: Location | null;
  desiredRevision: number;
  observedRevision: number;
  traffic: Traffic;
};

// Kept in sync with functions/lib/node-lifecycle.js by hand rather than
// shared across the JS/TS boundary — deliberately not re-deriving the full
// transition graph client-side (spec §57: no duplicated business logic).
// The backend is the sole authority on which transitions are legal; the
// dropdown here just needs "everything except the current state" and the
// server rejects an illegal choice with 409, surfaced as an inline error.
const LIFECYCLE_STATES = [
  "PROVISIONING",
  "WARMING_UP",
  "READY",
  "CANARY",
  "DEGRADED",
  "DRAINING",
  "MAINTENANCE",
  "FAILED",
  "QUARANTINED",
  "RETIRED",
];

// Transitions that pull a node out of rotation: all require typing the
// node id in a confirm dialog.
const DANGEROUS_TARGETS = new Set(["DRAINING", "MAINTENANCE", "FAILED", "QUARANTINED", "RETIRED"]);

type PendingAction =
  | { kind: "lifecycle"; nodeId: string; state: string }
  | { kind: "replace"; nodeId: string; canary: boolean };

const REFRESH_MS = 10_000;

function formatBits(bps: number | null): string {
  if (bps === null) return "—";
  if (bps < 1000) return `${bps} bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)} kbps`;
  if (bps < 1_000_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${(bps / 1_000_000_000).toFixed(2)} Gbps`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value < 1024 ** 4) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  return `${(value / 1024 ** 4).toFixed(2)} TiB`;
}

function percent(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function uptime(seconds: number | null): string {
  if (seconds == null) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

export default function AdminNodesPage() {
  const { session } = useAdminSession();
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  // A Set, not a single id: a global "pending" value would clear the
  // disabled state on node A's in-flight transition the moment an admin
  // starts a transition on node B, letting A's dropdown be used again
  // while its first request is still outstanding.
  const [pendingNodeIds, setPendingNodeIds] = useState<Set<string>>(new Set());
  const [newNodeId, setNewNodeId] = useState("");
  const [newNodeRole, setNewNodeRole] = useState<"EXIT" | "RELAY">("EXIT");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<{ nodeId: string; token: string; expiresAt: string } | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [replaceNewId, setReplaceNewId] = useState("");
  const [replaceRegion, setReplaceRegion] = useState("fsn1");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const body = await adminFetch<{ nodes: Node[] }>(
        "/api/admin/nodes",
        session.access_token
      );
      setNodes(body.nodes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load nodes.");
    }
  }, [session]);

  const transition = useCallback(
    async (nodeId: string, state: string) => {
      if (!session) return;
      setPendingNodeIds((prev) => new Set(prev).add(nodeId));
      setTransitionError(null);
      try {
        await adminFetch(`/api/admin/nodes/${encodeURIComponent(nodeId)}/lifecycle`, session.access_token, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state }),
        });
        await load();
      } catch (err) {
        setTransitionError(err instanceof Error ? err.message : "Transition failed.");
      } finally {
        setPendingNodeIds((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
      }
    },
    [session, load]
  );

  const requestTransition = useCallback(
    (nodeId: string, state: string) => {
      if (DANGEROUS_TARGETS.has(state)) setPendingAction({ kind: "lifecycle", nodeId, state });
      else transition(nodeId, state);
    },
    [transition]
  );

  const confirmPending = useCallback(async () => {
    if (!pendingAction || !session) return;
    if (pendingAction.kind === "lifecycle") {
      setPendingAction(null);
      await transition(pendingAction.nodeId, pendingAction.state);
      return;
    }
    setActionBusy(true);
    setTransitionError(null);
    try {
      const body = await adminFetch<{ operationId?: string }>(
        `/api/admin/nodes/${encodeURIComponent(pendingAction.nodeId)}/replace`,
        session.access_token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newNodeId: replaceNewId.trim(), region: replaceRegion.trim(), canary: pendingAction.canary }),
        }
      );
      setNotice(
        `${pendingAction.canary ? "Canary replacement" : "Replacement"} of ${pendingAction.nodeId} started` +
          (body.operationId ? ` (operation ${body.operationId.slice(0, 8)}). Track it under Operations.` : ".")
      );
      setPendingAction(null);
      setReplaceNewId("");
      await load();
    } catch (err) {
      setTransitionError(err instanceof Error ? err.message : "Replace failed.");
      setPendingAction(null);
    } finally {
      setActionBusy(false);
    }
  }, [pendingAction, session, transition, replaceNewId, replaceRegion, load]);

  const createPendingNode = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!session || !newNodeId.trim()) return;
      if (enrollment) {
        // The previous node's one-time token only ever exists in this
        // component's state — it is never re-fetchable (the server only
        // stores its hash). Overwriting `enrollment` before the admin has
        // copied it would discard it permanently, leaving that node stuck
        // in PROVISIONING with an orphaned, unrecoverable token.
        setCreateError("Dismiss the current enrollment token before creating another node.");
        return;
      }
      setCreating(true);
      setCreateError(null);
      try {
        const body = await adminFetch<{ nodeId: string; enrollmentToken: string; expiresAt: string }>(
          "/api/admin/nodes",
          session.access_token,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nodeId: newNodeId.trim(), role: newNodeRole }),
          }
        );
        setEnrollment({ nodeId: body.nodeId, token: body.enrollmentToken, expiresAt: body.expiresAt });
        setNewNodeId("");
        await load();
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : "Could not create node.");
      } finally {
        setCreating(false);
      }
    },
    [session, newNodeId, newNodeRole, load, enrollment]
  );

  useEffect(() => {
    if (!session) return;
    const refresh = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [session, load]);

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Fleet</h1>
      <FleetTabs />
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 className="text-base font-semibold">Nodes</h2>
        <span className="text-xs text-gray-500">
          VPN traffic and host health · refresh {REFRESH_MS / 1000}s
        </span>
      </div>

      <form onSubmit={createPendingNode} className="mb-4 flex flex-wrap items-end gap-2 rounded border p-3 text-sm">
        <div>
          <label className="block text-xs text-gray-500">Node id</label>
          <input
            className="rounded border px-2 py-1"
            placeholder="de-fra-3"
            value={newNodeId}
            onChange={(e) => setNewNodeId(e.target.value)}
            disabled={creating}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500">Role</label>
          <select
            className="rounded border px-2 py-1"
            value={newNodeRole}
            onChange={(e) => setNewNodeRole(e.target.value as "EXIT" | "RELAY")}
            disabled={creating}
          >
            <option value="EXIT">EXIT</option>
            <option value="RELAY">RELAY</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={creating || !newNodeId.trim() || !!enrollment}
          className="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50"
        >
          {creating ? "Creating…" : "Enroll node"}
        </button>
        {createError && <span className="text-red-600">{createError}</span>}
      </form>

      {enrollment && (
        <div className="mb-4 rounded border border-yellow-300 bg-yellow-50 p-3 text-sm">
          <p className="font-medium">
            Enrollment token for {enrollment.nodeId} (shown once — copy it now):
          </p>
          <code className="block break-all rounded bg-white p-2 text-xs">{enrollment.token}</code>
          <p className="mt-1 text-xs text-gray-500">
            Expires {new Date(enrollment.expiresAt).toLocaleString()}. Pass it to the new VPS&apos;s
            bootstrap step; it calls POST /api/agent/enroll once and is then useless.
          </p>
          <button className="mt-1 text-xs underline" onClick={() => setEnrollment(null)}>
            Dismiss
          </button>
        </div>
      )}

      {transitionError && <p className="mb-2 text-red-600">{transitionError}</p>}
      {notice && (
        <p className="mb-2 border-l-2 border-black pl-2 text-sm">
          {notice}{" "}
          <button type="button" className="underline" onClick={() => setNotice(null)}>Dismiss</button>
        </p>
      )}

      <TypedConfirmDialog
        open={!!pendingAction}
        busy={actionBusy}
        expected={pendingAction?.nodeId ?? ""}
        title={
          pendingAction?.kind === "lifecycle"
            ? `Move ${pendingAction.nodeId} to ${pendingAction.state}`
            : pendingAction
              ? `${pendingAction.canary ? "Canary-replace" : "Replace"} ${pendingAction.nodeId}`
              : ""
        }
        description={
          pendingAction?.kind === "lifecycle"
            ? pendingAction.state === "RETIRED"
              ? "RETIRED is terminal. The node stops serving and can never return to rotation."
              : "The node stops receiving new device assignments; existing devices are moved by the scheduler."
            : pendingAction?.canary
              ? "Provisions a new node in CANARY (capped sessions, 2h observation). It is promoted and this node drained/retired only if the canary stays healthy; otherwise the canary is aborted."
              : "Provisions a new node in the same location and role, then drains and retires this one once the new node is READY."
        }
        actionLabel={pendingAction?.kind === "lifecycle" ? `Move to ${pendingAction.state}` : "Start replacement"}
        onCancel={() => setPendingAction(null)}
        onConfirm={confirmPending}
      >
        {pendingAction?.kind === "replace" && (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <label className="text-xs text-gray-600">
              New node id
              <input className="mt-1 w-full border border-gray-400 px-2 py-1 font-mono" value={replaceNewId} onChange={(e) => setReplaceNewId(e.target.value)} placeholder="de-fra-4" />
            </label>
            <label className="text-xs text-gray-600">
              Provider region
              <input className="mt-1 w-full border border-gray-400 px-2 py-1 font-mono" value={replaceRegion} onChange={(e) => setReplaceRegion(e.target.value)} />
            </label>
          </div>
        )}
      </TypedConfirmDialog>

      {error ? (
        <p className="text-red-600">{error}</p>
      ) : !nodes ? (
        <p>Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left text-sm [&_td]:px-3 [&_td]:py-3 [&_th]:px-3 [&_th]:py-2 [&_th]:font-medium">
            <thead>
              <tr className="border-b border-gray-300 text-xs uppercase tracking-wide text-gray-500">
                <th className="min-w-[180px]">Node</th>
                <th className="min-w-[170px]">State</th>
                <th className="min-w-[150px] text-right">VPN traffic</th>
                <th className="min-w-[170px]">Host</th>
                <th className="min-w-[110px] text-right">Users</th>
                <th className="min-w-[160px]">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.nodeId} className="border-b border-gray-200 align-top">
                  <td>
                    <div className="font-mono font-medium">{node.nodeId}</div>
                    <div className="mt-0.5 text-xs text-gray-500">
                      {node.role} · {node.location ? `${node.location.displayName} (${node.location.countryCode})` : "unassigned"}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      rev {node.observedRevision}/{node.desiredRevision}
                      {node.observedRevision !== node.desiredRevision && <span className="ml-1 font-semibold text-gray-900">out of sync</span>}
                    </div>
                    <div className="mt-1 break-all font-mono text-[11px] leading-4 text-gray-500">
                      agent {node.agentVersion ?? "—"} · vpn {node.vpnVersion ?? "—"} · sing-box {node.singboxVersion ?? "—"}
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge status={node.status} />
                      <StatusBadge status={node.lifecycleState} />
                    </div>
                    <select
                      aria-label={`Lifecycle transition for ${node.nodeId}`}
                      className="mt-2 block rounded border border-gray-400 text-xs disabled:opacity-50"
                      value=""
                      disabled={pendingNodeIds.has(node.nodeId)}
                      onChange={(e) => {
                        const target = e.target.value;
                        e.target.value = "";
                        if (target) requestTransition(node.nodeId, target);
                      }}
                    >
                      <option value="">Transition…</option>
                      {LIFECYCLE_STATES.filter((s) => s !== node.lifecycleState).map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    {["READY", "DEGRADED", "FAILED"].includes(node.lifecycleState) && (
                      <div className="mt-1 flex gap-3 text-xs">
                        <button type="button" className="min-h-6 py-1 underline" onClick={() => setPendingAction({ kind: "replace", nodeId: node.nodeId, canary: false })}>
                          Replace
                        </button>
                        <button type="button" className="min-h-6 py-1 underline" onClick={() => setPendingAction({ kind: "replace", nodeId: node.nodeId, canary: true })}>
                          Canary
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    <div>↓ {formatBits(node.traffic.bpsDown)}</div>
                    <div>↑ {formatBits(node.traffic.bpsUp)}</div>
                    <div className="mt-1 text-xs text-gray-500">{node.traffic.connectionsOpen ?? "—"} conns</div>
                    <div className="text-xs text-gray-500">{formatBytes(node.traffic.todayBytesDown + node.traffic.todayBytesUp)} today</div>
                  </td>
                  <td className="tabular-nums">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                      <dt className="text-gray-500">CPU</dt><dd>{percent(node.cpuPercent)}</dd>
                      <dt className="text-gray-500">RAM</dt><dd>{percent(node.memoryPercent)}</dd>
                      <dt className="text-gray-500">Disk</dt><dd>{percent(node.diskPercent)}</dd>
                      <dt className="text-gray-500">Net</dt>
                      <dd>↓ {formatBits(node.networkRxBps)} · ↑ {formatBits(node.networkTxBps)}</dd>
                    </dl>
                  </td>
                  <td className="text-right tabular-nums">
                    <div>{node.configuredUsers ?? "—"}</div>
                    {node.activeUsersRecent != null && <div className="text-xs text-gray-500">{node.activeUsersRecent} recent</div>}
                  </td>
                  <td className="text-xs">
                    <div>{node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "never"}</div>
                    <div className="mt-1 text-gray-500">up {uptime(node.uptimeSeconds)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nodes && nodes.every((node) => node.traffic.sampledAt === null) && (
        <p className="mt-4 text-xs text-gray-500">
          No VPN traffic samples yet. Traffic reporting requires sing-box&apos;s
          Clash API and is per node; the official sing-box build does not expose
          reliable per-user counters.
        </p>
      )}
    </AdminShell>
  );
}
