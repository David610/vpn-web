"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import { maskedLink, useAccessLink } from "@/components/account/AccessLink";
import ChoiceGroup from "@/components/account/ChoiceGroup";
import {
  configurationDetail,
  configurationSummary,
  pickAutomaticRoute,
  routingOf,
  type LinkClient,
  type LocationChoice,
  type RouteOption,
  type Routing,
  type VpnLink,
} from "@/components/account/links";
import { ConfirmDialog } from "@/components/Dialog";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { firstClientName, subscriptionForFirstClient } from "@/lib/link-first-client";

type Detail = { link: VpnLink; clients: LinkClient[] };
type Replacement = { id: string; url: string; oldRevoked: boolean };

function ReplacementPanel({ replacement }: { replacement: Replacement }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  return (
    <section className="created" aria-labelledby="replacement-heading">
      <h2 id="replacement-heading">Your new link is ready</h2>
      <p>Update it in your VPN client. Anyone with this link can connect, so keep it private.</p>
      <div className="linkfield linkfield--open">
        <code onClick={(e) => window.getSelection()?.selectAllChildren(e.currentTarget)}>{replacement.url}</code>
      </div>
      {replacement.oldRevoked ? (
        <p className="muted">The previous link no longer works.</p>
      ) : (
        <p className="notice notice--error" role="alert">
          The new link works, but the previous link could not be revoked. Revoke it from your VPN links so it stops working.
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(replacement.url);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button type="button" className="btn btn-secondary btn-lg" onClick={() => router.replace(`/account/links/detail/?id=${encodeURIComponent(replacement.id)}`)}>
          Open link
        </button>
      </div>
    </section>
  );
}

function LinkDetailBody() {
  const { session, overview } = useAccount();
  const router = useRouter();
  const id = useSearchParams().get("id") ?? "";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [routes, setRoutes] = useState<RouteOption[] | null>(null);
  const [routing, setRouting] = useState<Routing>("one");
  const [location, setLocation] = useState<LocationChoice>("auto");
  const [routeId, setRouteId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"revoke" | "replace" | "move" | null>(null);
  const [replacement, setReplacement] = useState<Replacement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setError("A link id is required.");
      return;
    }
    try {
      const loaded = await api<Detail>(session, `/api/account/links/${encodeURIComponent(id)}`);
      setDetail(loaded);
      setRouting(routingOf({ privacy_class: loaded.link.privacyClass ?? "fast" }));
      setLocation(loaded.link.locationMode);
      setRouteId(loaded.link.routeId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this link.");
    }
  }, [id, session]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let live = true;
    api<{ link_routes: RouteOption[] }>(session, "/api/account/external-devices")
      .then((data) => live && setRoutes(data.link_routes ?? []))
      .catch(() => live && setRoutes([]));
    return () => {
      live = false;
    };
  }, [session]);

  const activeClients = useMemo(() => (detail?.clients ?? []).filter((c) => c.status === "active"), [detail]);
  const primaryClientId = activeClients[0]?.id ?? null;
  const access = useAccessLink(session, id, primaryClientId);

  const candidates = useMemo(
    () => (routes ?? []).filter((r) => (routing === "two" ? r.privacy_class === "privacy_plus" : r.privacy_class === "fast")),
    [routes, routing]
  );
  const twoAvailable = (routes ?? []).some((r) => r.privacy_class === "privacy_plus") || detail?.link.privacyClass === "privacy_plus";

  if (replacement) return <ReplacementPanel replacement={replacement} />;
  if (error && !detail) return <p className="notice notice--error" role="alert">{error}</p>;
  if (!detail) return <p className="muted">Loading…</p>;

  const { link } = detail;
  const isActive = link.status === "active";
  if (!isActive) {
    return (
      <>
        <h1 className="ps-title">{link.name}</h1>
        <p className="muted">This link has been revoked and no longer works.</p>
      </>
    );
  }

  const initialRouting = routingOf({ privacy_class: link.privacyClass ?? "fast" });
  const changed =
    routing !== initialRouting ||
    location !== link.locationMode ||
    (location === "manual" && routeId !== link.routeId);
  const needsRoute = location === "manual" && !candidates.some((r) => r.id === routeId);

  async function createClientFor(linkId: string, name: string): Promise<string> {
    const subscription = subscriptionForFirstClient(overview?.subscriptions ?? []);
    if (!subscription) throw new ApiError("You have no free device place. Revoke a link you no longer use, or check your plan.", 409, "capacity_exhausted");
    const client = await api<{ configurationUrl?: string }>(session, `/api/account/links/${encodeURIComponent(linkId)}/clients`, {
      body: { name: firstClientName(name), clientType: "links", subscriptionId: String(subscription.id) },
      headers: { "Idempotency-Key": newIdempotencyKey() },
    });
    if (!client.configurationUrl) throw new Error("The link was created but could not be shown.");
    return client.configurationUrl;
  }

  async function addAccessLink() {
    setBusy(true);
    setError(null);
    try {
      const url = await createClientFor(link.id, link.name);
      await load();
      access.adopt(url);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "capacity_exhausted" ? "You have no free device place. Revoke a link you no longer use, or check your plan." : err instanceof Error ? err.message : "Could not create an access link.");
    } finally {
      setBusy(false);
    }
  }

  async function replaceAccess() {
    if (!primaryClientId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ subscriptionUrl: string }>(
        session,
        `/api/account/links/${encodeURIComponent(link.id)}/clients/${encodeURIComponent(primaryClientId)}/replace-link`,
        { method: "POST" }
      );
      access.adopt(result.subscriptionUrl);
      setNotice("New link ready. The old link no longer works.");
      setConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not replace this link.");
    } finally {
      setBusy(false);
    }
  }

  async function moveToNewRoute() {
    const route = location === "auto" ? pickAutomaticRoute(candidates) : candidates.find((r) => r.id === routeId) ?? null;
    if (!route) {
      setError("Choose a location.");
      setConfirm(null);
      return;
    }
    setBusy(true);
    setError(null);
    let newId: string | null = null;
    try {
      const created = await api<{ id: string }>(session, "/api/account/links", {
        body: { name: link.name, routeId: route.id, maxClients: 1, locationMode: location },
      });
      newId = created.id;
      const url = await createClientFor(created.id, link.name);
      let oldRevoked = true;
      try {
        await api(session, `/api/account/links/${encodeURIComponent(link.id)}`, { method: "DELETE" });
      } catch {
        oldRevoked = false;
      }
      setConfirm(null);
      setReplacement({ id: created.id, url, oldRevoked });
    } catch (err) {
      if (newId) await api(session, `/api/account/links/${encodeURIComponent(newId)}`, { method: "DELETE" }).catch(() => undefined);
      setConfirm(null);
      setError(err instanceof Error ? err.message : "Could not change this link.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await api(session, `/api/account/links/${encodeURIComponent(link.id)}`, { method: "DELETE" });
      router.replace("/account/");
    } catch (err) {
      setConfirm(null);
      setError(err instanceof Error ? err.message : "Could not revoke this link.");
      setBusy(false);
    }
  }

  const shown = access.state === "revealed" && access.url ? access.url : maskedLink();

  return (
    <>
      <div className="detail-title">
        <h1 className="ps-title">{link.name}</h1>
        <p className="ps-sub">VPN link <span aria-hidden="true">•</span> {configurationSummary(link).replace(" · ", " • ")}</p>
        <p className="muted">{configurationDetail(link)}</p>
      </div>

      <section className="detail-block" aria-labelledby="access-heading">
        <h2 id="access-heading" className="detail-block__title">Your HTTPS access link</h2>
        {primaryClientId ? (
          <>
            <div className="access-row">
              <div className={`linkfield${access.state === "revealed" ? " linkfield--open" : ""}`}>
                <code aria-label={access.state === "revealed" ? "Your HTTPS access link" : "Access link hidden"}>{shown}</code>
              </div>
              <button type="button" className="btn btn-primary" onClick={() => void access.copy()} disabled={access.state === "loading"}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 9h10v11H9zM5 15V4h10" />
                </svg>
                {access.copied ? "Copied" : "Copy link"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => (access.state === "revealed" ? access.hide() : void access.reveal())} disabled={access.state === "loading"}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
                  <circle cx="12" cy="12" r="3" />
                  {access.state === "revealed" ? <path d="M4 4l16 16" /> : null}
                </svg>
                {access.state === "loading" ? "…" : access.state === "revealed" ? "Hide" : "Reveal"}
              </button>
            </div>
            <p className="field-hint">Anyone with this link can connect. Keep it private.</p>
            {access.state === "unavailable" ? <p className="notice" role="status">{access.message}</p> : null}
            {access.state === "error" || (access.state === "revealed" && access.message) ? <p className="notice notice--error" role="alert">{access.message}</p> : null}
            {notice ? <p className="notice" role="status">{notice}</p> : null}
            <button type="button" className="btn-link" onClick={() => setConfirm("replace")}>Replace link</button>
            {activeClients.length > 1 ? <p className="muted">{activeClients.length} clients use this link; the first one is shown here.</p> : null}
          </>
        ) : (
          <div className="empty-inline">
            <p className="muted">This link has no access link yet.</p>
            <button type="button" className="btn btn-primary" onClick={() => void addAccessLink()} disabled={busy}>
              {busy ? "Creating…" : "Create access link"}
            </button>
          </div>
        )}
      </section>

      <section className="detail-block">
        <ChoiceGroup<Routing>
          legend="Routing"
          name="routing"
          variant="list"
          value={routing}
          onChange={(value) => {
            setRouting(value);
            setRouteId("");
          }}
          options={[
            { value: "one", title: "1 server", text: "Connect through a single server." },
            { value: "two", title: "2 servers", text: "Route your connection through two servers for extra privacy.", disabled: !twoAvailable, note: "Not available yet for compatible VPN clients." },
          ]}
        />
      </section>

      <section className="detail-block">
        <ChoiceGroup<LocationChoice>
          legend="Location"
          name="location"
          variant="list"
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
        ) : null}
      </section>

      {changed ? (
        <p className="notice" role="status">
          Saving changes creates a new link and revokes this one, so you will need to update your VPN client.
        </p>
      ) : null}
      {error ? <p className="notice notice--error" role="alert">{error}</p> : null}

      <div className="detail-actions">
        <div className="form-actions">
          <button type="button" className="btn btn-primary btn-lg" disabled={!changed || needsRoute || busy} onClick={() => setConfirm("move")}>
            Save changes
          </button>
          <Link className="btn btn-secondary btn-lg" href="/account/">Cancel</Link>
        </div>
        <button type="button" className="btn-link btn-link--danger" onClick={() => setConfirm("revoke")}>Revoke link</button>
      </div>

      <ConfirmDialog
        open={confirm === "move"}
        title="Create a new link?"
        description="Changing routing or location gives you a new link. This link stops working as soon as the new one is ready."
        confirmLabel="Create new link"
        busy={busy}
        onConfirm={moveToNewRoute}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "replace"}
        title="Replace this link?"
        description="You get a new link. The current link stops working immediately, so update it in your VPN client."
        confirmLabel="Replace link"
        busy={busy}
        onConfirm={replaceAccess}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "revoke"}
        title="Revoke this link?"
        description={`“${link.name}” stops working immediately and frees its device place. This cannot be undone.`}
        confirmLabel="Revoke link"
        danger
        busy={busy}
        onConfirm={revoke}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

export default function LinkDetailPage() {
  return (
    <AccountShell back={{ href: "/account/", label: "Your VPN links" }}>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <LinkDetailBody />
      </Suspense>
    </AccountShell>
  );
}
