"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

type Profile = {
  id: string;
  name: string;
  enabled: boolean;
  routingMode: string;
};

type Device = {
  id: string;
  name: string;
  platform: string | null;
  status: "ACTIVE" | "REVOKED";
  createdAt: string;
  lastSeenAt: string | null;
  assignment: { profileId: string; assignedAt: string; profile: Profile | null } | null;
};

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  paddingBlock: "var(--space-3)",
  borderBottom: "1px solid var(--border-soft)",
};

/**
 * Connections/Devices management for the signed-in user's plan (Phase 9).
 *
 * Renders nothing until devices load, and nothing at all when the account
 * has no devices — mirrors MembersCard's "nothing to manage yet" shape.
 * Reassignment is free (no Stripe/billing involvement, spec §10) — just a
 * routing-policy pointer, so every member can reassign their own devices,
 * not only the owner. Revoke is likewise available to any member, matching
 * the "leave a plan" self-service pattern already used for membership.
 */
export function DevicesCard({ session }: { session: Session }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [devicesRes, profilesRes] = await Promise.all([
        fetch("/api/account/devices", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        fetch("/api/account/connection-profiles", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
      ]);
      if (!devicesRes.ok || !profilesRes.ok) throw new Error("load failed");
      const devicesData = await devicesRes.json();
      const profilesData = await profilesRes.json();
      setDevices(devicesData.devices);
      setProfiles(profilesData.profiles);
      setLoadError(null);
    } catch {
      setLoadError("Could not load your devices.");
    }
  }, [session.access_token]);

  useEffect(() => {
    load();
  }, [load]);

  async function reassign(device: Device, profileId: string) {
    if (!profileId || profileId === device.assignment?.profileId) return;
    setActionError(null);
    setBusyId(`assign-${device.id}`);
    try {
      const res = await fetch(`/api/account/devices/${device.id}/assignment`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ profileId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not reassign this device.");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(device: Device) {
    if (!window.confirm(`Revoke ${device.name}? It will lose VPN access immediately.`)) return;

    setActionError(null);
    setBusyId(`revoke-${device.id}`);
    try {
      const res = await fetch(`/api/account/devices/${device.id}/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok) throw new Error(data.error || "Could not revoke this device.");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  if (loadError) {
    return (
      <div className="dm-card" style={{ maxWidth: "26rem", marginTop: "var(--space-6)" }}>
        <div className="dm-card-header">
          <span className="dm-card-title">Devices</span>
        </div>
        <div style={{ padding: "var(--space-6)" }}>
          <p className="field-error">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!devices || devices.length === 0) return null;

  return (
    <div className="dm-card" style={{ maxWidth: "26rem", marginTop: "var(--space-6)" }}>
      <div className="dm-card-header">
        <span className="dm-card-title">Devices</span>
        <span className="tag">{devices.length} device{devices.length === 1 ? "" : "s"}</span>
      </div>
      <div style={{ padding: "var(--space-6)" }}>
        <p className="section-sub">
          Connection profiles decide how each device routes traffic. Reassigning one is
          free and takes effect immediately.
        </p>

        <div style={{ marginTop: "var(--space-4)" }}>
          {devices.map((d) => (
            <div key={d.id} style={ROW}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <p
                  className="text-tiny"
                  style={{
                    margin: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--fg)",
                  }}
                >
                  {d.name}
                </p>
                <span className="tag" style={{ marginTop: "var(--space-1)" }}>
                  {d.status === "REVOKED" ? "Revoked" : d.platform ?? "Active"}
                </span>

                {d.status !== "REVOKED" && (
                  <div style={{ marginTop: "var(--space-2)" }}>
                    <label className="field-label" htmlFor={`profile-${d.id}`}>
                      Connection profile
                    </label>
                    <select
                      id={`profile-${d.id}`}
                      className="field"
                      value={d.assignment?.profileId ?? ""}
                      disabled={busyId === `assign-${d.id}` || profiles.length === 0}
                      onChange={(e) => reassign(d, e.target.value)}
                    >
                      <option value="" disabled>
                        {profiles.length === 0 ? "No profiles available" : "Choose a profile"}
                      </option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {d.status !== "REVOKED" && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busyId === `revoke-${d.id}`}
                  onClick={() => revoke(d)}
                >
                  {busyId === `revoke-${d.id}` ? "Revoking…" : "Revoke"}
                </button>
              )}
            </div>
          ))}
        </div>

        {actionError && (
          <p className="field-error" style={{ marginTop: "var(--space-3)" }}>
            {actionError}
          </p>
        )}
      </div>
    </div>
  );
}
