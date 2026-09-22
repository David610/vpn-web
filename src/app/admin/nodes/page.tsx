"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type Node = { nodeId: string; status: string; lastSeenAt: string | null };

export default function AdminNodesPage() {
  const { session } = useAdminSession();
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    adminFetch<{ nodes: Node[] }>("/api/admin/nodes", session.access_token)
      .then((body) => setNodes(body.nodes))
      .catch((err) => setError(err.message));
  }, [session]);

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Nodes</h1>
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
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.nodeId} className="border-b">
                <td className="py-2">{n.nodeId}</td>
                <td><StatusBadge status={n.status} /></td>
                <td>{n.lastSeenAt ? new Date(n.lastSeenAt).toLocaleString() : "never"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
