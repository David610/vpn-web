"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import {
  AdminButton,
  AdminMetricLarge,
  AdminMetricRow,
  AdminNotice,
  AdminPage,
  AdminSection,
  AdminStatRow,
  AdminStatRows,
} from "@/components/admin/AdminPrimitives";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type Overview = {
  customers: { total: number; active: number; trialing: number; past_due: number; canceled: number };
  subscriptions?: { live: number; cancelling: number; extra_packs: number; accounts_with_several: number };
  devices?: { active: number; capacity: number; over_capacity: number; without_subscription: number; unschedulable: number };
  members?: { admin_grants: number };
  vpn: { accounts: number; enabled: number; disabled: number };
  jobs: { pending: number; claimed: number; failed: number };
  nodes: { online: number; offline: number };
  usage: {
    download_bps: number;
    upload_bps: number;
    month_download_bytes: number;
    month_upload_bytes: number;
    month_total_bytes: number;
  };
  alerts: { open: number };
  abuse: { open: number };
};

type Attention = { key: string; title: string; detail: string; href: string; tone: "Review" | "Investigate" | "New" };

function bytes(value: number) {
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value < 1024 ** 4) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${(value / 1024 ** 4).toFixed(2)} TB`;
}
function mbps(value: number) {
  return `${(value / 1_000_000).toFixed(1)} Mbps`;
}
function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** What needs a human, derived from live counts. Each item links to where it can be handled. */
function attentionItems(o: Overview): Attention[] {
  const items: Attention[] = [];
  if (o.jobs.failed > 0) {
    items.push({ key: "jobs", title: `${plural(o.jobs.failed, "provisioning job")} failed`, detail: "Review the failure before retrying.", href: "/admin/jobs", tone: "Review" });
  }
  if (o.nodes.offline > 0) {
    items.push({ key: "nodes", title: `${plural(o.nodes.offline, "server")} offline`, detail: "No recent heartbeat.", href: "/admin/nodes", tone: "Investigate" });
  }
  if (o.alerts.open > 0) {
    items.push({ key: "alerts", title: plural(o.alerts.open, "open alert"), detail: "Operational alerts waiting for review.", href: "/admin/alerts", tone: "Investigate" });
  }
  if (o.customers.past_due > 0) {
    items.push({ key: "billing", title: `${plural(o.customers.past_due, "subscription")} past due`, detail: "May need billing follow-up.", href: "/admin/subscriptions", tone: "New" });
  }
  if (o.abuse.open > 0) {
    items.push({ key: "abuse", title: plural(o.abuse.open, "abuse flag"), detail: "Signals are review aids, not automatic bans.", href: "/admin/abuse", tone: "Review" });
  }
  return items;
}

export default function AdminOverviewPage() {
  const { session } = useAdminSession();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setOverview(await adminFetch<Overview>("/api/admin/overview", session.access_token));
      setUpdatedAt(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the overview.");
    }
  }, [session]);

  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const total = overview ? overview.nodes.online + overview.nodes.offline : 0;
  const attention = overview ? attentionItems(overview) : [];

  return (
    <AdminShell>
      <AdminPage
        title="Overview"
        description="The essential health of the service and your customers."
        actions={<AdminButton type="button" onClick={() => void load()}>Refresh</AdminButton>}
      >
        {error ? (
          <AdminNotice tone="error">{error}</AdminNotice>
        ) : !overview ? (
          <p className="text-fg-2">Loading…</p>
        ) : (
          <>
            <AdminMetricRow>
              <AdminMetricLarge label="Customer accounts" value={overview.customers.total.toLocaleString()} note="Total registered" />
              <AdminMetricLarge label="Active subscriptions" value={(overview.subscriptions?.live ?? 0).toLocaleString()} note="Single €6.99/month plan" />
              <AdminMetricLarge label="Servers ready" value={`${overview.nodes.online} / ${total}`} note={overview.nodes.offline === 0 ? "All online" : `${overview.nodes.offline} offline`} />
              <AdminMetricLarge label="Failed jobs" value={overview.jobs.failed} note={overview.jobs.failed === 0 ? "Nothing to review" : "Require review"} />
            </AdminMetricRow>

            <div className="admin-columns">
              <AdminSection label="Needs attention" action={<Link className="text-link" href="/admin/jobs">Open operations</Link>}>
                {attention.length === 0 ? (
                  <p className="text-fg-2">Nothing needs attention right now.</p>
                ) : (
                  <ul className="attention">
                    {attention.map((item) => (
                      <li key={item.key}>
                        <div>
                          <Link href={item.href} className="attention__title">{item.title}</Link>
                          <p className="text-fg-2">{item.detail}</p>
                        </div>
                        <span className="badge badge--warn">{item.tone}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </AdminSection>

              <AdminSection
                label="System status"
                action={
                  overview.nodes.offline === 0 && overview.jobs.failed === 0 ? (
                    <span className="badge badge--ok">Operational</span>
                  ) : (
                    <span className="badge badge--warn">Attention required</span>
                  )
                }
              >
                <AdminStatRows>
                  <AdminStatRow label="VPN servers" value={`${overview.nodes.online} online / ${overview.nodes.offline} offline`} />
                  <AdminStatRow label="Provisioning" value={`${overview.jobs.pending} pending · ${overview.jobs.failed} failed`} />
                  <AdminStatRow label="Billing" value={`${overview.customers.past_due} past due`} />
                  <AdminStatRow label="Traffic this month" value={bytes(overview.usage.month_total_bytes)} />
                  <AdminStatRow label="Current ↓ / ↑" value={`${mbps(overview.usage.download_bps)} / ${mbps(overview.usage.upload_bps)}`} />
                </AdminStatRows>
                {updatedAt ? <p className="text-fg-2 admin-footnote">Updated {updatedAt.toLocaleTimeString()}</p> : null}
              </AdminSection>
            </div>

            <AdminSection label="Customer status">
              <AdminStatRows>
                <AdminStatRow label="Active paid" value={overview.customers.active} />
                <AdminStatRow label="Free trials" value={overview.customers.trialing} />
                <AdminStatRow label="Past due" value={overview.customers.past_due} warn />
                <AdminStatRow label="Cancelled" value={overview.customers.canceled} />
                <AdminStatRow label="Cancelling" value={overview.subscriptions?.cancelling ?? "—"} />
                <AdminStatRow label="Support grants" value={overview.members?.admin_grants ?? "—"} />
                <AdminStatRow label="Devices over capacity" value={overview.devices?.over_capacity ?? "—"} warn />
                <AdminStatRow label="Devices without subscription" value={overview.devices?.without_subscription ?? "—"} warn />
              </AdminStatRows>
            </AdminSection>
          </>
        )}
      </AdminPage>
    </AdminShell>
  );
}
