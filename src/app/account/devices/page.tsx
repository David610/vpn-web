"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import { ConfirmDialog, InputDialog } from "@/components/Dialog";
import { api, relative } from "@/lib/api";
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
  const [renaming, setRenaming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [managing, setManaging] = useState(false);

  async function rename(name: string) {
    if (name === device.name) {
      setRenaming(false);
      return;
    }
    setBusy("rename");
    setError(null);
    try {
      await api(session, `/api/account/devices/${device.id}`, { method: "PATCH", body: { name } });
      setRenaming(false);
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
    setBusy("revoke");
    setError(null);
    try {
      await api(session, `/api/account/devices/${device.id}/revoke`, { method: "POST" });
      setRevoking(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke this device.");
    } finally {
      setBusy(null);
    }
  }

  const revoked = device.status === "REVOKED";

  return (
    <>
      <tr>
        <td>
          <span className="table__name">
            {device.name}
            {device.current ? <span className="pill">This device</span> : null}
          </span>
        </td>
        <td>{device.platform === "external" ? "Compatible client" : device.platform}</td>
        <td>{relative(device.lastSeenAt)}</td>
        <td><span className={`status${revoked ? " status--off" : ""}`}>{revoked ? "Revoked" : "Active"}</span></td>
        <td className="table__end">
          {!revoked && (
            <button type="button" className="btn-link" aria-expanded={managing} onClick={() => setManaging((v) => !v)}>
              {managing ? "Close" : "Manage"}
            </button>
          )}
        </td>
      </tr>
      {managing && !revoked && (
        <tr className="subtle-row">
          <td colSpan={5}>
            <div className="form-grid">
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
                <label className="field-label" htmlFor={`conn-${device.id}`}>Configuration</label>
                <select
                  id={`conn-${device.id}`}
                  className="field select"
                  value={assignment?.profileId ?? ""}
                  disabled={busy !== null || profiles.length === 0}
                  onChange={(e) => changeConnection(e.target.value)}
                >
                  <option value="" disabled>
                    {profiles.length === 0 ? "No configurations yet" : "Choose a configuration"}
                  </option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.enabled && p.id !== assignment?.profileId}>
                      {p.name}{p.enabled ? "" : " (disabled)"}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row__actions" style={{ justifyContent: "flex-start", marginTop: "var(--space-3)" }}>
              <button type="button" className="btn-link" disabled={busy !== null} onClick={() => setRenaming(true)}>Rename</button>
              <button type="button" className="btn-link text-danger" disabled={busy !== null} onClick={() => setRevoking(true)}>Remove device</button>
            </div>
            {error && <p className="field-error" style={{ marginTop: "var(--space-2)" }}>{error}</p>}
          </td>
        </tr>
      )}
      <InputDialog
        open={renaming}
        title="Rename device"
        label="Device name"
        initialValue={device.name}
        maxLength={60}
        busy={busy === "rename"}
        onConfirm={rename}
        onCancel={() => setRenaming(false)}
      />
      <ConfirmDialog
        open={revoking}
        title="Remove device?"
        description="This device will immediately lose VPN access."
        confirmLabel="Remove device"
        danger
        busy={busy === "revoke"}
        onConfirm={revoke}
        onCancel={() => setRevoking(false)}
      />
    </>
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
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">App</th>
                <th scope="col">Last seen</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {overview.devices.map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  subscriptions={overview.subscriptions}
                  profiles={profiles}
                  assignment={assignments.get(d.id) ?? null}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function DevicesPage() {
  return (
    <AccountShell
      eyebrow="Account"
      title="Devices"
      sub="Manage the devices connected to your account."
      action={<Link className="btn btn-primary" href="/apps/">Add device</Link>}
    >
      <DevicesBody />
    </AccountShell>
  );
}
