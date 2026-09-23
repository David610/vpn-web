"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type Alert = {
  id: string;
  alertType: string;
  severity: string;
  status: string;
  nodeId: string | null;
  message: string;
  createdAt: string | null;
  derived: boolean;
};

export default function AdminAlertsPage() {
  const { session } = useAdminSession();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!session) return;
    adminFetch<{ alerts: Alert[] }>("/api/admin/alerts", session.access_token)
      .then((body) => {
        setAlerts(body.alerts);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [session]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  async function resolve(id: string) {
    if (!session) return;
    try {
      await adminFetch(`/api/admin/alerts/${id}`, session.access_token, {
        method: "PATCH",
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resolve alert.");
    }
  }

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Alerts</h1>
      {error && <p className="mb-4 text-red-600">{error}</p>}
      {!alerts ? (
        <p>Loading…</p>
      ) : alerts.length === 0 ? (
        <p className="text-sm text-gray-500">No alerts.</p>
      ) : (
        <div className="space-y-3">
          {alerts.map((a) => (
            <div key={a.id} className="rounded border bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <StatusBadge status={a.severity} />
                  <span className="ml-2 font-medium">{a.alertType}</span>
                </div>
                {!a.derived && a.status === "open" && (
                  <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    onClick={() => resolve(a.id)}
                  >
                    Resolve
                  </button>
                )}
              </div>
              <p className="mt-2 text-sm">{a.message}</p>
              <p className="mt-1 text-xs text-gray-500">
                {a.nodeId ? `Node ${a.nodeId} · ` : ""}
                {a.createdAt ? new Date(a.createdAt).toLocaleString() : "No heartbeat received"}
                {a.derived ? " · clears automatically" : ""}
              </p>
            </div>
          ))}
        </div>
      )}
    </AdminShell>
  );
}
