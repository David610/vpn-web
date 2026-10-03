"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import type { RouteOption, VpnLink } from "@/components/account/links";
import { api } from "@/lib/api";

function LinksBody() {
  const { session } = useAccount();
  const [links, setLinks] = useState<VpnLink[] | null>(null);
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ links: VpnLink[] }>(session, "/api/account/links"),
      api<{ routes: RouteOption[] }>(session, "/api/account/external-devices"),
    ]).then(([a, b]) => { if (live) { setLinks(a.links); setRoutes(b.routes ?? []); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load Links."); });
    return () => { live = false; };
  }, [session]);
  const routeName = (id: string) => routes.find((r) => r.id === id)?.display_name ?? "Unavailable route";
  if (error) return <p className="notice notice--error" role="alert">{error}</p>;
  if (!links) return <p className="muted">Loading…</p>;
  return <>
    <div className="block__head" style={{ marginBottom: "var(--space-6)" }}>
      <p className="muted">A Link itself uses no device capacity. Each active client uses one device.</p>
      <Link className="btn btn-primary" href="/account/links/new/">Create Link</Link>
    </div>
    {links.length === 0 ? <div className="empty-state"><h2>No Links yet</h2><p>Create a Link to connect compatible VPN apps.</p></div> :
      <ul className="rows">{links.map((item) => <li className="row" key={item.id}>
        <div><p className="row__title">{item.name}</p><p className="row__sub">
          {routeName(item.routeId)} · Compatible VPN apps · {item.clientCount}/{item.maxClients} active clients · {item.status === "active" ? "Active" : "Revoked"}
        </p><p className="row__sub">No usage data yet</p></div>
        <div className="row__actions"><Link className="text-link" href={`/account/links/detail/?id=${encodeURIComponent(item.id)}`}>Inspect</Link></div>
      </li>)}</ul>}
  </>;
}

export default function LinksPage() {
  return <AccountShell eyebrow="Account" title="Links" sub="Configurations for compatible VPN apps, grouped by route."><LinksBody /></AccountShell>;
}
