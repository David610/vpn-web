"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import type { LinkClient, VpnLink } from "@/components/account/links";
import { ConfirmDialog } from "@/components/Dialog";
import { api, newIdempotencyKey, relative } from "@/lib/api";

type Detail = { link: VpnLink; clients: LinkClient[] };

function LinkDetailBody() {
  const { session, overview } = useAccount();
  const id = useSearchParams().get("id") ?? "";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [replayed, setReplayed] = useState(false);
  const [revokeLink, setRevokeLink] = useState(false);
  const [revokeClient, setRevokeClient] = useState<LinkClient | null>(null);
  const idem = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (!id) { setError("A Link id is required."); return; }
    try { setDetail(await api<Detail>(session, `/api/account/links/${encodeURIComponent(id)}`)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load Link."); }
  }, [id, session]);
  useEffect(() => { void load(); return () => { setSecret(null); idem.current = null; }; }, [load]);

  async function addClient(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(null); setSecret(null); setReplayed(false);
    if (!idem.current) idem.current = newIdempotencyKey();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ configurationUrl?: string; replayed?: boolean }>(session, `/api/account/links/${encodeURIComponent(id)}/clients`, {
        body: { name: String(form.get("name") ?? "").trim(), clientType: String(form.get("clientType")), subscriptionId: String(form.get("subscriptionId")) },
        headers: { "Idempotency-Key": idem.current },
      });
      setReplayed(Boolean(result.replayed));
      if (!result.replayed && result.configurationUrl) setSecret(result.configurationUrl);
      idem.current = null; (event.currentTarget as HTMLFormElement).reset(); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not add client."); }
    finally { setBusy(false); }
  }
  async function rotate(client: LinkClient) {
    setBusy(true); setError(null);
    try { await api(session, `/api/account/external-devices/${client.id}/credential`, { method: "POST" }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not replace configuration."); } finally { setBusy(false); }
  }
  async function removeClient() {
    if (!revokeClient) return; setBusy(true);
    try { await api(session, `/api/account/external-devices/${revokeClient.id}/revoke`, { method: "POST" }); setRevokeClient(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not revoke client."); } finally { setBusy(false); }
  }
  async function removeLink() {
    setBusy(true); try { await api(session, `/api/account/links/${encodeURIComponent(id)}`, { method: "DELETE" }); setRevokeLink(false); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not revoke Link."); } finally { setBusy(false); }
  }
  if (error && !detail) return <p className="notice notice--error">{error}</p>;
  if (!detail) return <p className="muted">Loading…</p>;
  const active = detail.clients.filter(c => c.status === "active");
  return <>
    {error && <p className="notice notice--error" role="alert">{error}</p>}
    <dl className="detail-list"><div><dt>Status</dt><dd>{detail.link.status === "active" ? "Active" : "Revoked"}</dd></div><div><dt>Route</dt><dd>{detail.link.routeId}</dd></div><div><dt>Clients</dt><dd>{detail.link.clientCount} / {detail.link.maxClients}</dd></div><div><dt>Family</dt><dd>Compatible VPN apps</dd></div><div><dt>Usage</dt><dd>No usage data yet</dd></div></dl>
    {secret && <section className="secret-result" aria-labelledby="configuration-heading"><h2 id="configuration-heading">Configuration created</h2><p><strong>This configuration grants VPN access. Keep it private.</strong></p><p>Copy it now. Arcana will not show this value again after you leave this screen.</p><input className="field secret-value" readOnly value={secret} onFocus={e => e.currentTarget.select()} aria-label="One-time configuration URL" /></section>}
    {replayed && <p className="notice" role="status">The original request already succeeded. For your security, its one-time configuration is not shown again.</p>}
    {detail.link.status === "active" && <section className="block"><div className="block__head"><h2 className="block__title">Add client</h2></div><form onSubmit={addClient} className="form-grid" style={{ marginTop: "var(--space-4)" }}><div><label className="field-label" htmlFor="client-name">Name</label><input className="field" id="client-name" name="name" maxLength={40} required /></div><div><label className="field-label" htmlFor="client-subscription">Subscription</label><select className="field select" id="client-subscription" name="subscriptionId" required><option value="">Choose subscription</option>{overview?.subscriptions.filter(s => s.status !== "canceled").map(s => <option key={s.id} value={s.id}>{s.name} · {s.used}/{s.capacity} devices</option>)}</select></div><input type="hidden" name="clientType" value="links" /><div><button className="btn btn-primary" disabled={busy || detail.link.clientCount >= detail.link.maxClients}>{busy ? "Adding…" : "Add client"}</button></div></form></section>}
    <section className="block"><div className="block__head"><h2 className="block__title">Clients</h2></div><p className="muted">Replacing a configuration starts a bounded overlap while nodes receive it; the previous configuration then stops working.</p>{detail.clients.length === 0 ? <p className="muted">No clients yet.</p> : <ul className="rows">{detail.clients.map(client => <li className="row" key={client.id}><div><p className="row__title">{client.name}</p><p className="row__sub">Compatible VPN app · {client.status === "active" ? "Active" : "Revoked"} · last configuration fetch {relative(client.lastSeenAt)}</p></div>{client.status === "active" && <div className="row__actions"><button className="btn-link" disabled={busy} onClick={() => rotate(client)}>Replace configuration</button><button className="btn-link text-danger" disabled={busy} onClick={() => setRevokeClient(client)}>Revoke</button></div>}</li>)}</ul>}</section>
    {detail.link.status === "active" && <section className="block danger-zone"><h2 className="block__title">Revoke Link</h2><p>Revoking this Link will stop exactly {active.length} active {active.length === 1 ? "client" : "clients"}.</p><button className="btn btn-danger" onClick={() => setRevokeLink(true)}>Revoke Link</button></section>}
    <p><Link className="text-link" href="/account/links/">Back to Links</Link></p>
    <ConfirmDialog open={Boolean(revokeClient)} title="Revoke client?" description={`Only “${revokeClient?.name ?? "this client"}” will lose VPN access.`} confirmLabel="Revoke client" danger busy={busy} onConfirm={removeClient} onCancel={() => setRevokeClient(null)} />
    <ConfirmDialog open={revokeLink} title="Revoke Link?" description={`Exactly ${active.length} active ${active.length === 1 ? "client" : "clients"} will stop working.`} confirmLabel="Revoke Link" danger busy={busy} onConfirm={removeLink} onCancel={() => setRevokeLink(false)} />
  </>;
}
export default function LinkDetailPage() { return <AccountShell eyebrow="Links" title="Link detail" sub="Manage clients and configurations."><LinkDetailBody /></AccountShell>; }
