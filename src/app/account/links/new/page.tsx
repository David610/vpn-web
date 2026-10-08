"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import ChoiceGroup from "@/components/account/ChoiceGroup";
import { pickAutomaticRoute, type LocationChoice, type RouteOption, type Routing } from "@/components/account/links";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { firstClientName, isValidLinkName, subscriptionForFirstClient } from "@/lib/link-first-client";

const NAME_HINT = "Use letters, numbers, spaces and . _ ' ( ) - (up to 40 characters).";

type Created = { id: string; url: string };

function CreatedPanel({ created }: { created: Created }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <section className="created" aria-labelledby="created-heading">
      <h2 id="created-heading">Your VPN link is ready</h2>
      <p>Paste it into a compatible VPN client. Anyone with this link can connect, so keep it private.</p>
      <div className="linkfield linkfield--open">
        <code onClick={(e) => window.getSelection()?.selectAllChildren(e.currentTarget)}>{created.url}</code>
      </div>
      <p className="muted">You can copy this link again at any time from your VPN links.</p>
      <div className="form-actions">
        <button type="button" className="btn btn-primary btn-lg" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy link"}
        </button>
        <Link className="btn btn-secondary btn-lg" href="/account/">Done</Link>
      </div>
    </section>
  );
}

function NewLinkBody() {
  const { session, overview } = useAccount();
  const [routes, setRoutes] = useState<RouteOption[] | null>(null);
  const [name, setName] = useState("");
  const [routing, setRouting] = useState<Routing>("one");
  const [location, setLocation] = useState<LocationChoice>("auto");
  const [routeId, setRouteId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const submitted = useRef(false);

  useEffect(() => {
    let live = true;
    api<{ link_routes: RouteOption[] }>(session, "/api/account/external-devices")
      .then((data) => live && setRoutes(data.link_routes ?? []))
      .catch(() => live && setError("Locations are temporarily unavailable. Please try again shortly."));
    return () => {
      live = false;
    };
  }, [session]);

  const twoAvailable = useMemo(() => (routes ?? []).some((r) => r.privacy_class === "privacy_plus"), [routes]);
  const candidates = useMemo(
    () => (routes ?? []).filter((r) => (routing === "two" ? r.privacy_class === "privacy_plus" : r.privacy_class === "fast")),
    [routes, routing]
  );
  const noRoutes = routes !== null && candidates.length === 0;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitted.current) return;
    setError(null);
    const trimmed = name.trim();
    if (!isValidLinkName(trimmed)) {
      setError(trimmed ? `That name is not allowed. ${NAME_HINT}` : "Give your link a name.");
      return;
    }
    const route = location === "auto" ? pickAutomaticRoute(candidates) : candidates.find((r) => r.id === routeId) ?? null;
    if (!route) {
      setError(location === "auto" ? "No location is available right now." : "Choose a location.");
      return;
    }
    const subscription = subscriptionForFirstClient(overview?.subscriptions ?? []);
    if (!subscription) {
      setError("You have no free device place. Revoke a link you no longer use, or check your plan.");
      return;
    }
    submitted.current = true;
    setBusy(true);
    let linkId: string | null = null;
    try {
      const link = await api<{ id: string }>(session, "/api/account/links", {
        body: { name: trimmed, routeId: route.id, maxClients: 1, locationMode: location },
      });
      linkId = link.id;
      const client = await api<{ configurationUrl?: string }>(session, `/api/account/links/${encodeURIComponent(link.id)}/clients`, {
        body: { name: firstClientName(trimmed), clientType: "links", subscriptionId: String(subscription.id) },
        headers: { "Idempotency-Key": newIdempotencyKey() },
      });
      if (!client.configurationUrl) throw new Error("The link was created but could not be shown. Open it from your VPN links.");
      setCreated({ id: link.id, url: client.configurationUrl });
    } catch (err) {
      // An empty link is clutter and uses no place; remove it so the user can simply retry.
      if (linkId && !(err instanceof Error && err.message.startsWith("The link was created"))) {
        await api(session, `/api/account/links/${encodeURIComponent(linkId)}`, { method: "DELETE" }).catch(() => undefined);
      }
      submitted.current = false;
      setBusy(false);
      setError(
        err instanceof ApiError && err.code === "capacity_exhausted"
          ? "You have no free device place. Revoke a link you no longer use, or check your plan."
          : err instanceof Error ? err.message : "Could not create the link."
      );
    }
  }

  if (created) return <CreatedPanel created={created} />;

  return (
    <form onSubmit={submit} className="create-form" noValidate>
      <div className="field-group">
        <label className="field-label" htmlFor="link-name">Link name</label>
        <input
          className="field"
          id="link-name"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          placeholder="My phone"
          autoComplete="off"
          aria-describedby="link-name-hint"
          aria-invalid={error && !isValidLinkName(name) ? "true" : undefined}
        />
        <p className="field-hint" id="link-name-hint">{NAME_HINT}</p>
      </div>

      <ChoiceGroup<Routing>
        legend="Routing"
        name="routing"
        variant="cards"
        value={routing}
        onChange={setRouting}
        options={[
          { value: "one", title: "1 server", text: "Connect through one server." },
          {
            value: "two",
            title: "2 servers",
            text: "Connect through two servers for extra privacy.",
            disabled: !twoAvailable,
            note: "Not available yet for compatible VPN clients.",
          },
        ]}
      />

      <ChoiceGroup<LocationChoice>
        legend="Location"
        name="location"
        variant="cards"
        value={location}
        onChange={setLocation}
        options={[
          { value: "auto", title: "Automatic", text: "Arcana selects an available location for you." },
          { value: "manual", title: "Choose location", text: "Select a specific country or server." },
        ]}
      />

      {location === "manual" ? (
        <div className="field-group">
          <label className="field-label" htmlFor="link-route">Country or server</label>
          <select className="field select" id="link-route" value={routeId} onChange={(e) => setRouteId(e.target.value)} disabled={!routes}>
            <option value="">{routes ? "Choose a location" : "Loading…"}</option>
            {candidates.map((r) => (
              <option key={r.id} value={r.id}>{r.display_name}</option>
            ))}
          </select>
        </div>
      ) : (
        <p className="muted">Arcana selects an available location for you.</p>
      )}

      {noRoutes ? <p className="notice" role="status">No locations are available for this routing right now.</p> : null}
      {error ? <p className="notice notice--error" role="alert">{error}</p> : null}

      <div className="form-actions form-actions--stack">
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !routes || noRoutes}>
          {busy ? "Creating…" : "Create link"}
        </button>
        <Link className="btn btn-secondary btn-lg" href="/account/">Cancel</Link>
      </div>
      <p className="muted form-note">Works with compatible VPN clients.</p>
    </form>
  );
}

export default function NewLinkPage() {
  return (
    <AccountShell title="Create VPN link" sub="Choose how your VPN connects." back={{ href: "/account/", label: "Back" }} narrow>
      <NewLinkBody />
    </AccountShell>
  );
}
