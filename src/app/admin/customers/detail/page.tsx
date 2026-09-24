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
  // Null only for a user with no account membership at all, which the
  // handle_new_user trigger makes impossible for anyone created after the
  // customer_accounts migration.
  accountId: string | null;
  accountRole: string | null;
  memberCount: number;
  email: string | null;
  subscription: {
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean | null;
    // Carried on customer_accounts, not on the subscription: the billing
    // portal needs it even once a subscription has lapsed.
    stripeCustomerId: string | null;
  } | null;
  grants: {
    id: string;
    status: string;
    startsAt: string;
    expiresAt: string | null;
    seatLimit: number;
    reason: string;
    revokedAt: string | null;
    createdAt: string;
  }[];
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

  async function grantAccess(days: number | null) {
    if (!session || !id) return;
    const reason = window.prompt("Reason for the support entitlement (recorded in the audit trail):");
    if (!reason?.trim()) return;

    const expiresAt =
      days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
    try {
      await adminFetch(`/api/admin/customers/${id}/grant`, session.access_token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expires_at: expiresAt,
          seat_limit: 3,
          reason: reason.trim(),
        }),
      });
      setActionMessage(days === null ? "Indefinite support access granted." : `${days}-day support access granted.`);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Grant failed.");
    }
    load();
  }

  async function revokeGrant(grantId: string) {
    if (!session) return;
    if (!window.confirm("Revoke this support entitlement? Access will be reconciled against any remaining paid subscription or grant.")) return;
    try {
      await adminFetch(`/api/admin/entitlements/${grantId}`, session.access_token, {
        method: "DELETE",
      });
      setActionMessage("Support entitlement revoked.");
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Revoke failed.");
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
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-medium">Support entitlements</h2>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm"
              onClick={() => grantAccess(30)}
            >
              Grant 30 days
            </button>
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm"
              onClick={() => grantAccess(null)}
            >
              Grant no expiry
            </button>
          </div>
        </div>
        {detail.grants.length === 0 ? (
          <p className="text-sm text-gray-500">No support-granted access.</p>
        ) : (
          <div className="space-y-2">
            {detail.grants.map((g) => {
              const naturallyExpired =
                g.status === "active" && g.expiresAt && new Date(g.expiresAt).getTime() <= Date.now();
              const displayStatus = naturallyExpired ? "expired" : g.status;
              return (
                <div key={g.id} className="rounded border p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <StatusBadge status={displayStatus} />
                      <span className="ml-2">{g.seatLimit} seats</span>
                    </div>
                    {g.status === "active" && !naturallyExpired && (
                      <ConfirmButton
                        label="Revoke"
                        confirmLabel="Click again to revoke"
                        className="rounded bg-red-600 px-3 py-1 text-xs text-white"
                        onConfirm={() => revokeGrant(g.id)}
                      />
                    )}
                  </div>
                  <p className="mt-2 text-gray-700">{g.reason}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    {g.expiresAt
                      ? `Expires ${new Date(g.expiresAt).toLocaleString()}`
                      : "No expiry"}
                  </p>
                </div>
              );
            })}
          </div>
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
                label="Rotate subscription link"
                confirmLabel="Click again to rotate the subscription link"
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
                onConfirm={() => callAction("rotate", "Subscription-link rotation")}
              />
              <ConfirmButton
                label="Rotate VPN credentials"
                confirmLabel="Confirm: existing imported VPN credentials will stop working"
                className="rounded bg-amber-600 px-3 py-1.5 text-sm text-white"
                onConfirm={() => callAction("rotate-credentials", "VPN credential rotation")}
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
