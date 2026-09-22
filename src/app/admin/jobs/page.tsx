"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type Job = {
  id: number;
  jobType: string;
  status: string;
  nodeId: string;
  createdAt: string;
  completedAt: string | null;
};

export default function AdminJobsPage() {
  const { session } = useAdminSession();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!session) return;
    const url = statusFilter ? `/api/admin/jobs?status=${statusFilter}` : "/api/admin/jobs";
    adminFetch<{ jobs: Job[] }>(url, session.access_token)
      .then((body) => {
        setJobs(body.jobs);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [session, statusFilter]);

  useEffect(load, [load]);

  async function retry(jobId: number) {
    if (!session) return;
    try {
      await adminFetch(`/api/admin/jobs/${jobId}/retry`, session.access_token, { method: "POST" });
      setActionMessage(`Job #${jobId} retried.`);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Retry failed.");
    }
    load();
  }

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Jobs</h1>
      <select className="mb-4 rounded border px-3 py-2" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
        <option value="">All statuses</option>
        <option value="pending">Pending</option>
        <option value="claimed">Claimed</option>
        <option value="done">Done</option>
        <option value="failed">Failed</option>
      </select>
      {actionMessage && <p className="mb-4 text-sm text-gray-600">{actionMessage}</p>}
      {error ? (
        <p className="text-red-600">{error}</p>
      ) : !jobs ? (
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">ID</th>
              <th>Type</th>
              <th>Node</th>
              <th>Status</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-b">
                <td className="py-2">#{j.id}</td>
                <td>{j.jobType}</td>
                <td>{j.nodeId}</td>
                <td><StatusBadge status={j.status} /></td>
                <td>{new Date(j.createdAt).toLocaleString()}</td>
                <td>
                  {j.status === "failed" && (
                    <ConfirmButton
                      label="Retry"
                      confirmLabel="Confirm retry"
                      className="rounded bg-blue-600 px-2 py-1 text-xs text-white"
                      onConfirm={() => retry(j.id)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
