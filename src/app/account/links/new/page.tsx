"use client";

import { useEffect, useRef, useState } from "react";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import type { RouteOption } from "@/components/account/links";
import { api, newIdempotencyKey } from "@/lib/api";
import Link from "next/link";
import { firstClientName, subscriptionForFirstClient } from "@/lib/link-first-client";

function NewLinkBody() {
  const { session, overview } = useAccount();
    const [routes, setRoutes] = useState<RouteOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitted = useRef(false);
  const [created, setCreated] = useState<{ id: string; url: string | null; note: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api<{ link_routes: RouteOption[] }>(session, "/api/account/external-devices")
    .then(data => setRoutes(data.link_routes ?? [])).catch(() => setError("Routes are temporarily unavailable.")); }, [session]);
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
      const linkName = String(form.get("name") ?? "").trim();
      const subscription = subscriptionForFirstClient(overview?.subscriptions ?? []);
      if (!subscription) {
        setCreated({ id: result.id, url: null, note: "The Link is created, but none of your subscriptions has a free device place, so no access link was made. Free a place or add devices, then add a client on the Link." });
        return;
      }
      try {
        const client = await api<{ configurationUrl?: string }>(session, `/api/account/links/${encodeURIComponent(result.id)}/clients`, {
          body: { name: firstClientName(linkName), clientType: "links", subscriptionId: String(subscription.id) },
          headers: { "Idempotency-Key": newIdempotencyKey() },
        });
        setCreated({ id: result.id, url: client.configurationUrl ?? null, note: client.configurationUrl ? null : "The Link is created. Open it and add a client to get its access link." });
      } catch (clientError) {
        setCreated({ id: result.id, url: null, note: `The Link is created, but its access link could not be made (${clientError instanceof Error ? clientError.message : "unknown error"}). Open the Link and add a client.` });
      }
    } catch (e) { submitted.current = false; setBusy(false); setError(e instanceof Error ? e.message : "Could not create Link."); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); }
  }
  if (created) {
    return (
      <section className="secret-result" aria-labelledby="created-heading">
        <h2 id="created-heading">{created.url ? "Your access link" : "Link created"}</h2>
        {created.url ? <>
          <p><strong>This link grants VPN access. Keep it private.</strong></p>
          <p>Copy it now and paste it into your VPN app. Arcana shows it once; if you lose it, replace it from the Link&apos;s Configuration tab.</p>
          <input className="field secret-value" readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} aria-label="Access link" />
          <button className="btn btn-primary" type="button" onClick={() => void copy(created.url!)}>{copied ? "Copied" : "Copy access link"}</button>
        </> : <p>{created.note}</p>}
        <p style={{ marginTop: "var(--space-4)" }}><Link className="text-link" href={`/account/links/detail/?id=${encodeURIComponent(created.id)}`}>Open Link</Link></p>
      </section>
    );
  }
  return (
    <form onSubmit={submit} className="form-card">
      <div>
        <label className="field-label" htmlFor="link-name">Name</label>
        <input className="field" id="link-name" name="name" required minLength={1} maxLength={60} placeholder="Office router" />
      </div>
      <fieldset className="type-cards">
        <legend className="field-label">Type</legend>
        <label className="type-card type-card--on">
          <input type="radio" name="type" value="compatibility" checked readOnly />
          <span>
            <strong>Compatible VPN apps</strong>
            <span className="muted">For third-party VPN apps that use an access link</span>
          </span>
        </label>
      </fieldset>
      <div>
        <label className="field-label" htmlFor="link-route">Location / route</label>
        <select className="field select" id="link-route" name="routeId" required disabled={!routes}>
          <option value="">Choose an available route</option>
          {routes?.map(r => <option key={r.id} value={r.id}>{r.display_name}</option>)}
        </select>
      </div>
      <div>
        <label className="field-label" htmlFor="link-max">Device limit</label>
        <input className="field" id="link-max" name="maxClients" type="number" min="1" max="100" defaultValue="1" required />
        <p className="muted form-card__hint">
          This Link will count towards your plan. The server enforces capacity; each client uses one of your {overview?.capacity.total ?? "available"} device places.
        </p>
      </div>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy || !routes}>{busy ? "Creating…" : "Create link"}</button>
    </form>
  );
}

export default function NewLinkPage() {
  return (
    <AccountShell
      eyebrow="Links"
      title="Create a new link"
      sub="Set up a VPN link for a compatible app."
      crumbs={[{ label: "Links", href: "/account/links/" }, { label: "New" }]}
    >
      <NewLinkBody />
    </AccountShell>
  );
}
