"use client";

import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { Feedback, useAccount } from "@/components/account/AccountShell";
import { LIVE } from "@/components/account/types";
import { api } from "@/lib/api";

type Capability = { fast: string[]; privacy_plus: string[] };
type Route = {
  id: string;
  region: string;
  privacyClass: "fast" | "privacy_plus";
  displayName: string;
};
type ExternalDevice = {
  deviceId: string;
  name: string;
  status: string;
  subscriptionId: string | null;
  clientType: string;
  desiredRouteId: string;
  lastSubscriptionFetchAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};
type ExternalData = {
  devices: ExternalDevice[];
  routes: Route[];
  capabilities: Record<string, Capability>;
};
type Setup = { url: string; clientType: string; label: string };

const INSTRUCTIONS: Record<string, string> = {
  hiddify: "In Hiddify, add a new profile from a subscription URL and paste this link.",
  shadowrocket: "In Shadowrocket, add a subscription and paste this link as the subscription URL.",
  incy: "In INCY, add a VLESS subscription and paste this link.",
  singbox: "Use this URL as the source for the generated sing-box configuration.",
  xray: "Use this URL with your Xray-compatible subscription importer.",
  links: "Open this URL to retrieve the raw supported VLESS/Hysteria2 links.",
};

export function ExternalDevicesSection() {
  const { session, overview, reload } = useAccount();
  const [data, setData] = useState<ExternalData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [clientType, setClientType] = useState("");
  const [routeId, setRouteId] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  async function load() {
    try {
      const next = await api<ExternalData>(session, "/api/account/external-devices");
      setData(next);
      setLoadError(null);
      setClientType((current) => current || Object.keys(next.capabilities)[0] || "");
      const live = overview?.subscriptions.find((sub) => LIVE.has(sub.status));
      setSubscriptionId((current) => current || live?.id || "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load external devices.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    if (!setup) {
      setQr(null);
      return;
    }
    void QRCode.toDataURL(setup.url, { width: 220, margin: 1 }).then((url) => {
      if (!cancelled) setQr(url);
    }).catch(() => {
      if (!cancelled) setQr(null);
    });
    return () => { cancelled = true; };
  }, [setup]);

  const supportedRoutes = useMemo(() => {
    if (!data || !clientType) return [];
    return data.routes.filter((route) =>
      Boolean(data.capabilities[clientType]?.[route.privacyClass]?.length));
  }, [data, clientType]);

  useEffect(() => {
    if (!supportedRoutes.some((route) => route.id === routeId)) {
      setRouteId(supportedRoutes[0]?.id ?? "");
    }
  }, [supportedRoutes, routeId]);

  const liveSubscriptions = overview?.subscriptions.filter((sub) => LIVE.has(sub.status)) ?? [];
  const routeName = (id: string) => data?.routes.find((route) => route.id === id)?.displayName ?? id;

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim() || !clientType || !routeId || !subscriptionId) return;
    setBusy("create");
    setActionError(null);
    setNotice(null);
    try {
      const result = await api<{ deviceId: string; subscriptionUrl: string; shownOnce: boolean }>(
        session,
        "/api/account/external-devices",
        { body: { name: name.trim(), clientType, routeId, subscriptionId } }
      );
      setSetup({ url: result.subscriptionUrl, clientType, label: name.trim() });
      setName("");
      await Promise.all([load(), reload()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not create external device.");
    } finally {
      setBusy(null);
    }
  }

  async function rotateLink(device: ExternalDevice) {
    setBusy(device.deviceId + ":link");
    setActionError(null);
    setNotice(null);
    try {
      const result = await api<{ subscriptionUrl: string }>(
        session,
        `/api/account/external-devices/${device.deviceId}/token`,
        { method: "POST" }
      );
      setSetup({ url: result.subscriptionUrl, clientType: device.clientType, label: device.name });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not rotate subscription link.");
    } finally {
      setBusy(null);
    }
  }

  async function rotateCredential(device: ExternalDevice) {
    setBusy(device.deviceId + ":credential");
    setActionError(null);
    setNotice(null);
    try {
      await api(session, `/api/account/external-devices/${device.deviceId}/credential`, { method: "POST" });
      setNotice("VPN credential rotation started. The old credential remains bounded while the new one is loaded on the node.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not rotate VPN credential.");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(device: ExternalDevice) {
    if (!window.confirm(`Revoke “${device.name}”? This immediately removes its VPN authorization.`)) return;
    setBusy(device.deviceId + ":revoke");
    setActionError(null);
    setNotice(null);
    try {
      await api(session, `/api/account/external-devices/${device.deviceId}/revoke`, { method: "POST" });
      setNotice("External device revoked.");
      await Promise.all([load(), reload()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not revoke external device.");
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <div className="block">
        <div className="block__head"><h2 className="block__title">External VPN clients</h2></div>
        <p className="muted" style={{ marginTop: "var(--space-4)" }}>
          {loadError ?? "Loading…"}
        </p>
      </div>
    );
  }

  return (
    <div className="block">
      <div className="block__head">
        <div>
          <h2 className="block__title">External VPN clients</h2>
          <p className="muted" style={{ marginTop: "var(--space-1)" }}>
            Use Arcana with a supported third-party client. Privacy+ stays unavailable until that exact client topology is qualified.
          </p>
        </div>
      </div>

      {data.devices.length > 0 && (
        <ul className="rows" style={{ marginTop: "var(--space-4)" }}>
          {data.devices.map((device) => {
            const revoked = Boolean(device.revokedAt) || device.status === "REVOKED";
            return (
              <li className="row" key={device.deviceId}>
                <div>
                  <p className="row__title">{device.name}</p>
                  <p className="row__sub">
                    {device.clientType} · {routeName(device.desiredRouteId)} · {revoked ? "Revoked" : "Active"}
                    {device.lastSubscriptionFetchAt
                      ? ` · refreshed ${new Date(device.lastSubscriptionFetchAt).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                {!revoked && (
                  <div className="row__actions">
                    <button
                      type="button"
                      className="btn-link"
                      disabled={busy !== null}
                      onClick={() => void rotateLink(device)}
                    >
                      Rotate link
                    </button>
                    <button
                      type="button"
                      className="btn-link"
                      disabled={busy !== null}
                      onClick={() => void rotateCredential(device)}
                    >
                      Rotate VPN credential
                    </button>
                    <button
                      type="button"
                      className="btn-link text-danger"
                      disabled={busy !== null}
                      onClick={() => void revoke(device)}
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={create} style={{ marginTop: "var(--space-5)" }}>
        <div className="form-grid">
          <div>
            <label className="field-label" htmlFor="external-name">Device name</label>
            <input
              id="external-name"
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              required
              placeholder="e.g. Hiddify on iPhone"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="external-client">Client</label>
            <select
              id="external-client"
              className="field select"
              value={clientType}
              onChange={(e) => setClientType(e.target.value)}
              required
            >
              {Object.keys(data.capabilities).map((client) => (
                <option key={client} value={client}>{client}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="external-route">Region / mode</label>
            <select
              id="external-route"
              className="field select"
              value={routeId}
              onChange={(e) => setRouteId(e.target.value)}
              required
            >
              {supportedRoutes.length === 0 && <option value="">No supported routes</option>}
              {supportedRoutes.map((route) => (
                <option key={route.id} value={route.id}>
                  {route.displayName} · {route.privacyClass === "privacy_plus" ? "Privacy+" : "Fast"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="external-subscription">Subscription</label>
            <select
              id="external-subscription"
              className="field select"
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
              required
            >
              <option value="" disabled>Choose a subscription</option>
              {liveSubscriptions.map((sub) => (
                <option key={sub.id} value={sub.id}>
                  {sub.name} · {sub.used}/{sub.capacity} used
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy !== null || supportedRoutes.length === 0 || liveSubscriptions.length === 0}
          style={{ marginTop: "var(--space-4)" }}
        >
          {busy === "create" ? "Creating…" : "Add external device"}
        </button>
      </form>

      <Feedback error={actionError ?? loadError} />
      {notice && <p className="notice" style={{ marginTop: "var(--space-3)" }}>{notice}</p>}

      {setup && (
        <div className="notice" style={{ marginTop: "var(--space-4)" }}>
          <p className="row__title">Set up {setup.label}</p>
          <p className="row__sub" style={{ marginTop: "var(--space-2)" }}>
            This subscription link is shown only now. Arcana stores only its keyed hash and cannot recover it later.
          </p>
          <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "flex-start", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
            {qr && (
              // Generated locally in the browser. The bearer token is never sent to a QR service.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="Subscription QR code" width={220} height={220} />
            )}
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
              <label className="field-label" htmlFor="external-sub-url">Subscription URL</label>
              <input id="external-sub-url" className="field" value={setup.url} readOnly />
              <div className="row__actions" style={{ justifyContent: "flex-start", marginTop: "var(--space-2)" }}>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => void navigator.clipboard.writeText(setup.url)}
                >
                  Copy
                </button>
                <button type="button" className="btn-link" onClick={() => setSetup(null)}>
                  Done
                </button>
              </div>
              <p className="muted" style={{ marginTop: "var(--space-3)" }}>
                {INSTRUCTIONS[setup.clientType] ?? "Add this subscription URL in your VPN client."}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}