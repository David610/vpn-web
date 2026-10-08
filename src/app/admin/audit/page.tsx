"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminNotice, AdminPage, AdminTable, AdminTableWrap } from "@/components/admin/AdminPrimitives";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type AuditEntry = {
  id: number;
  adminUserId: string;
  adminEmail: string | null;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
};

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AdminAuditPage() {
  const { session } = useAdminSession();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Deep link from a customer page: /admin/audit?q=<email>
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setQuery(q);
  }, []);

  useEffect(() => {
    if (!session) return;
    adminFetch<{ entries: AuditEntry[] }>("/api/admin/audit", session.access_token)
      .then((body) => setEntries(body.entries))
      .catch((err) => setError(err.message));
  }, [session]);

  const needle = query.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) =>
    !needle || [e.adminEmail ?? e.adminUserId, e.action, e.targetType, e.targetId].some((v) => v.toLowerCase().includes(needle))
  );

  return (
    <AdminShell>
      <AdminPage eyebrow="Security" title="Audit log" description="Who changed what, when and which account or server was affected.">
        <AdminNotice>
          Audit records show who did what and when. They hold identifiers only: never customer VPN credentials, subscription URLs or browsing data.
        </AdminNotice>
        <input
          className="mb-4 w-full max-w-sm admin-input"
          type="search"
          placeholder="Search by admin, action or target"
          aria-label="Search the audit log"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {error ? (
          <AdminNotice tone="error">{error}</AdminNotice>
        ) : !entries ? (
          <p className="text-fg-2">Loading…</p>
        ) : (
          <>
            <AdminTableWrap label="Audit log">
              <AdminTable>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Administrator</th>
                    <th>Action</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-fg-2">No matching entries.</td>
                    </tr>
                  ) : (
                    shown.map((e) => (
                      <tr key={e.id}>
                        <td>{when(e.createdAt)}</td>
                        <td>{e.adminEmail ?? e.adminUserId}</td>
                        <td>{e.action}</td>
                        <td>{e.targetType} {e.targetId}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </AdminTable>
            </AdminTableWrap>
            <p className="text-fg-2 admin-footnote">Showing the latest {entries.length} entries.</p>
          </>
        )}
      </AdminPage>
    </AdminShell>
  );
}
