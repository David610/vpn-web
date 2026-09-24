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

type JobsResponse = {
  jobs: Job[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
};

const PAGE_SIZE = 50;

export default function AdminJobsPage() {
  const { session } = useAdminSession();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!session) return;
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(PAGE_SIZE),
    });
    if (statusFilter) params.set("status", statusFilter);

    adminFetch<JobsResponse>(`/api/admin/jobs?${params.toString()}`, session.access_token)
      .then((body) => {
        setJobs(body.jobs);
        setMeta({ total: body.total, totalPages: body.totalPages });
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [session, statusFilter, page]);

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
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <span className="text-xs text-gray-500">{meta.total} total</span>
      </div>

      <select
        className="mb-4 rounded border px-3 py-2"
        value={statusFilter}
        onChange={(e) => {
          setStatusFilter(e.target.value);
          setPage(1);
        }}
      >
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
        <>
          <div className="overflow-x-auto">
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
                          className="rounded bg-neutral-900 px-2 py-1 text-xs text-white"
                          onConfirm={() => retry(j.id)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span className="text-sm text-gray-500">
              Page {page} of {meta.totalPages}
            </span>
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm disabled:opacity-40"
              disabled={page >= meta.totalPages}
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </>
      )}
    </AdminShell>
  );
}
