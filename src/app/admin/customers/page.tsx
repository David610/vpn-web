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
  linkCount: number | null;
  clientCount: number | null;
  capacity: number | null;
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
      <AdminPage title="Users" description="Find customer accounts, verify entitlement, and help with VPN links.">
        <input
          className={`mb-4 w-full max-w-md ${adminInputClass}`}
          type="search"
          placeholder="Search by email, user id, or VPN user id"
          aria-label="Search customers"
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
                    <th>Subscription</th>
                    <th>VPN links</th>
                    <th>Provisioned clients / capacity</th>
                    <th>Period end</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {customers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-fg-2">No customers match.</td>
                    </tr>
                  ) : null}
                  {customers.map((c) => (
                    <tr key={c.userId}>
                      <td>
                        <Link href={`/admin/customers/detail?id=${c.userId}`} className="text-fg underline underline-offset-2 hover:text-fg-2">
                          {c.email ?? c.userId}
                        </Link>
                        {c.accountRole === "owner" && c.memberCount > 1 ? <span className="text-fg-2"> · owner of {c.memberCount}</span> : null}
                      </td>
                      <td>{c.subscriptionStatus ? <StatusBadge status={c.subscriptionStatus} /> : "—"}</td>
                      <td>{c.linkCount ?? "—"}</td>
                      <td>{c.clientCount === null || c.capacity === null ? "—" : `${c.clientCount} / ${c.capacity}`}</td>
                      <td>
                        {c.currentPeriodEnd
                          ? new Date(c.currentPeriodEnd).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
                          : "—"}
                      </td>
                      <td>
                        <Link href={`/admin/customers/detail?id=${c.userId}`} className="text-link">View →</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </AdminTable>
            </AdminTableWrap>
            <p className="text-fg-2 admin-footnote">
              {meta.total === 0 ? "No customers" : `Showing ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + customers.length} of ${meta.total} customers`}
            </p>

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
