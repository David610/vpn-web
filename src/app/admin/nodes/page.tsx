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
  traffic: Traffic;
};

/** Nodes report every ~15s, so anything faster than this just redraws. */
const REFRESH_MS = 10_000;

function formatBits(bps: number | null): string {
  // Null means "no fresh sample", which is not the same as idle — an
  // operator needs to tell "reporting zero" from "not reporting".
  if (bps === null) return "—";
  if (bps < 1000) return `${bps} bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)} kbps`;
  if (bps < 1_000_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${(bps / 1_000_000_000).toFixed(2)} Gbps`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TiB`;
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
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [session, load]);

  return (
    <AdminShell>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Nodes</h1>
        <span className="text-xs text-gray-500">
          Throughput is per node, refreshed every {REFRESH_MS / 1000}s
        </span>
      </div>
      {error ? (
        <p className="text-red-600">{error}</p>
      ) : !nodes ? (
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">Node</th>
              <th>Status</th>
              <th className="text-right">Down</th>
              <th className="text-right">Up</th>
              <th className="text-right">Conns</th>
              <th className="text-right">Today</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.nodeId} className="border-b">
                <td className="py-2 font-medium">{n.nodeId}</td>
                <td>
                  <StatusBadge status={n.status} />
                </td>
                <td className="text-right tabular-nums">
                  {formatBits(n.traffic.bpsDown)}
                </td>
                <td className="text-right tabular-nums">
                  {formatBits(n.traffic.bpsUp)}
                </td>
                <td className="text-right tabular-nums">
                  {n.traffic.connectionsOpen ?? "—"}
                </td>
                <td className="text-right tabular-nums text-gray-600">
                  {formatBytes(n.traffic.todayBytesDown + n.traffic.todayBytesUp)}
                </td>
                <td className="text-gray-500">
                  {n.lastSeenAt ? new Date(n.lastSeenAt).toLocaleString() : "never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {nodes && nodes.every((n) => n.traffic.sampledAt === null) && (
        <p className="mt-4 text-xs text-gray-500">
          No node is reporting traffic yet. Reporting is opt-in — a node needs
          sing-box&apos;s Clash API enabled and <code>clash_api_url</code> set in its
          agent config. These are per-node totals; sing-box&apos;s official build
          exposes no per-user counters.
        </p>
      )}
    </AdminShell>
  );
}
