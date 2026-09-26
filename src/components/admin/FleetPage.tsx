"use client";

import { AdminShell } from "@/components/admin/AdminShell";
import { FleetTabs } from "@/components/admin/FleetTabs";

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
      <h1 className="mb-4 text-xl font-semibold">Fleet</h1>
      <FleetTabs />
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {note && <span className="text-xs text-gray-600">{note}</span>}
      </div>
      {error ? <p className="text-red-600">{error}</p> : loading ? <p>Loading…</p> : children}
    </AdminShell>
  );
}

export function when(ts: string | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="border-t border-gray-300 py-4 text-sm text-gray-600">{children}</p>;
}
