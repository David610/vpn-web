"use client";

import { useEffect, useState } from "react";
import { AccountShell, Feedback, useAccount } from "@/components/account/AccountShell";
import { api } from "@/lib/api";

type Profile = {
  id: string;
  name: string;
  enabled: boolean;
  routingMode: "AUTO" | "DIRECT" | "DOUBLE_HOP";
  preferredEntryLocationId: string | null;
  preferredExitLocationId: string | null;
  autoFailover: boolean;
};

type Location = { id: string; name: string; countryCode: string };

const MODE_LABEL: Record<Profile["routingMode"], string> = {
  AUTO: "1 server · Automatic",
  DIRECT: "1 server",
  DOUBLE_HOP: "2 servers",
};

function ProfileRow({
  profile,
  locations,
  onChanged,
}: {
  profile: Profile;
  locations: Location[];
  onChanged: () => void;
}) {
  const { session } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locationName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? null;
  const detail =
    profile.routingMode === "DOUBLE_HOP"
      ? `${locationName(profile.preferredEntryLocationId) ?? "Automatic"} → ${locationName(profile.preferredExitLocationId) ?? "Automatic"}`
      : profile.routingMode === "DIRECT"
        ? locationName(profile.preferredExitLocationId) ?? "Automatic"
        : "Automatic";

  async function rename() {
    const name = window.prompt("Connection name", profile.name);
    if (!name || name === profile.name) return;
    setBusy(true);
    setError(null);
    try {
      await api(session, `/api/account/connection-profiles/${profile.id}`, {
        method: "PATCH",
        body: {
          name,
          routingMode: profile.routingMode,
          entryLocationId: profile.preferredEntryLocationId,
          exitLocationId: profile.preferredExitLocationId,
        },
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename this connection.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${profile.name}"? Devices using it will need a new connection.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(session, `/api/account/connection-profiles/${profile.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="row">
      <div>
        <p className="row__title">{profile.name}</p>
        <p className="row__sub">{MODE_LABEL[profile.routingMode]} · {detail}{profile.enabled ? "" : " · disabled"}</p>
      </div>
      <div className="row__actions">
        <button type="button" className="btn-link" disabled={busy} onClick={rename}>Rename</button>
        <button type="button" className="btn-link text-danger" disabled={busy} onClick={remove}>Delete</button>
      </div>
      {error && <p className="field-error" style={{ gridColumn: "1 / -1", marginTop: "var(--space-2)" }}>{error}</p>}
    </li>
  );
}

function ConnectionsBody() {
  const { session } = useAccount();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [mode, setMode] = useState<Profile["routingMode"]>("AUTO");
  const [entryLocationId, setEntryLocationId] = useState("");
  const [exitLocationId, setExitLocationId] = useState("");

  async function load() {
    try {
      const [profilesData, locationsData] = await Promise.all([
        api<{ profiles: Profile[] }>(session, "/api/account/connection-profiles"),
        fetch("/api/locations").then((r) => r.json()) as Promise<{ locations: Location[] }>,
      ]);
      setProfiles(profilesData.profiles);
      setLocations(locationsData.locations ?? []);
      setLoadError(null);
    } catch {
      setLoadError("Could not load your connections.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api(session, "/api/account/connection-profiles", {
        body: {
          name,
          routingMode: mode,
          entryLocationId: mode === "DOUBLE_HOP" ? entryLocationId || null : null,
          exitLocationId: mode === "AUTO" ? null : exitLocationId || null,
        },
      });
      (e.target as HTMLFormElement).reset();
      setMode("AUTO");
      setEntryLocationId("");
      setExitLocationId("");
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create this connection.");
    } finally {
      setCreating(false);
    }
  }

  if (profiles === null) {
    return loadError ? <p className="notice notice--error">{loadError}</p> : <p className="muted">Loading…</p>;
  }

  return (
    <>
      <div className="block">
        <div className="block__head"><h2 className="block__title">Saved connections</h2></div>
        {profiles.length === 0 ? (
          <p className="muted" style={{ marginTop: "var(--space-4)" }}>
            No saved connections yet. Arcana uses Automatic 1-server routing by default until you create one.
          </p>
        ) : (
          <ul className="rows">
            {profiles.map((p) => (
              <ProfileRow key={p.id} profile={p} locations={locations} onChanged={load} />
            ))}
          </ul>
        )}
      </div>

      <div className="block">
        <div className="block__head"><h2 className="block__title">Add a connection</h2></div>
        <form onSubmit={create} className="form-grid" style={{ marginTop: "var(--space-4)" }}>
          <div>
            <label className="field-label" htmlFor="conn-name">Name</label>
            <input id="conn-name" name="name" className="field" required maxLength={40} placeholder="e.g. Germany" />
          </div>
          <div>
            <label className="field-label" htmlFor="conn-mode">Servers</label>
            <select
              id="conn-mode"
              className="field select"
              value={mode}
              onChange={(e) => setMode(e.target.value as Profile["routingMode"])}
            >
              <option value="AUTO">Automatic</option>
              <option value="DIRECT">1 server</option>
              <option value="DOUBLE_HOP">2 servers</option>
            </select>
          </div>
          {mode === "DOUBLE_HOP" && (
            <div>
              <label className="field-label" htmlFor="conn-entry">Entry</label>
              <select
                id="conn-entry"
                className="field select"
                required
                value={entryLocationId}
                onChange={(e) => setEntryLocationId(e.target.value)}
              >
                <option value="" disabled>Choose entry location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
          )}
          {mode !== "AUTO" && (
            <div>
              <label className="field-label" htmlFor="conn-exit">
                {mode === "DOUBLE_HOP" ? "Exit" : "Location"}
              </label>
              <select
                id="conn-exit"
                className="field select"
                required
                value={exitLocationId}
                onChange={(e) => setExitLocationId(e.target.value)}
              >
                <option value="" disabled>Choose {mode === "DOUBLE_HOP" ? "exit " : ""}location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? "Creating…" : "Create connection"}
          </button>
        </form>
        <Feedback error={createError} />
      </div>
    </>
  );
}

export default function ConnectionsPage() {
  return (
    <AccountShell
      eyebrow="Account"
      title="Connections"
      sub="1 server is faster. 2 servers routes through an extra hop for more privacy. A 2-server connection never silently becomes 1."
    >
      <ConnectionsBody />
    </AccountShell>
  );
}
