"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
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
  "DEGRADED",
  "DRAINING",
  "MAINTENANCE",
  "FAILED",
  "QUARANTINED",
  "RETIRED",
];

const DANGEROUS_TARGETS = new Set(["QUARANTINED", "RETIRED"]);

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
      if (
        DANGEROUS_TARGETS.has(state) &&
        !window.confirm(`Move ${nodeId} to ${state}? This stops it from receiving new assignments.`)
      ) {
        return;
      }
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

  const createPendingNode = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!session || !newNodeId.trim()) return;
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
    [session, newNodeId, newNodeRole, load]
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
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Nodes</h1>
        <span className="text-xs text-gray-500">
          VPN traffic and host health · refresh {REFRESH_MS / 1000}s
        </span>
      </div>

      <form onSubmit={createPendingNode} className="mb-4 flex items-end gap-2 rounded border p-3 text-sm">
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
          disabled={creating || !newNodeId.trim()}
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

      {error ? (
        <p className="text-red-600">{error}</p>
      ) : !nodes ? (
        <p>Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-gray-500">
                <th className="py-2">Node</th>
                <th>Status</th>
                <th>Lifecycle</th>
                <th>Location / Role</th>
                <th>Revision</th>
                <th className="text-right">VPN ↓ / ↑</th>
                <th className="text-right">Conns</th>
                <th className="text-right">Today</th>
                <th>CPU / RAM / Disk</th>
                <th>Host ↓ / ↑</th>
                <th>Users</th>
                <th>Uptime</th>
                <th>Versions</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.nodeId} className="border-b align-top">
                  <td className="py-2 font-medium">{node.nodeId}</td>
                  <td><StatusBadge status={node.status} /></td>
                  <td>
                    <StatusBadge status={node.lifecycleState} />
                    <select
                      className="mt-1 block rounded border text-xs disabled:opacity-50"
                      value=""
                      disabled={pendingNodeIds.has(node.nodeId)}
                      onChange={(e) => {
                        const target = e.target.value;
                        e.target.value = "";
                        if (target) transition(node.nodeId, target);
                      }}
                    >
                      <option value="">Transition…</option>
                      {LIFECYCLE_STATES.filter((s) => s !== node.lifecycleState).map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="text-xs text-gray-500">
                    {node.location ? `${node.location.displayName} (${node.location.countryCode})` : "unassigned"}
                    <br />
                    {node.role}
                  </td>
                  <td className="text-xs tabular-nums text-gray-500">
                    {node.observedRevision}/{node.desiredRevision}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatBits(node.traffic.bpsDown)} / {formatBits(node.traffic.bpsUp)}
                  </td>
                  <td className="text-right tabular-nums">
                    {node.traffic.connectionsOpen ?? "—"}
                  </td>
                  <td className="text-right tabular-nums text-gray-600">
                    {formatBytes(node.traffic.todayBytesDown + node.traffic.todayBytesUp)}
                  </td>
                  <td>
                    {percent(node.cpuPercent)} / {percent(node.memoryPercent)} / {percent(node.diskPercent)}
                  </td>
                  <td>
                    {formatBits(node.networkRxBps)}
                    {" / "}
                    {formatBits(node.networkTxBps)}
                  </td>
                  <td>
                    {node.configuredUsers ?? "—"}
                    {node.activeUsersRecent != null ? ` / ${node.activeUsersRecent} recent` : ""}
                  </td>
                  <td>{uptime(node.uptimeSeconds)}</td>
                  <td className="text-xs text-gray-500">
                    agent {node.agentVersion ?? "—"}<br />
                    vpn {node.vpnVersion ?? "—"}<br />
                    sing-box {node.singboxVersion ?? "—"}
                  </td>
                  <td className="text-gray-500">
                    {node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "never"}
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
