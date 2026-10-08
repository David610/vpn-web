"use client";

import { useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminMetricLarge, AdminMetricRow, AdminPage, AdminTable, AdminTableWrap } from "@/components/admin/AdminPrimitives";
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

type PaymentsOverview = {
  customers: { past_due: number; canceled: number };
  subscriptions?: { live: number; cancelling: number };
};

function PaymentsSummary() {
  const { session } = useAdminSession();
  const [overview, setOverview] = useState<PaymentsOverview | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    adminFetch<PaymentsOverview>("/api/admin/overview", session.access_token)
      .then((body) => !cancelled && setOverview(body))
      .catch(() => !cancelled && setOverview(null));
    return () => {
      cancelled = true;
    };
  }, [session]);
  const winding = overview ? overview.customers.canceled + (overview.subscriptions?.cancelling ?? 0) : "—";
  return (
    <AdminMetricRow count={3}>
      <AdminMetricLarge label="Active subscriptions" value={overview?.subscriptions?.live ?? "—"} note="Single €6.99/month offering" />
      <AdminMetricLarge label="Past due" value={overview?.customers.past_due ?? "—"} note="May need billing follow-up" />
      <AdminMetricLarge label="Canceling / canceled" value={winding} note="Account status from Stripe" />
    </AdminMetricRow>
  );
}

function monthlyPrice(extraPacks: number) {
  return `€${(6.99 * (1 + extraPacks)).toFixed(2)} / month`;
}

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
      <AdminPage title="Payments" description="Subscription status and billing issues in one place.">
        <PaymentsSummary />
        <h2 className="ps-section-title">Subscriptions</h2>

      <input
        className="mb-4 w-full max-w-sm admin-input"
        placeholder="Search by owner email, name, or Stripe subscription id"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />

      {error ? (
        <p className="text-danger">{error}</p>
      ) : !subscriptions ? (
        <p>Loading…</p>
      ) : (
        <>
          <AdminTableWrap>
            <AdminTable>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Plan</th>
                  <th>Period end</th>
                  <th>Provisioned clients / limit</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.ownerEmail ?? s.accountId}</td>
                    <td>
                      <StatusBadge status={s.cancelAtPeriodEnd ? "cancelling" : s.status} />
                    </td>
                    <td>{monthlyPrice(s.extraPacks)}</td>
                    <td>
                      {s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                    </td>
                    <td>{s.activeDevices} / {s.capacity}</td>
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
