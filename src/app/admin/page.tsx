"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { MetricCard } from "@/components/admin/MetricCard";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type Overview = {
  customers: { total: number; active: number; past_due: number; canceled: number };
  vpn: { accounts: number };
  jobs: { pending: number; claimed: number; failed: number };
  nodes: { online: number; offline: number };
};

export default function AdminOverviewPage() {
  const { session } = useAdminSession();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    adminFetch<Overview>("/api/admin/overview", session.access_token)
      .then(setOverview)
      .catch((err) => setError(err.message));
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
          <MetricCard label="Active customers" value={overview.customers.active} />
          <MetricCard label="Past due" value={overview.customers.past_due} />
          <MetricCard label="Canceled" value={overview.customers.canceled} />
          <MetricCard label="VPN accounts" value={overview.vpn.accounts} />
          <MetricCard label="Nodes online" value={overview.nodes.online} />
          <MetricCard label="Nodes offline" value={overview.nodes.offline} />
          <MetricCard label="Jobs pending" value={overview.jobs.pending} />
          <MetricCard label="Jobs failed" value={overview.jobs.failed} />
        </div>
      )}
    </AdminShell>
  );
}
