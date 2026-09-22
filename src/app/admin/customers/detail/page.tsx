"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type CustomerDetail = {
  userId: string;
  email: string | null;
  subscription: { status: string; currentPeriodEnd: string | null; stripeCustomerId: string | null } | null;
  vpnAccount: { id: number; vpnUserId: string; nodeId: string; enabled: boolean } | null;
  jobs: { id: number; jobType: string; status: string; createdAt: string }[];
};

export default function AdminCustomerDetailPage() {
  return (
    <Suspense
      fallback={
        <AdminShell>
          <p>Loading…</p>
        </AdminShell>
      }
    >
      <AdminCustomerDetailContent />
    </Suspense>
  );
}

function AdminCustomerDetailContent() {
  const { session } = useAdminSession();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!session || !id) return;
    adminFetch<CustomerDetail>(`/api/admin/customers/${id}`, session.access_token)
      .then((body) => {
        setDetail(body);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [session, id]);

  useEffect(load, [load]);

  async function callAction(path: string, label: string) {
    if (!session || !id) return;
    try {
      await adminFetch(`/api/admin/customers/${id}/${path}`, session.access_token, { method: "POST" });
      setActionMessage(`${label} job created.`);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Action failed.");
    }
    load();
  }

  if (!id) {
    return (
      <AdminShell>
        <p>No customer id provided.</p>
      </AdminShell>
    );
  }

  if (error) {
    return (
      <AdminShell>
        <p className="text-red-600">{error}</p>
      </AdminShell>
    );
  }

  if (!detail) {
    return (
      <AdminShell>
        <p>Loading…</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">{detail.email ?? detail.userId}</h1>
      {actionMessage && <p className="mb-4 text-sm text-gray-600">{actionMessage}</p>}

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Billing</h2>
        {detail.subscription ? (
          <>
            <p>Status: <StatusBadge status={detail.subscription.status} /></p>
            <p>Period ends: {detail.subscription.currentPeriodEnd ? new Date(detail.subscription.currentPeriodEnd).toLocaleDateString() : "—"}</p>
          </>
        ) : (
          <p>No subscription.</p>
        )}
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">VPN</h2>
        {detail.vpnAccount ? (
          <>
            <p>Node: {detail.vpnAccount.nodeId}</p>
            <p>Status: <StatusBadge status={detail.vpnAccount.enabled ? "active" : "canceled"} /></p>
            <div className="mt-3 flex gap-2">
              <ConfirmButton
                label="Disable"
                confirmLabel="Click again to confirm disable"
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white"
                onConfirm={() => callAction("disable", "Disable")}
              />
              <ConfirmButton
                label="Enable"
                confirmLabel="Click again to confirm enable"
                className="rounded bg-green-600 px-3 py-1.5 text-sm text-white"
                onConfirm={() => callAction("enable", "Enable")}
              />
              <ConfirmButton
                label="Rotate config"
                confirmLabel="Click again to confirm rotate"
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white"
                onConfirm={() => callAction("rotate", "Rotate")}
              />
            </div>
          </>
        ) : (
          <p>No VPN account provisioned yet.</p>
        )}
      </section>

      <section className="rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Provisioning history</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-1">Job</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {detail.jobs.map((j) => (
              <tr key={j.id} className="border-b">
                <td className="py-1">#{j.id} {j.jobType}</td>
                <td><StatusBadge status={j.status} /></td>
                <td>{new Date(j.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AdminShell>
  );
}
