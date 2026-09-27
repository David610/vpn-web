"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { AdminPage, AdminButton, AdminNotice, AdminTable, AdminTableWrap, adminInputClass } from "@/components/admin/AdminPrimitives";
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
      <AdminPage title="Customers" description={`${meta.total} total`}>
        <input
          className={`mb-4 w-full max-w-sm ${adminInputClass}`}
          placeholder="Search by email, user id, or VPN user id"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />

        {error ? (
          <AdminNotice tone="error">{error}</AdminNotice>
        ) : !customers ? (
          <p className="text-fg-2">Loading…</p>
        ) : (
          <>
            <AdminTableWrap label="Customers">
              <AdminTable>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Role</th>
                    <th>Subscription</th>
                    <th>VPN</th>
                    <th>Node</th>
                    <th>Period ends</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.userId}>
                      <td>
                        <Link
                          href={`/admin/customers/detail?id=${c.userId}`}
                          className="text-fg underline underline-offset-2 hover:text-fg-2"
                        >
                          {c.email ?? c.userId}
                        </Link>
                      </td>
                      <td className="text-fg-2">
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
                      <td className="font-mono">{c.nodeId ?? "—"}</td>
                      <td>
                        {c.currentPeriodEnd
                          ? new Date(c.currentPeriodEnd).toLocaleDateString()
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </AdminTable>
            </AdminTableWrap>

            <div className="mt-4 flex items-center gap-3">
              <AdminButton type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Previous
              </AdminButton>
              <span className="text-sm text-fg-2">
                Page {page} of {meta.totalPages}
              </span>
              <AdminButton
                type="button"
                disabled={page >= meta.totalPages}
                onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              >
                Next
              </AdminButton>
            </div>
          </>
        )}
      </AdminPage>
    </AdminShell>
  );
}
