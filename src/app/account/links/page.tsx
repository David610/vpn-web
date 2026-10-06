"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import { bytes, type VpnLink } from "@/components/account/links";
import type { UsageRow } from "@/components/account/UsageChart";
import { api } from "@/lib/api";

function LinksBody() {
  const { session } = useAccount();
  const [links, setLinks] = useState<VpnLink[] | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ links: VpnLink[] }>(session, "/api/account/links"),
      api<{ usage: UsageRow[] }>(session, "/api/account/links/usage").catch(() => ({ usage: [] as UsageRow[] })),
    ])
      .then(([a, b]) => { if (live) { setLinks(a.links); setUsage(b.usage); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load Links."); });
    return () => { live = false; };
  }, [session]);

  const traffic = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of usage) totals.set(String(r.link_id), (totals.get(String(r.link_id)) ?? 0) + Number(r.rx_bytes) + Number(r.tx_bytes));
    return totals;
  }, [usage]);
  const shown = (links ?? []).filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase()));

  if (error) return <p className="notice notice--error" role="alert">{error}</p>;
  if (!links) return <p className="muted">Loading…</p>;
  if (links.length === 0) {
    return (
      <div className="empty-card">
        <h2>No Links yet</h2>
        <p>Create a Link to connect compatible VPN apps.</p>
      </div>
    );
  }
  return (
    <>
      <label className="searchbar">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M14 14l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input type="search" placeholder="Search links…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search links" />
      </label>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Route</th>
              <th scope="col">Clients</th>
              <th scope="col">Traffic (30 days)</th>
              <th scope="col">Status</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <tr key={item.id}>
                <td><span className="table__name">{item.name}</span></td>
                <td>{item.routeLabel ?? "Unavailable route"}</td>
                <td>{item.clientCount} / {item.maxClients}</td>
                <td>{bytes(traffic.get(item.id) ?? 0)}</td>
                <td><span className={`status${item.status === "active" ? "" : " status--off"}`}>{item.status === "active" ? "Active" : "Revoked"}</span></td>
                <td className="table__end">
                  <Link className="text-link" href={`/account/links/detail/?id=${encodeURIComponent(item.id)}`}>Inspect</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginTop: "var(--space-4)" }}>A Link itself uses no device capacity. Each active client uses one device.</p>
    </>
  );
}

export default function LinksPage() {
  return (
    <AccountShell
      eyebrow="Account"
      title="Links"
      sub="Create and manage VPN links for compatible apps."
      action={<Link className="btn btn-primary" href="/account/links/new/">Create new link</Link>}
    >
      <LinksBody />
    </AccountShell>
  );
}
