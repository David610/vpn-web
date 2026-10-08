"use client";

import { AdminShell } from "@/components/admin/AdminShell";
import { FleetTabs } from "@/components/admin/FleetTabs";
import { AdminNotice, AdminPage } from "@/components/admin/AdminPrimitives";

/** Shared frame for the Fleet tab pages. */
export function FleetPage({
  title,
  note,
  error,
  loading,
  children,
}: {
  title: string;
  note?: string;
  error: string | null;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <AdminShell>
      <AdminPage eyebrow="Fleet" title="Servers" description={note ? `${title} · ${note}` : title}>
        <FleetTabs />
        {error ? <AdminNotice tone="error">{error}</AdminNotice> : loading ? <p className="text-fg-2">Loading…</p> : children}
      </AdminPage>
    </AdminShell>
  );
}

export function when(ts: string | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="border-t border-border py-4 text-sm text-fg-2">{children}</p>;
}
