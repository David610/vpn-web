"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { MetricCard } from "@/components/admin/MetricCard";
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
      <h1 className="mb-6 text-xl font-semibold">Overview</h1>
      {error ? (
        <p className="text-red-600">{error}</p>
      ) : !overview ? (
        <p>Loading…</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <MetricCard label="Customer accounts" value={overview.customers.total} />
          <MetricCard label="Active paid" value={overview.customers.active} />
          <MetricCard label="Free trials" value={overview.customers.trialing} />
          <MetricCard label="Past due" value={overview.customers.past_due} />

          <MetricCard label="Live subscriptions" value={overview.subscriptions?.live ?? "—"} />
          <MetricCard label="Extra device packs" value={overview.subscriptions?.extra_packs ?? "—"} />
          <MetricCard label="Devices / capacity" value={overview.devices ? `${overview.devices.active} / ${overview.devices.capacity}` : "—"} />
          <MetricCard label="Devices over capacity" value={overview.devices?.over_capacity ?? "—"} />
          <MetricCard label="Support grants" value={overview.members?.admin_grants ?? "—"} />

          <MetricCard label="VPN enabled" value={overview.vpn.enabled} />
          <MetricCard label="VPN disabled" value={overview.vpn.disabled} />
          <MetricCard label="Traffic this month" value={bytes(overview.usage.month_total_bytes)} />
          <MetricCard label="Current ↓ / ↑" value={`${mbps(overview.usage.download_bps)} / ${mbps(overview.usage.upload_bps)}`} />

          <MetricCard label="Nodes online" value={overview.nodes.online} />
          <MetricCard label="Nodes offline" value={overview.nodes.offline} />
          <MetricCard label="Jobs pending" value={overview.jobs.pending} />
          <MetricCard label="Jobs failed" value={overview.jobs.failed} />

          <MetricCard label="Open alerts" value={overview.alerts.open} />
          <MetricCard label="Abuse flags" value={overview.abuse.open} />
        </div>
      )}
    </AdminShell>
  );
}
