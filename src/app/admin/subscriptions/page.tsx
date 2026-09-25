"use client";

import { useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type Subscription = {
  id: string;
  accountId: string;
  ownerEmail: string | null;
  name: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  extraPacks: number;
  capacity: number;
  activeDevices: number;
  createdAt: string;
};

type ResponseBody = {
  subscriptions: Subscription[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
};

const PAGE_SIZE = 50;

export default function AdminSubscriptionsPage() {
  const { session } = useAdminSession();
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(input.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [input]);

  const url = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), per_page: String(PAGE_SIZE) });
    if (query) params.set("q", query);
    return `/api/admin/subscriptions?${params.toString()}`;
  }, [page, query]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setError(null);
    adminFetch<ResponseBody>(url, session.access_token)
      .then((body) => {
        if (cancelled) return;
        setSubscriptions(body.subscriptions);
        setMeta({ total: body.total, totalPages: body.totalPages });
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [session, url]);

  return (
    <AdminShell>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">Subscriptions</h1>
        <span className="text-xs text-gray-500">{meta.total} total</span>
      </div>

      <input
        className="mb-4 w-full max-w-sm rounded border px-3 py-2"
        placeholder="Search by owner email, name, or Stripe subscription id"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />

      {error ? (
        <p className="text-red-600">{error}</p>
      ) : !subscriptions ? (
        <p>Loading…</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-gray-500">
                  <th className="py-2">Owner</th>
                  <th>Subscription</th>
                  <th>Status</th>
                  <th>Devices</th>
                  <th>Extra packs</th>
                  <th>Period ends</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((s) => (
                  <tr key={s.id} className="border-b">
                    <td className="py-2">{s.ownerEmail ?? s.accountId}</td>
                    <td>{s.name}</td>
                    <td>
                      <StatusBadge status={s.cancelAtPeriodEnd ? "cancelling" : s.status} />
                    </td>
                    <td>{s.activeDevices} / {s.capacity}</td>
                    <td>{s.extraPacks}</td>
                    <td>
                      {s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : "—"}
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
