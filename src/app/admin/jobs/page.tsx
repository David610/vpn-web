"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminPage, AdminTable, AdminTableWrap } from "@/components/admin/AdminPrimitives";
import { OperationsTabs } from "@/components/admin/OperationsTabs";
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
      <AdminPage
        title="Operations"
        description="Failed provisioning, node alerts and actions that need review."
        actions={<span className="text-fg-2">{meta.total} jobs</span>}
      >
        <OperationsTabs />

      <select
        className="mb-4 admin-select admin-select--inline"
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

      {actionMessage && <p className="mb-4 text-sm text-fg-2">{actionMessage}</p>}
      {error ? (
        <p className="text-danger">{error}</p>
      ) : !jobs ? (
        <p>Loading…</p>
      ) : (
        <>
          <AdminTableWrap>
            <AdminTable>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Node</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>#{j.id}</td>
                    <td>{j.jobType}</td>
                    <td>{j.nodeId}</td>
                    <td><StatusBadge status={j.status} /></td>
                    <td>{new Date(j.createdAt).toLocaleString()}</td>
                    <td>
                      {j.status === "failed" && (
                        <ConfirmButton
                          label="Retry"
                          confirmLabel="Confirm retry"
                          className="btn btn-primary btn-sm"
                          onConfirm={() => retry(j.id)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </AdminTableWrap>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span className="text-sm text-fg-2">
              Page {page} of {meta.totalPages}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={page >= meta.totalPages}
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </>
      )}
      </AdminPage>
    </AdminShell>
  );
}
