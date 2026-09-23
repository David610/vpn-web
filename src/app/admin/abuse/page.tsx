"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type Signal = {
  id: number;
  vpnAccountId: number;
  userId: string | null;
  vpnUserId: string | null;
  nodeId: string | null;
  vpnEnabled: boolean | null;
  distinctIpCount: number;
  windowStart: string;
  windowEnd: string;
  reviewStatus: string;
  createdAt: string;
};

export default function AdminAbusePage() {
  const { session } = useAdminSession();
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!session) return;
    adminFetch<{ signals: Signal[] }>("/api/admin/abuse", session.access_token)
      .then((body) => {
        setSignals(body.signals);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [session]);

  useEffect(load, [load]);

  async function review(signal: Signal, status: "reviewed" | "ignored") {
    if (!session) return;
    try {
      await adminFetch(`/api/admin/abuse/${signal.id}`, session.access_token, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review failed.");
    }
  }

  async function disable(signal: Signal) {
    if (!session || !signal.userId) return;
    if (!window.confirm("Disable this VPN member? The abuse signal alone is not proof; use this only after review.")) return;
    try {
      await adminFetch(`/api/admin/customers/${signal.userId}/disable`, session.access_token, {
        method: "POST",
      });
      await review(signal, "reviewed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disable failed.");
    }
  }

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Abuse review</h1>
      <p className="mb-4 text-sm text-gray-500">
        Signals are review aids, not automatic bans. No browsing destinations are stored here.
      </p>
      {error && <p className="mb-4 text-red-600">{error}</p>}
      {!signals ? (
        <p>Loading…</p>
      ) : signals.length === 0 ? (
        <p className="text-sm text-gray-500">No flagged signals.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">VPN user</th>
              <th>Node</th>
              <th>Distinct IPs</th>
              <th>Window</th>
              <th>Review</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => (
              <tr key={s.id} className="border-b">
                <td className="py-2">{s.vpnUserId ?? s.vpnAccountId}</td>
                <td>{s.nodeId ?? "—"}</td>
                <td>{s.distinctIpCount}</td>
                <td>{new Date(s.windowStart).toLocaleString()} – {new Date(s.windowEnd).toLocaleString()}</td>
                <td><StatusBadge status={s.reviewStatus} /></td>
                <td>
                  <div className="flex gap-2">
                    <button className="rounded border px-2 py-1" onClick={() => review(s, "reviewed")}>Reviewed</button>
                    <button className="rounded border px-2 py-1" onClick={() => review(s, "ignored")}>Ignore</button>
                    {s.userId && s.vpnEnabled !== false && (
                      <button className="rounded bg-red-600 px-2 py-1 text-white" onClick={() => disable(s)}>Disable</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
