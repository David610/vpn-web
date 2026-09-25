"use client";

import { useEffect, useState } from "react";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import { api } from "@/lib/api";
import type { Device, Subscription } from "@/components/account/types";

type Profile = { id: string; name: string; enabled: boolean };

function DeviceRow({
  device,
  subscriptions,
  profiles,
  assignment,
}: {
  device: Device;
  subscriptions: Subscription[];
  profiles: Profile[];
  assignment: { profileId: string } | null;
}) {
  const { session, reload } = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rename() {
    const name = window.prompt("Device name", device.name);
    if (!name || name === device.name) return;
    setBusy("rename");
    setError(null);
    try {
      await api(session, `/api/account/devices/${device.id}`, { method: "PATCH", body: { name } });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename this device.");
    } finally {
      setBusy(null);
    }
  }

  async function move(subscriptionId: string) {
    if (!subscriptionId || subscriptionId === device.subscriptionId) return;
    setBusy("move");
    setError(null);
    try {
      await api(session, `/api/account/devices/${device.id}`, { method: "PATCH", body: { subscriptionId } });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move this device.");
    } finally {
      setBusy(null);
    }
  }

  async function changeConnection(profileId: string) {
    if (!profileId || profileId === assignment?.profileId) return;
    setBusy("connection");
    setError(null);
    try {
      await api(session, `/api/account/devices/${device.id}/assignment`, { body: { profileId } });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change this device's connection.");
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!window.confirm(`Revoke ${device.name}? It will lose VPN access immediately.`)) return;
    setBusy("revoke");
    setError(null);
    try {
      await api(session, `/api/account/devices/${device.id}/revoke`, { method: "POST" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke this device.");
    } finally {
      setBusy(null);
    }
  }

  const revoked = device.status === "REVOKED";

  return (
    <li className="row" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--space-3)" }}>
          <div>
            <p className="row__title">{device.name}</p>
            <p className="row__sub">
              {device.platform} · {revoked ? "Revoked" : "Active"}
            </p>
          </div>
        </div>

        {!revoked && (
          <div className="form-grid" style={{ marginTop: "var(--space-3)" }}>
            <div>
              <label className="field-label" htmlFor={`sub-${device.id}`}>Subscription</label>
              <select
                id={`sub-${device.id}`}
                className="field select"
                value={device.subscriptionId ?? ""}
                disabled={busy !== null}
                onChange={(e) => move(e.target.value)}
              >
                <option value="" disabled>Choose a subscription</option>
                {subscriptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor={`conn-${device.id}`}>Connection</label>
              <select
                id={`conn-${device.id}`}
                className="field select"
                value={assignment?.profileId ?? ""}
                disabled={busy !== null || profiles.length === 0}
                onChange={(e) => changeConnection(e.target.value)}
              >
                <option value="" disabled>
                  {profiles.length === 0 ? "No connections yet" : "Choose a connection"}
                </option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.enabled && p.id !== assignment?.profileId}>
                    {p.name}{p.enabled ? "" : " (disabled)"}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="row__actions" style={{ justifyContent: "flex-start", marginTop: "var(--space-3)" }}>
          {!revoked && (
            <>
              <button type="button" className="btn-link" disabled={busy !== null} onClick={rename}>Rename</button>
              <button type="button" className="btn-link text-danger" disabled={busy !== null} onClick={revoke}>
                {busy === "revoke" ? "Revoking…" : "Revoke"}
              </button>
            </>
          )}
        </div>
        {error && <p className="field-error" style={{ marginTop: "var(--space-2)" }}>{error}</p>}
      </div>
    </li>
  );
}

function DevicesBody() {
  const { session, overview, error } = useAccount();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [assignments, setAssignments] = useState<Map<string, { profileId: string }>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [profilesData, devicesData] = await Promise.all([
          api<{ profiles: Profile[] }>(session, "/api/account/connection-profiles"),
          api<{ devices: Array<{ id: string; assignment: { profileId: string } | null }> }>(
            session,
            "/api/account/devices"
          ),
        ]);
        if (cancelled) return;
        setProfiles(profilesData.profiles);
        const map = new Map<string, { profileId: string }>();
        for (const d of devicesData.devices) {
          if (d.assignment) map.set(d.id, { profileId: d.assignment.profileId });
        }
        setAssignments(map);
      } catch {
        if (cancelled) return;
        setLoadError("Could not load connection assignments.");
        setProfiles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (error && !overview) return null;
  if (!overview || profiles === null) return <p className="muted">Loading…</p>;

  return (
    <>
      {loadError && <p className="notice notice--error">{loadError}</p>}
      {overview.devices.length === 0 ? (
        <p className="muted">No devices registered yet. Install Arcana on a device and sign in to add one.</p>
      ) : (
        <ul className="rows">
          {overview.devices.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              subscriptions={overview.subscriptions}
              profiles={profiles}
              assignment={assignments.get(d.id) ?? null}
            />
          ))}
        </ul>
      )}
    </>
  );
}

export default function DevicesPage() {
  return (
    <AccountShell eyebrow="Account" title="Devices" sub="Rename, move between subscriptions, or revoke a device.">
      <DevicesBody />
    </AccountShell>
  );
}
