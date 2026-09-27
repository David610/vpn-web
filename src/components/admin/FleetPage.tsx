"use client";

import { AdminShell } from "@/components/admin/AdminShell";
import { FleetTabs } from "@/components/admin/FleetTabs";
import { AdminNotice } from "@/components/admin/AdminPrimitives";

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
      <h1 className="mb-4 text-xl font-semibold text-fg">Fleet</h1>
      <FleetTabs />
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {note && <span className="text-xs text-fg-3">{note}</span>}
      </div>
      {error ? <AdminNotice tone="error">{error}</AdminNotice> : loading ? <p className="text-fg-2">Loading…</p> : children}
    </AdminShell>
  );
}

export function when(ts: string | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="border-t border-border py-4 text-sm text-fg-2">{children}</p>;
}
