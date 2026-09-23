"use client";

import { useCallback, useEffect, useState } from "react";
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
  traffic: Traffic;
};

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

  useEffect(() => {
    if (!session) return;
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [session, load]);

  return (
    <AdminShell>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Nodes</h1>
        <span className="text-xs text-gray-500">
          VPN traffic and host health · refresh {REFRESH_MS / 1000}s
        </span>
      </div>

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
