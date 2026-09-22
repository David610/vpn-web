"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { useAdminSession } from "@/hooks/useAdminSession";

type AuditEntry = {
  id: number;
  adminUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
};

export default function AdminAuditPage() {
  const { session } = useAdminSession();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    if (!session) return;
    fetch("/api/admin/audit", { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((res) => res.json())
      .then((body) => setEntries(body.entries));
  }, [session]);

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Audit log</h1>
      {!entries ? (
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">When</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b">
                <td className="py-2">{new Date(e.createdAt).toLocaleString()}</td>
                <td>{e.adminUserId}</td>
                <td>{e.action}</td>
                <td>{e.targetType} {e.targetId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
