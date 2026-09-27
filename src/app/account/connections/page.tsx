"use client";

import { useEffect, useState } from "react";
import { AccountShell, Feedback, useAccount } from "@/components/account/AccountShell";
import { ConfirmDialog, InputDialog } from "@/components/Dialog";
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
  AUTO: "1 server",
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
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);

  const locationName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? null;
  const detail =
    profile.routingMode === "DOUBLE_HOP"
      ? `Automatic → ${locationName(profile.preferredExitLocationId) ?? "Automatic"}`
      : profile.routingMode === "DIRECT"
        ? locationName(profile.preferredExitLocationId) ?? "Automatic"
        : "Automatic";

  async function rename(name: string) {
    if (name === profile.name) {
      setRenaming(false);
      return;
    }
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
      setRenaming(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename this configuration.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(session, `/api/account/connection-profiles/${profile.id}`, { method: "DELETE" });
      setRemoving(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove this configuration.");
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
        <button type="button" className="btn-link" disabled={busy} onClick={() => setRenaming(true)}>Rename</button>
        <button type="button" className="btn-link text-danger" disabled={busy} onClick={() => setRemoving(true)}>Remove</button>
      </div>
      {error && <p className="field-error" style={{ gridColumn: "1 / -1", marginTop: "var(--space-2)" }}>{error}</p>}
      <InputDialog
        open={renaming}
        title="Rename configuration"
        label="Name"
        initialValue={profile.name}
        maxLength={40}
        busy={busy}
        onConfirm={rename}
        onCancel={() => setRenaming(false)}
      />
      <ConfirmDialog
        open={removing}
        title="Remove configuration?"
        description={`Devices using “${profile.name}” will need a new configuration.`}
        confirmLabel="Remove configuration"
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => setRemoving(false)}
      />
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
  const [servers, setServers] = useState<"1" | "2">("1");
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
      setLoadError("Could not load your configurations.");
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
      const routingMode: Profile["routingMode"] =
        servers === "2" ? "DOUBLE_HOP" : exitLocationId ? "DIRECT" : "AUTO";
      await api(session, "/api/account/connection-profiles", {
        body: {
          name,
          routingMode,
          entryLocationId: null,
          exitLocationId: exitLocationId || null,
        },
      });
      (e.target as HTMLFormElement).reset();
      setServers("1");
      setExitLocationId("");
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create this configuration.");
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
        <div className="block__head"><h2 className="block__title">Saved configurations</h2></div>
        {profiles.length === 0 ? (
          <p className="muted" style={{ marginTop: "var(--space-4)" }}>
            No saved configurations yet. Arcana uses Automatic 1-server routing by default until you create one.
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
        <div className="block__head"><h2 className="block__title">Add a configuration</h2></div>
        <form onSubmit={create} style={{ marginTop: "var(--space-4)" }}>
          <div className="form-grid">
            <div>
              <label className="field-label" htmlFor="conn-name">Name</label>
              <input id="conn-name" name="name" className="field" required maxLength={40} placeholder="e.g. Germany" />
            </div>
          </div>

          <fieldset className="radio-group">
            <legend className="field-label">Connection</legend>
            <label className="radio-option">
              <input
                type="radio"
                name="servers"
                value="1"
                checked={servers === "1"}
                onChange={() => setServers("1")}
              />
              1 server
            </label>
            <label className="radio-option">
              <input
                type="radio"
                name="servers"
                value="2"
                checked={servers === "2"}
                onChange={() => setServers("2")}
              />
              2 servers
            </label>
          </fieldset>

          <div className="form-grid" style={{ marginTop: "var(--space-4)" }}>
            {servers === "2" && (
              <div className="form-reveal">
                <label className="field-label">Entry</label>
                <p className="field" style={{ display: "flex", alignItems: "center", color: "var(--fg-2)" }}>Automatic</p>
              </div>
            )}
            <div>
              <label className="field-label" htmlFor="conn-exit">
                {servers === "2" ? "Exit" : "Location"}
              </label>
              <select
                id="conn-exit"
                className="field select"
                value={exitLocationId}
                onChange={(e) => setExitLocationId(e.target.value)}
              >
                <option value="">Automatic</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
          </div>

          <button type="submit" className="btn btn-primary" disabled={creating} style={{ marginTop: "var(--space-4)" }}>
            {creating ? "Creating…" : "Create configuration"}
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
      title="Configurations"
      sub="Choose one server for speed, or two for an additional privacy hop."
    >
      <ConnectionsBody />
    </AccountShell>
  );
}
