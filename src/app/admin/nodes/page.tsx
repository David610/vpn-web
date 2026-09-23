"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

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
};

function pct(v: number | null) {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}
function mbps(v: number | null) {
  return v == null ? "—" : `${((v * 8) / 1_000_000).toFixed(1)} Mbps`;
}
function uptime(v: number | null) {
  if (v == null) return "—";
  const days = Math.floor(v / 86400);
  const hours = Math.floor((v % 86400) / 3600);
  return days ? `${days}d ${hours}h` : `${hours}h`;
}

export default function AdminNodesPage() {
  const { session } = useAdminSession();
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const load = () =>
      adminFetch<{ nodes: Node[] }>("/api/admin/nodes", session.access_token)
        .then((body) => {
          if (!cancelled) {
            setNodes(body.nodes);
            setError(null);
          }
        })
        .catch((err) => !cancelled && setError(err.message));
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session]);

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Nodes</h1>
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
                <th>CPU</th>
                <th>RAM</th>
                <th>Disk</th>
                <th>Network ↓ / ↑</th>
                <th>Users</th>
                <th>Uptime</th>
                <th>Versions</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.nodeId} className="border-b align-top">
                  <td className="py-2 font-medium">{n.nodeId}</td>
                  <td><StatusBadge status={n.status} /></td>
                  <td>{pct(n.cpuPercent)}</td>
                  <td>{pct(n.memoryPercent)}</td>
                  <td>{pct(n.diskPercent)}</td>
                  <td>{mbps(n.networkRxBps)} / {mbps(n.networkTxBps)}</td>
                  <td>
                    {n.configuredUsers ?? "—"}
                    {n.activeUsersRecent != null ? ` / ${n.activeUsersRecent} recent` : ""}
                  </td>
                  <td>{uptime(n.uptimeSeconds)}</td>
                  <td className="text-xs text-gray-500">
                    agent {n.agentVersion ?? "—"}<br />
                    vpn {n.vpnVersion ?? "—"}<br />
                    sing-box {n.singboxVersion ?? "—"}
                  </td>
                  <td>{n.lastSeenAt ? new Date(n.lastSeenAt).toLocaleString() : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
