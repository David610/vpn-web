"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";

type Customer = {
  userId: string;
  email: string | null;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  vpnAccountId: number | null;
  nodeId: string | null;
  enabled: boolean | null;
};

export default function AdminCustomersPage() {
  const { session } = useAdminSession();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!session) return;
    const url = q ? `/api/admin/customers?q=${encodeURIComponent(q)}` : "/api/admin/customers";
    fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((res) => res.json())
      .then((body) => setCustomers(body.customers));
  }, [session, q]);

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Customers</h1>
      <input
        className="mb-4 w-full max-w-sm rounded border px-3 py-2"
        placeholder="Search by email, user id, or VPN user id"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {!customers ? (
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">Customer</th>
              <th>Subscription</th>
              <th>VPN</th>
              <th>Node</th>
              <th>Period ends</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.userId} className="border-b">
                <td className="py-2">
                  <Link href={`/admin/customers/${c.userId}`} className="text-blue-600 hover:underline">
                    {c.email ?? c.userId}
                  </Link>
                </td>
                <td><StatusBadge status={c.subscriptionStatus} /></td>
                <td>{c.vpnAccountId ? <StatusBadge status={c.enabled ? "active" : "canceled"} /> : "—"}</td>
                <td>{c.nodeId ?? "—"}</td>
                <td>{c.currentPeriodEnd ? new Date(c.currentPeriodEnd).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
