"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import {
  AdminPage,
  AdminSection,
  AdminMetric,
  AdminMetricGrid,
  AdminMetricLarge,
  AdminMetricRow,
  AdminNotice,
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

function bytes(value: number) {
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value < 1024 ** 4) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${(value / 1024 ** 4).toFixed(2)} TB`;
}
function mbps(value: number) {
  return `${(value / 1_000_000).toFixed(1)} Mbps`;
}

export default function AdminOverviewPage() {
  const { session } = useAdminSession();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const load = () =>
      adminFetch<Overview>("/api/admin/overview", session.access_token)
        .then((body) => {
          if (!cancelled) {
            setOverview(body);
            setError(null);
          }
        })
        .catch((err) => !cancelled && setError(err.message));
    const refresh = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [session]);

  return (
    <AdminShell>
      <AdminPage title="Overview">
        {error ? (
          <AdminNotice tone="error">{error}</AdminNotice>
        ) : !overview ? (
          <p className="text-fg-2">Loading…</p>
        ) : (
          <>
            <AdminMetricRow count={5}>
              <AdminMetricLarge label="Customer accounts" value={overview.customers.total} />
              <AdminMetricLarge label="Live subscriptions" value={overview.subscriptions?.live ?? "—"} />
              <AdminMetricLarge
                label="Devices / capacity"
                value={overview.devices ? `${overview.devices.active} / ${overview.devices.capacity}` : "—"}
              />
              <AdminMetricLarge label="Nodes online" value={overview.nodes.online} />
              <AdminMetricLarge label="Jobs pending" value={overview.jobs.pending} />
            </AdminMetricRow>

            <AdminSection label="Customer status">
              <AdminMetricGrid>
                <AdminMetric label="Active paid" value={overview.customers.active} />
                <AdminMetric label="Free trials" value={overview.customers.trialing} />
                <AdminMetric label="Past due" value={overview.customers.past_due} />
                <AdminMetric label="Cancelled" value={overview.customers.canceled} />
                <AdminMetric label="Cancelling" value={overview.subscriptions?.cancelling ?? "—"} />
                <AdminMetric label="Accounts with several subs" value={overview.subscriptions?.accounts_with_several ?? "—"} />
                <AdminMetric label="Extra device packs" value={overview.subscriptions?.extra_packs ?? "—"} />
                <AdminMetric label="Support grants" value={overview.members?.admin_grants ?? "—"} />
              </AdminMetricGrid>
            </AdminSection>

            <AdminSection label="Fleet">
              <AdminMetricGrid>
                <AdminMetric label="Nodes offline" value={overview.nodes.offline} />
                <AdminMetric label="Devices over capacity" value={overview.devices?.over_capacity ?? "—"} />
                <AdminMetric label="Devices without subscription" value={overview.devices?.without_subscription ?? "—"} />
                <AdminMetric label="Devices unschedulable" value={overview.devices?.unschedulable ?? "—"} />
              </AdminMetricGrid>
            </AdminSection>

            <AdminSection label="Jobs & operational health">
              <AdminMetricGrid>
                <AdminMetric label="Jobs claimed" value={overview.jobs.claimed} />
                <AdminMetric label="Jobs failed" value={overview.jobs.failed} />
                <AdminMetric label="Open alerts" value={overview.alerts.open} />
                <AdminMetric label="Abuse flags" value={overview.abuse.open} />
              </AdminMetricGrid>
            </AdminSection>

            <AdminSection
              label="Traffic this month"
              action={<span className="font-mono text-xs text-fg-3">{`${mbps(overview.usage.download_bps)} ↓ / ${mbps(overview.usage.upload_bps)} ↑ now`}</span>}
            >
              <AdminMetricGrid>
                <AdminMetric label="Total" value={bytes(overview.usage.month_total_bytes)} />
                <AdminMetric label="Down" value={bytes(overview.usage.month_download_bytes)} />
                <AdminMetric label="Up" value={bytes(overview.usage.month_upload_bytes)} />
                <AdminMetric label="VPN enabled / disabled" value={`${overview.vpn.enabled} / ${overview.vpn.disabled}`} />
              </AdminMetricGrid>
            </AdminSection>
          </>
        )}
      </AdminPage>
    </AdminShell>
  );
}
