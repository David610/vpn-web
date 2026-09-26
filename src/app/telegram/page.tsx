"use client";

import { useCallback, useEffect, useState } from "react";
import "./telegram.css";

type RoutingMode = "AUTO" | "DIRECT" | "DOUBLE_HOP";
type Profile = {
  id: string;
  name: string;
  enabled: boolean;
  routingMode: RoutingMode;
  entryLocationId: string | null;
  exitLocationId: string | null;
};
type Subscription = {
  id: string;
  name: string;
  status: string;
  capacity: number;
  used: number;
  extraPacks: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};
type Device = {
  id: string;
  name: string;
  platform: string;
  status: string;
  subscriptionId: string | null;
  lastSeenAt: string | null;
  placement: { status: string; error: string | null } | null;
  profileId: string | null;
};
type Overview = {
  role: string;
  telegramUsername: string | null;
  subscriptions: Subscription[];
  capacity: { total: number; used: number };
  plan: { includedDevices: number; devicesPerPack: number };
  devices: Device[];
  profiles: Profile[];
};
type Location = { id: string; name: string; countryCode: string };

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: { start_param?: string };
  colorScheme?: "light" | "dark";
  ready: () => void;
  expand: () => void;
  close: () => void;
  onEvent?: (event: string, cb: () => void) => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  showConfirm?: (message: string, cb: (ok: boolean) => void) => void;
  openLink?: (url: string) => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const MODE_LABEL: Record<RoutingMode, string> = {
  AUTO: "Automatic",
  DIRECT: "Fast · 1 server",
  DOUBLE_HOP: "Privacy+ · 2 servers",
};

class MiniAppError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

function webApp(): TelegramWebApp | undefined {
  return typeof window === "undefined" ? undefined : window.Telegram?.WebApp;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "X-Telegram-Init-Data": webApp()?.initData ?? "",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new MiniAppError(data.error ?? "Something went wrong.", res.status, data.code);
  return data as T;
}

function confirmAction(message: string): Promise<boolean> {
  const tg = webApp();
  if (tg?.showConfirm) return new Promise((resolve) => tg.showConfirm!(message, resolve));
  return Promise.resolve(window.confirm(message));
}

function websiteUrl(path: string) {
  return typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
}

function openWebsite(path: string) {
  const url = websiteUrl(path);
  const tg = webApp();
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, "_blank", "noopener");
}

function statusLabel(s: Subscription) {
  if (s.status === "cancelling") return "Ends at period end";
  if (s.status === "active" || s.status === "trialing") return "Active";
  if (s.status === "past_due") return "Payment due";
  return "Inactive";
}

function formatDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function useScheme() {
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const tg = webApp();
    const apply = () => {
      const next =
        tg?.colorScheme ??
        (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      setScheme(next);
      const bg = next === "dark" ? "#0a0a0a" : "#ffffff";
      tg?.setHeaderColor?.(bg);
      tg?.setBackgroundColor?.(bg);
    };
    tg?.ready();
    tg?.expand();
    apply();
    tg?.onEvent?.("themeChanged", apply);
  }, []);
  return scheme;
}

function LinkForm({ onLinked }: { onLinked: () => void }) {
  const [code, setCode] = useState(() => webApp()?.initDataUnsafe?.start_param ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("/api/telegram/link", { body: { code: code.trim() } });
      onLinked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Link your account</h2>
      <p className="muted" style={{ marginTop: 12 }}>
        On the Arcana website, open Account → Security → Telegram and create a linking code. Enter it here.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="code">Linking code</label>
        <input id="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
        <div className="actions">
          <button className="primary" disabled={busy || !code.trim()}>
            {busy ? "Linking…" : "Link account"}
          </button>
          <button type="button" onClick={() => openWebsite("/account/security/")}>
            Open website
          </button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function RouteSelect({
  device,
  profiles,
  onAssign,
  busy,
}: {
  device: Device;
  profiles: Profile[];
  onAssign: (device: Device, value: string) => void;
  busy: boolean;
}) {
  const hasAuto = profiles.some((p) => p.routingMode === "AUTO" && p.enabled);
  return (
    <select
      aria-label={`Route for ${device.name}`}
      value={device.profileId ?? ""}
      disabled={busy}
      onChange={(e) => onAssign(device, e.target.value)}
    >
      {!device.profileId && <option value="">Automatic</option>}
      {!hasAuto && device.profileId && <option value="__auto">Automatic</option>}
      {profiles
        .filter((p) => p.enabled)
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} — {MODE_LABEL[p.routingMode]}
          </option>
        ))}
    </select>
  );
}

