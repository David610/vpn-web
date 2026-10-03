"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import type { RouteOption } from "@/components/account/links";
import { api } from "@/lib/api";

function NewLinkBody() {
  const { session, overview } = useAccount();
  const router = useRouter();
  const [routes, setRoutes] = useState<RouteOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitted = useRef(false);
  useEffect(() => { api<{ routes: RouteOption[] }>(session, "/api/account/external-devices")
    .then(data => setRoutes(data.routes ?? [])).catch(() => setError("Routes are temporarily unavailable.")); }, [session]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitted.current) return;
    submitted.current = true; setBusy(true); setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ id: string }>(session, "/api/account/links", { body: {
        name: String(form.get("name") ?? "").trim(), routeId: String(form.get("routeId") ?? ""),
        maxClients: Number(form.get("maxClients")),
      }});
      router.push(`/account/links/detail/?id=${encodeURIComponent(result.id)}`);
    } catch (e) { submitted.current = false; setBusy(false); setError(e instanceof Error ? e.message : "Could not create Link."); }
  }
  return <form onSubmit={submit} className="block" style={{ maxWidth: "36rem" }}>
    <div><label className="field-label" htmlFor="link-name">Name</label><input className="field" id="link-name" name="name" required minLength={1} maxLength={60} placeholder="Travel devices" /></div>
    <div style={{ marginTop: "var(--space-4)" }}><label className="field-label" htmlFor="link-route">Location / route</label><select className="field select" id="link-route" name="routeId" required disabled={!routes}><option value="">Choose an available route</option>{routes?.map(r => <option key={r.id} value={r.id}>{r.display_name}</option>)}</select></div>
    <div style={{ marginTop: "var(--space-4)" }}><label className="field-label" htmlFor="link-max">Maximum clients</label><input className="field" id="link-max" name="maxClients" type="number" min="1" max="100" defaultValue="1" required /></div>
    <p className="muted" style={{ marginTop: "var(--space-3)" }}>Compatible VPN apps only. The server enforces capacity; each client uses one of your {overview?.capacity.total ?? "available"} device places.</p>
    {error && <p className="notice notice--error" role="alert">{error}</p>}
    <button className="btn btn-primary" type="submit" disabled={busy || !routes}>{busy ? "Creating…" : "Create Link"}</button>
  </form>;
}
export default function NewLinkPage() { return <AccountShell eyebrow="Links" title="Create Link" sub="Choose a real available route and a client limit."><NewLinkBody /></AccountShell>; }
