"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type Customer = {
  userId: string;
  accountId: string;
  accountRole: string;
  memberCount: number;
  email: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  vpnAccountId: number | null;
  nodeId: string | null;
  enabled: boolean | null;
};

type ResponseBody = {
  customers: Customer[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
};

const PAGE_SIZE = 50;

export default function AdminCustomersPage() {
  const { session } = useAdminSession();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
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
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(PAGE_SIZE),
    });
    if (query) params.set("q", query);
    return `/api/admin/customers?${params.toString()}`;
  }, [page, query]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setError(null);

    adminFetch<ResponseBody>(url, session.access_token)
      .then((body) => {
        if (cancelled) return;
        setCustomers(body.customers);
        setMeta({ total: body.total, totalPages: body.totalPages });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [session, url]);

  return (
    <AdminShell>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">Customers</h1>
        <span className="text-xs text-gray-500">{meta.total} total</span>
      </div>

      <input
        className="mb-4 w-full max-w-sm rounded border px-3 py-2"
        placeholder="Search by email, user id, or VPN user id"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />

      {error ? (
        <p className="text-red-600">{error}</p>
      ) : !customers ? (
        <p>Loading…</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-gray-500">
                  <th className="py-2">Customer</th>
                  <th>Seat</th>
                  <th>Subscription</th>
                  <th>VPN</th>
                  <th>Node</th>
                  <th>Period ends</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.userId} className="border-b">
                    <td className="py-2">
                      <Link
                        href={`/admin/customers/detail?id=${c.userId}`}
                        className="text-neutral-900 underline underline-offset-2 hover:text-neutral-600"
                      >
                        {c.email ?? c.userId}
                      </Link>
                    </td>
                    <td className="text-gray-500">
                      {c.accountRole === "owner" && c.memberCount > 1
                        ? `owner of ${c.memberCount}`
                        : c.accountRole}
                    </td>
                    <td>
                      {c.subscriptionStatus ? (
                        <StatusBadge status={c.subscriptionStatus} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {c.vpnAccountId ? (
                        <StatusBadge status={c.enabled ? "active" : "canceled"} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{c.nodeId ?? "—"}</td>
                    <td>
                      {c.currentPeriodEnd
                        ? new Date(c.currentPeriodEnd).toLocaleDateString()
                        : "—"}
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