function DeviceRow({
  device,
  overview,
  busy,
  run,
  onAssign,
}: {
  device: Device;
  overview: Overview;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => void;
  onAssign: (device: Device, value: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(device.name);
  const live = overview.subscriptions.filter((s) => s.status === "active" || s.status === "trialing" || s.status === "cancelling");
  const sub = overview.subscriptions.find((s) => s.id === device.subscriptionId);

  return (
    <div className="row">
      <div className="row-head">
        <span className="strong">{device.name}</span>
        <span className="muted">{device.platform || "device"}</span>
      </div>
      <div className="muted">
        {sub ? sub.name : "Not on a subscription — not connected"}
        {device.placement?.status === "UNSCHEDULABLE" ? " · No server available for this route" : ""}
      </div>
      {renaming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => call(`/api/telegram/devices/${device.id}`, { method: "PATCH", body: { name } }));
            setRenaming(false);
          }}
        >
          <label htmlFor={`name-${device.id}`}>Name</label>
          <input id={`name-${device.id}`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <div className="actions">
            <button className="primary" disabled={busy || !name.trim()}>
              Save
            </button>
            <button type="button" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <label>Route</label>
          <RouteSelect device={device} profiles={overview.profiles} busy={busy} onAssign={onAssign} />
          {live.length > 1 && (
            <>
              <label>Subscription</label>
              <select
                value={device.subscriptionId ?? ""}
                disabled={busy}
                onChange={(e) =>
                  run(() => call(`/api/telegram/devices/${device.id}/move`, { body: { subscriptionId: e.target.value } }))
                }
              >
                {!device.subscriptionId && <option value="">None</option>}
                {live.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.used}/{s.capacity})
                  </option>
                ))}
              </select>
            </>
          )}
          <div className="actions">
            <button disabled={busy} onClick={() => setRenaming(true)}>
              Rename
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                if (await confirmAction(`Remove ${device.name}? It disconnects and frees its place.`)) {
                  run(() => call(`/api/telegram/devices/${device.id}`, { method: "DELETE" }));
                }
              }}
            >
              Remove
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function NewConnection({
  locations,
  busy,
  run,
}: {
  locations: Location[];
  busy: boolean;
  run: (fn: () => Promise<unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<RoutingMode>("DIRECT");
  const [exit, setExit] = useState("");
  const [entry, setEntry] = useState("");

  if (!open) {
    return (
      <div className="actions">
        <button onClick={() => setOpen(true)}>New connection</button>
      </div>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(() =>
          call("/api/telegram/profiles", {
            body: {
              name: name.trim(),
              routingMode: mode,
              exitLocationId: mode === "AUTO" ? undefined : exit,
              entryLocationId: mode === "DOUBLE_HOP" ? entry : undefined,
            },
          })
        );
        setOpen(false);
        setName("");
      }}
    >
      <label htmlFor="conn-name">Name</label>
      <input id="conn-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="conn-mode">Route</label>
      <select id="conn-mode" value={mode} onChange={(e) => setMode(e.target.value as RoutingMode)}>
        <option value="AUTO">Automatic — we pick the best server</option>
        <option value="DIRECT">Fast — 1 server</option>
        <option value="DOUBLE_HOP">Privacy+ — 2 servers</option>
      </select>
      {mode === "DOUBLE_HOP" && (
        <>
          <label htmlFor="conn-entry">Entry location</label>
          <select id="conn-entry" value={entry} onChange={(e) => setEntry(e.target.value)}>
            <option value="">Choose…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </>
      )}
      {mode !== "AUTO" && (
        <>
          <label htmlFor="conn-exit">{mode === "DOUBLE_HOP" ? "Exit location" : "Location"}</label>
          <select id="conn-exit" value={exit} onChange={(e) => setExit(e.target.value)}>
            <option value="">Choose…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="actions">
        <button className="primary" disabled={busy || !name.trim()}>
          Create
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function TelegramMiniAppPage() {
  const scheme = useScheme();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "not_linked" | "no_telegram" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!webApp()?.initData) {
      setState("no_telegram");
      return;
    }
    try {
      setOverview(await call<Overview>("/api/telegram/overview"));
      setState("ready");
    } catch (err) {
      if (err instanceof MiniAppError && err.code === "not_linked") setState("not_linked");
      else {
        setError(err instanceof Error ? err.message : "Could not load your account.");
        setState("error");
      }
    }
  }, []);

  useEffect(() => {
    load();
    fetch("/api/locations")
      .then((r) => r.json())
      .then((d) => setLocations(Array.isArray(d.locations) ? d.locations : []))
      .catch(() => setLocations([]));
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
      } catch (err) {
        if (err instanceof MiniAppError && err.code === "reopen_required") {
          setError("For your security, close and reopen the app to make changes.");
        } else if (err instanceof MiniAppError && err.code === "not_linked") {
          setState("not_linked");
        } else {
          setError(err instanceof Error ? err.message : "Something went wrong.");
        }
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const assign = useCallback(
    (device: Device, value: string) => {
      if (!overview || value === "") return;
      run(async () => {
        let profileId = value;
        if (value === "__auto") {
          const existing = overview.profiles.find((p) => p.routingMode === "AUTO" && p.enabled);
          profileId =
            existing?.id ??
            (await call<{ id: string }>("/api/telegram/profiles", { body: { name: "Automatic", routingMode: "AUTO" } })).id;
        }
        await call(`/api/telegram/devices/${device.id}/assignment`, { body: { profileId } });
      });
    },
    [overview, run]
  );

  const locationName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? "Unavailable location";

  return (
    <main className="tma" data-scheme={scheme}>
      <h1>Arcana</h1>

      {state === "loading" && <p className="muted">Loading…</p>}

      {state === "no_telegram" && (
        <p className="notice">Open this page from the Arcana bot in Telegram. On the web, use your account page instead.</p>
      )}

      {state === "not_linked" && <LinkForm onLinked={() => { setState("loading"); load(); }} />}

      {state === "error" && (
        <>
          <p className="error">{error}</p>
          <div className="actions">
            <button onClick={() => { setState("loading"); load(); }}>Try again</button>
          </div>
        </>
      )}

      {state === "ready" && overview && (
        <>
          {error && <p className="error" role="alert">{error}</p>}

          <section>
            <h2>Status</h2>
            <div className="row">
              <div className="big">
                {overview.capacity.used}/{overview.capacity.total}
              </div>
              <div className="muted" style={{ marginTop: 6 }}>
                {overview.capacity.total === 0
                  ? "No active subscription"
                  : "devices connected on your subscriptions"}
              </div>
            </div>
          </section>

          <section>
            <h2>Subscriptions</h2>
            {overview.subscriptions.length === 0 && (
              <p className="muted row">No subscriptions yet.</p>
            )}
            {overview.subscriptions.map((s) => (
              <div className="row" key={s.id}>
                <div className="row-head">
                  <span className="strong">{s.name}</span>
                  <span className="muted">{statusLabel(s)}</span>
                </div>
                <div className="muted">
                  {s.used} of {s.capacity} devices
                  {s.currentPeriodEnd ? ` · ${s.cancelAtPeriodEnd ? "ends" : "renews"} ${formatDate(s.currentPeriodEnd)}` : ""}
                </div>
              </div>
            ))}
            <p className="muted" style={{ marginTop: 10 }}>
              Each subscription covers {overview.plan.includedDevices} devices, plus {overview.plan.devicesPerPack} per
              extra pack. Buy, change or cancel on the website.
            </p>
            <div className="actions">
              <button onClick={() => openWebsite("/account/subscriptions/")}>Manage on website</button>
            </div>
          </section>

          <section>
            <h2>Devices</h2>
            {overview.devices.length === 0 && (
              <p className="muted row">No devices yet. Sign in with the Arcana app on a device to add it.</p>
            )}
            {overview.devices.map((d) => (
              <DeviceRow key={d.id} device={d} overview={overview} busy={busy} run={run} onAssign={assign} />
            ))}
          </section>

          <section>
            <h2>Connections</h2>
            {overview.profiles.length === 0 && (
              <p className="muted row">Devices use Automatic until you create a connection.</p>
            )}
            {overview.profiles.map((p) => (
              <div className="row" key={p.id}>
                <div className="row-head">
                  <span className="strong">{p.name}</span>
                  <span className="muted">{MODE_LABEL[p.routingMode]}</span>
                </div>
                {p.routingMode !== "AUTO" && (
                  <div className="muted">
                    {p.routingMode === "DOUBLE_HOP" ? `${locationName(p.entryLocationId)} → ` : ""}
                    {locationName(p.exitLocationId)}
                  </div>
                )}
                <div className="actions">
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={async () => {
                      if (await confirmAction(`Delete ${p.name}? Devices using it switch to Automatic.`)) {
                        run(() => call(`/api/telegram/profiles/${p.id}`, { method: "DELETE" }));
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            <NewConnection locations={locations} busy={busy} run={run} />
          </section>

          <section>
            <h2>Telegram</h2>
            <div className="row">
              <div className="strong">Linked{overview.telegramUsername ? ` as @${overview.telegramUsername}` : ""}</div>
              <div className="actions">
                <button
                  className="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (await confirmAction("Unlink Telegram from your Arcana account?")) {
                      run(async () => {
                        await call("/api/telegram/unlink", { method: "POST" });
                        setState("not_linked");
                      });
                    }
                  }}
                >
                  Unlink
                </button>
              </div>
            </div>
          </section>

          <section>
            <h2>Help</h2>
            <ol>
              <li>Set up a device with the Arcana app — the setup link is on the website, not in Telegram.</li>
              <li>Pick a route for each device: Automatic, Fast (1 server) or Privacy+ (2 servers).</li>
              <li>Changes need a fresh session; if asked, close and reopen this app.</li>
            </ol>
            <div className="actions">
              <button onClick={() => openWebsite("/account/help/")}>Help on website</button>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
