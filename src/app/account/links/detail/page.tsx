"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import { bytes, type LinkClient, type VpnLink } from "@/components/account/links";
import UsageChart, { dailyTotals, type UsageRow } from "@/components/account/UsageChart";
import { ConfirmDialog } from "@/components/Dialog";
import { api, newIdempotencyKey, relative } from "@/lib/api";

type Detail = { link: VpnLink; clients: LinkClient[] };
const TABS = ["Overview", "Configuration", "Clients", "Traffic", "Settings"] as const;
type Tab = (typeof TABS)[number];

function LinkDetailBody() {
  const { session, overview } = useAccount();
  const id = useSearchParams().get("id") ?? "";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [tab, setTab] = useState<Tab>("Overview");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [replayed, setReplayed] = useState(false);
  const [revokeLink, setRevokeLink] = useState(false);
  const [revokeClient, setRevokeClient] = useState<LinkClient | null>(null);
  const idem = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (!id) { setError("A Link id is required."); return; }
    try { const loaded = await api<Detail>(session, `/api/account/links/${encodeURIComponent(id)}`); setDetail(loaded); setError(null); if (loaded.clients.length === 0 && loaded.link.status === "active") setTab("Clients"); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load Link."); }
  }, [id, session]);
  useEffect(() => { void load(); return () => { setSecret(null); idem.current = null; }; }, [load]);
  useEffect(() => {
    let live = true;
    api<{ usage: UsageRow[] }>(session, "/api/account/links/usage")
      .then((u) => { if (live) setUsage(u.usage.filter((r) => String(r.link_id) === id)); })
      .catch(() => { if (live) setUsage([]); });
    return () => { live = false; };
  }, [session, id]);
  const days = useMemo(() => dailyTotals(usage), [usage]);
  const total = days.reduce((sum, d) => sum + d.bytes, 0);

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
      if (!result.replayed && result.configurationUrl) { setSecret(result.configurationUrl); setTab("Configuration"); }
      idem.current = null; (event.currentTarget as HTMLFormElement).reset(); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not add client."); }
    finally { setBusy(false); }
  }
  async function rotate(client: LinkClient) {
    setBusy(true); setError(null);
    try { const result = await api<{ subscriptionUrl: string }>(session, `/api/account/links/${encodeURIComponent(id)}/clients/${encodeURIComponent(client.id)}/replace-link`, { method: "POST" }); setCopied(false); setSecret(result.subscriptionUrl); setTab("Configuration"); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not replace access link."); } finally { setBusy(false); }
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
  const { link } = detail;
  const isActive = link.status === "active";
  const active = detail.clients.filter(c => c.status === "active");

  return <>
    <nav className="crumbs" aria-label="Breadcrumb"><Link href="/account/links/">Links</Link> <span aria-hidden="true">›</span> {link.name}</nav>
    <div className="detail-head">
      <h1 className="area__title">{link.name} <span className={`status status--sm${isActive ? "" : " status--off"}`}>{isActive ? "Active" : "Revoked"}</span></h1>
      {isActive && <button type="button" className="btn btn-secondary" onClick={() => setRevokeLink(true)}>Revoke</button>}
    </div>
    <div className="page-tabs" role="tablist" aria-label="Link sections">
      {TABS.map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>)}
    </div>
    {error && <p className="notice notice--error" role="alert">{error}</p>}

    {tab === "Overview" && <div className="split split--wide">
      <dl className="detail-list detail-list--card">
        <div><dt>Type</dt><dd>Compatible VPN apps</dd></div>
        <div><dt>Route</dt><dd>{link.routeLabel ?? link.routeId}</dd></div>
        <div><dt>Created</dt><dd>{new Date(link.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</dd></div>
        <div><dt>Clients</dt><dd>{link.clientCount} / {link.maxClients}</dd></div>
      </dl>
      <section className="panel-lite">
        <div className="panel-lite__head"><h2>Traffic (30 days)</h2><span className="card__value card__value--sm">{total > 0 ? bytes(total) : "No usage yet"}</span></div>
        <UsageChart days={days} width={440} />
      </section>
    </div>}

    {tab === "Configuration" && <>
      {secret && <section className="secret-result" aria-labelledby="configuration-heading"><h2 id="configuration-heading">Access link created</h2><p><strong>This link grants VPN access. Keep it private.</strong></p><p>Copy it now. Arcana will not show this value again after you leave this screen.</p><input className="field secret-value" readOnly value={secret} onFocus={e => e.currentTarget.select()} aria-label="One-time configuration URL" /><button className="btn btn-secondary" type="button" onClick={async () => { await navigator.clipboard.writeText(secret); setCopied(true); }}>{copied ? "Copied" : "Copy access link"}</button></section>}
      {replayed && <p className="notice" role="status">The original request already succeeded. For your security, its one-time configuration is not shown again.</p>}
      <section className="panel-lite">
        <h2>Connection details</h2>
        <p className="muted">Each client has its own access link. Arcana shows it once, when you create or replace it. Replace an access link if it was shared or lost; the old one stops working.</p>
        {active.length === 0 ? <p className="muted">No active clients yet.</p> : <ul className="mini-rows mini-rows--2">{active.map(client => <li key={client.id}><span className="mini-rows__name">{client.name}</span><span className="mini-rows__end"><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => rotate(client)}>Replace access link</button></span></li>)}</ul>}
      </section>
    </>}

    {tab === "Clients" && <>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Client</th><th scope="col">Last configuration fetch</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {detail.clients.length === 0 ? <tr><td colSpan={4} className="muted">No clients yet.</td></tr> : detail.clients.map(client => <tr key={client.id}>
              <td><span className="table__name">{client.name}</span></td>
              <td>{relative(client.lastSeenAt)}</td>
              <td><span className={`status${client.status === "active" ? "" : " status--off"}`}>{client.status === "active" ? "Active" : "Revoked"}</span></td>
              <td className="table__end">{client.status === "active" && <button className="btn-link text-danger" disabled={busy} onClick={() => setRevokeClient(client)}>Revoke</button>}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {isActive && <section className="panel-lite" style={{ marginTop: "var(--space-6)" }}><h2>Add client</h2><form onSubmit={addClient} className="form-grid"><div><label className="field-label" htmlFor="client-name">Name</label><input className="field" id="client-name" name="name" maxLength={40} required /></div><div><label className="field-label" htmlFor="client-subscription">Subscription</label><select className="field select" id="client-subscription" name="subscriptionId" required><option value="">Choose subscription</option>{overview?.subscriptions.filter(s => s.status !== "canceled").map(s => <option key={s.id} value={s.id}>{s.name} · {s.used}/{s.capacity} devices</option>)}</select></div><input type="hidden" name="clientType" value="links" /><div><button className="btn btn-primary" disabled={busy || link.clientCount >= link.maxClients}>{busy ? "Adding…" : "Add client"}</button></div></form></section>}
    </>}

    {tab === "Traffic" && <section className="panel-lite">
      <div className="panel-lite__head"><h2>Traffic (30 days)</h2><span className="card__value card__value--sm">{total > 0 ? bytes(total) : "No usage yet"}</span></div>
      <UsageChart days={days} />
    </section>}

    {tab === "Settings" && (isActive ? <section className="panel-lite danger-zone"><h2>Revoke Link</h2><p>Revoking this Link will stop exactly {active.length} active {active.length === 1 ? "client" : "clients"}.</p><button className="btn btn-danger" onClick={() => setRevokeLink(true)}>Revoke Link</button></section> : <p className="muted">This Link has been revoked.</p>)}

    <ConfirmDialog open={Boolean(revokeClient)} title="Revoke client?" description={`Only “${revokeClient?.name ?? "this client"}” will lose VPN access.`} confirmLabel="Revoke client" danger busy={busy} onConfirm={removeClient} onCancel={() => setRevokeClient(null)} />
    <ConfirmDialog open={revokeLink} title="Revoke Link?" description={`Exactly ${active.length} active ${active.length === 1 ? "client" : "clients"} will stop working.`} confirmLabel="Revoke Link" danger busy={busy} onConfirm={removeLink} onCancel={() => setRevokeLink(false)} />
  </>;
}
export default function LinkDetailPage() { return <AccountShell eyebrow="Links" title="" ><LinkDetailBody /></AccountShell>; }
