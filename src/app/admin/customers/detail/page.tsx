"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import {
  AdminButton,
  AdminNotice,
  AdminPage,
  AdminSection,
  AdminStatRow,
  AdminStatRows,
  AdminTable,
  AdminTableWrap,
} from "@/components/admin/AdminPrimitives";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type CustomerLink = {
  id: string;
  name: string;
  status: string;
  routing: 1 | 2;
  locationMode: "auto" | "manual";
  location: string | null;
  createdAt: string;
  revokedAt: string | null;
};

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
  // Metadata only. Null means the lookup failed, not that there are none.
  links: CustomerLink[] | null;
  // Plural (F-07/C-06): a customer can have several provisioned devices, so
  // admin disable/enable/rotate now act account-wide instead of assuming a
  // single vpn_accounts row per user.
  vpnAccounts: { id: number; vpnUserId: string; nodeId: string; enabled: boolean }[];
  suspendedAt?: string | null;
  jobs: { id: number; jobType: string; status: string; createdAt: string }[];
};

function shortDate(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";
}

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

    const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
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
        <AdminNotice tone="error">No customer id provided.</AdminNotice>
      </AdminShell>
    );
  }

  if (error) {
    return (
      <AdminShell>
        <AdminNotice tone="error">{error}</AdminNotice>
      </AdminShell>
    );
  }

  if (!detail) {
    return (
      <AdminShell>
        <p className="text-fg-2">Loading…</p>
      </AdminShell>
    );
  }

  const who = detail.email ?? detail.userId;
  const activeLinks = detail.links?.filter((l) => l.status === "active").length;

  return (
    <AdminShell>
      <AdminPage
        eyebrow="Users"
        title="Customer account"
        description="Customer access and subscription details, without browsing data or VPN secrets."
        actions={
          <Link className="btn btn-secondary" href={`/admin/audit?q=${encodeURIComponent(who)}`}>
            View account history
          </Link>
        }
      >
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/admin/customers">← Users</Link> <span aria-hidden="true">/</span> {who}
        </nav>
        {actionMessage ? <AdminNotice>{actionMessage}</AdminNotice> : null}

        <div className="admin-columns admin-columns--even">
          <AdminSection label="Account">
            <AdminStatRows>
              <AdminStatRow label="Email" value={who} />
              <AdminStatRow label="Account status" value={detail.suspendedAt ? `Suspended since ${shortDate(detail.suspendedAt)}` : "Active"} warn={Boolean(detail.suspendedAt)} />
              <AdminStatRow label="Role" value={detail.accountRole === "owner" && detail.memberCount > 1 ? `Owner of ${detail.memberCount}` : detail.accountRole ?? "—"} />
            </AdminStatRows>
          </AdminSection>

          <AdminSection label="Plan & access">
            {detail.subscription ? (
              <AdminStatRows>
                <div className="admin-stat-row">
                  <span className="admin-stat-row__label">Status</span>
                  <StatusBadge status={detail.subscription.cancelAtPeriodEnd ? "cancelling" : detail.subscription.status} />
                </div>
                <AdminStatRow label={detail.subscription.cancelAtPeriodEnd ? "Ends" : "Next renewal"} value={shortDate(detail.subscription.currentPeriodEnd)} />
                <AdminStatRow label="Active links" value={activeLinks ?? "—"} />
              </AdminStatRows>
            ) : (
              <p className="text-fg-2">No subscription.</p>
            )}
          </AdminSection>
        </div>

        <h2 className="ps-section-title">
          VPN links <span className="text-fg-2 admin-aside">Metadata only · no secret URLs</span>
        </h2>
        {detail.links === null ? (
          <AdminNotice tone="error">Link details are temporarily unavailable.</AdminNotice>
        ) : detail.links.length === 0 ? (
          <p className="text-fg-2">This customer has no VPN links.</p>
        ) : (
          <AdminTableWrap label="VPN links">
            <AdminTable>
              <thead>
                <tr>
                  <th>Link name</th>
                  <th>Routing</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {detail.links.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td>
                      {l.routing} {l.routing === 1 ? "server" : "servers"} · {l.locationMode === "auto" ? "Automatic" : "Manual"}
                      {l.location ? <span className="text-fg-2"> ({l.location})</span> : null}
                    </td>
                    <td>
                      <StatusBadge status={l.status} />
                    </td>
                    <td>{shortDate(l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </AdminTableWrap>
        )}
        <AdminNotice>
          Customer access links and VPN credentials are not displayed to administrators. Revocation or account changes require authorization and are recorded in the audit log.
        </AdminNotice>

        <AdminSection
          label="Support entitlements"
          action={
            <span className="admin-actions">
              <AdminButton type="button" onClick={() => grantAccess(30)}>Grant 30 days</AdminButton>
              <AdminButton type="button" onClick={() => grantAccess(null)}>Grant no expiry</AdminButton>
            </span>
          }
        >
          {detail.grants.length === 0 ? (
            <p className="text-fg-2">No support-granted access.</p>
          ) : (
            <ul className="attention">
              {detail.grants.map((g) => {
                const naturallyExpired = g.status === "active" && g.expiresAt && new Date(g.expiresAt).getTime() <= Date.now();
                const displayStatus = naturallyExpired ? "expired" : g.status;
                return (
                  <li key={g.id}>
                    <div>
                      <StatusBadge status={displayStatus} /> <span className="admin-aside">{g.seatLimit} devices</span>
                      <p>{g.reason}</p>
                      <p className="text-fg-2">{g.expiresAt ? `Expires ${new Date(g.expiresAt).toLocaleString()}` : "No expiry"}</p>
                    </div>
                    {g.status === "active" && !naturallyExpired && (
                      <ConfirmButton
                        label="Revoke"
                        confirmLabel="Click again to revoke"
                        className="btn btn-danger btn-sm"
                        onConfirm={() => revokeGrant(g.id)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </AdminSection>

        {detail.vpnAccounts.length > 0 ? (
          <AdminSection label="Provisioned VPN accounts">
            <ul className="attention">
              {detail.vpnAccounts.map((v) => (
                <li key={v.id}>
                  <span>
                    Node {v.nodeId}
                  </span>
                  <StatusBadge status={v.enabled ? "active" : "canceled"} />
                </li>
              ))}
            </ul>
            <p className="text-fg-2 admin-footnote">Each action below needs a second click to confirm and is written to the audit log.</p>
            <div className="admin-actions">
              <ConfirmButton
                label="Disable"
                confirmLabel="Click again to confirm disable"
                className="btn btn-danger btn-sm"
                onConfirm={() => callAction("disable", "Disable")}
              />
              <ConfirmButton
                label="Enable"
                confirmLabel="Click again to confirm enable"
                className="btn btn-secondary btn-sm"
                onConfirm={() => callAction("enable", "Enable")}
              />
              <ConfirmButton
                label="Rotate subscription link"
                confirmLabel="Click again to rotate the subscription link"
                className="btn btn-secondary btn-sm"
                onConfirm={() => callAction("rotate", "Subscription-link rotation")}
              />
              <ConfirmButton
                label="Rotate VPN credentials"
                confirmLabel="Confirm: existing imported VPN credentials will stop working"
                className="btn btn-danger btn-sm"
                onConfirm={() => callAction("rotate-credentials", "VPN credential rotation")}
              />
            </div>
          </AdminSection>
        ) : null}

        <AdminSection label="Provisioning history">
          {detail.jobs.length === 0 ? (
            <p className="text-fg-2">No provisioning jobs.</p>
          ) : (
            <AdminTableWrap label="Provisioning history">
              <AdminTable>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.jobs.map((j) => (
                    <tr key={j.id}>
                      <td>#{j.id} {j.jobType}</td>
                      <td><StatusBadge status={j.status} /></td>
                      <td>{new Date(j.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </AdminTable>
            </AdminTableWrap>
          )}
        </AdminSection>
      </AdminPage>
    </AdminShell>
  );
}
