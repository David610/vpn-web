"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "./telegram.css";
import { configurationDetail, configurationSummary, routingOf, type LocationChoice, type Routing, type VpnLink } from "@/components/account/links";
import { isValidLinkName } from "@/lib/link-first-client";
import { apiUrl } from "@/lib/api-base";

type MiniRoute = { id: string; displayName: string; region: string; privacyClass: string };
type Plan = {
  status: string;
  priceCents: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  used: number;
  capacity: number;
};
type LinksResponse = { links: VpnLink[]; routes: MiniRoute[]; plan: Plan | null };
type View =
  | { name: "list" }
  | { name: "create" }
  | { name: "detail"; id: string }
  | { name: "ready"; url: string; title: string; warning?: string };

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
  BackButton?: { show: () => void; hide: () => void; onClick: (cb: () => void) => void; offClick: (cb: () => void) => void };
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const NAME_HINT = "Letters, numbers, spaces and . _ ' ( ) - (up to 40).";
const AUTO_HIDE_MS = 60_000;

class MiniAppError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

function webApp(): TelegramWebApp | undefined {
  return typeof window === "undefined" ? undefined : window.Telegram?.WebApp;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(apiUrl(path), {
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

function errorMessage(err: unknown): string {
  if (err instanceof MiniAppError && err.code === "reopen_required") {
    return "For your security, close and reopen the app to continue.";
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

function confirmAction(message: string): Promise<boolean> {
  const tg = webApp();
  if (tg?.showConfirm) return new Promise((resolve) => tg.showConfirm!(message, resolve));
  return Promise.resolve(window.confirm(message));
}

function openWebsite(path: string) {
  const url = new URL(path, window.location.origin).toString();
  const tg = webApp();
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, "_blank", "noopener");
}

/** Telegram's WebView does not always expose the async clipboard API; fall back to a selection copy. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through to the selection-based copy
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function formatDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function euro(cents: number) {
  return `€${(cents / 100).toFixed(2)}`;
}

function maskedLink() {
  return `https://…/sub/${"•".repeat(12)}`;
}

function useScheme() {
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const tg = webApp();
    const apply = () => {
      const next = tg?.colorScheme ?? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
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

/** Shows Telegram's own back button while a screen other than the list is open. */
function useBackButton(active: boolean, onBack: () => void) {
  useEffect(() => {
    const button = webApp()?.BackButton;
    if (!button || !active) return;
    button.show();
    button.onClick(onBack);
    return () => {
      button.offClick(onBack);
      button.hide();
    };
  }, [active, onBack]);
}

/**
 * Holds one access link in memory only while the user asked to see it: it is
 * fetched on demand, hidden again after a minute and never stored.
 */
function useAccessLink(linkId: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
      clearTimeout(copiedTimer.current);
    },
    []
  );

  const show = useCallback((value: string) => {
    setUrl(value);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setUrl(null), AUTO_HIDE_MS);
  }, []);

  const fetchUrl = useCallback(async (): Promise<string | null> => {
    setBusy(true);
    setMessage(null);
    setUnavailable(false);
    try {
      return (await call<{ configurationUrl: string }>(`/api/telegram/links/${encodeURIComponent(linkId)}/access-link`)).configurationUrl;
    } catch (err) {
      if (err instanceof MiniAppError && err.code === "access_link_unavailable") setUnavailable(true);
      setMessage(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [linkId]);

  const reveal = useCallback(async () => {
    const value = url ?? (await fetchUrl());
    if (value) show(value);
  }, [url, fetchUrl, show]);

  const hide = useCallback(() => {
    clearTimeout(hideTimer.current);
    setUrl(null);
  }, []);

  const copy = useCallback(async () => {
    const value = url ?? (await fetchUrl());
    if (!value) return;
    if (await copyText(value)) {
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } else {
      show(value);
      setMessage("Copying was blocked. Press and hold the link to copy it.");
    }
  }, [url, fetchUrl, show]);

  return { url, busy, copied, message, unavailable, reveal, hide, copy, adopt: show };
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
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Link your account</h1>
      <p className="tg-lede">On the Arcana website open Account &amp; plan → Telegram and create a linking code. Enter it here.</p>
      <form className="tg-stack" onSubmit={submit}>
        <div>
          <label className="tg-field-label" htmlFor="code">Linking code</label>
          <input id="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
        </div>
        {error ? <p className="tg-error" role="alert">{error}</p> : null}
        <button className="tg-primary" disabled={busy || !code.trim()}>{busy ? "Linking…" : "Link account"}</button>
        <button type="button" className="tg-secondary" onClick={() => openWebsite("/account/plan/")}>Open website</button>
      </form>
    </section>
  );
}

function ChoiceGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; title: string; text: string; disabled?: boolean; note?: string }>;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className={`tg-choice${value === o.value ? " tg-is-on" : ""}${o.disabled ? " tg-is-disabled" : ""}`}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
          <span className="tg-dot" aria-hidden="true" />
          <span>
            <strong>{o.title}</strong>
            <span className="tg-text">{o.disabled && o.note ? o.note : o.text}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function CardMenu({ onReplace, onRevoke }: { onReplace: () => void; onRevoke: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tg-menu">
      <button type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>⋮</button>
      {open ? (
        <div className="tg-menu-list" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onReplace(); }}>Replace link</button>
          <button type="button" role="menuitem" className="tg-is-danger" onClick={() => { setOpen(false); onRevoke(); }}>Revoke link</button>
        </div>
      ) : null}
    </div>
  );
}

function LinkCard({ link, onOpen, onChanged, fail }: { link: VpnLink; onOpen: () => void; onChanged: () => void; fail: (message: string) => void }) {
  const access = useAccessLink(link.id);

  async function replace() {
    if (!(await confirmAction("Replace this link? The current link stops working immediately."))) return;
    try {
      const { configurationUrl } = await call<{ configurationUrl: string }>(`/api/telegram/links/${link.id}/replace`, { method: "POST" });
      access.adopt(configurationUrl);
    } catch (err) {
      fail(errorMessage(err));
    }
  }

  async function revoke() {
    if (!(await confirmAction(`Revoke “${link.name}”? It stops working immediately.`))) return;
    try {
      await call(`/api/telegram/links/${link.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      fail(errorMessage(err));
    }
  }

  return (
    <article className="tg-card">
      <div className="tg-card-head">
        <div>
          <h2 className="tg-card-title">{link.name}</h2>
          <p className="tg-muted">{configurationSummary(link)}</p>
        </div>
        <CardMenu onReplace={replace} onRevoke={revoke} />
      </div>
      <div className="tg-urlrow">
        {link.primaryClientId ? (
          <>
            <div className={`tg-urlbox${access.url ? " tg-urlbox--open" : ""}`}>{access.url ?? maskedLink()}</div>
            <button type="button" disabled={access.busy} onClick={() => void access.copy()}>{access.copied ? "Copied" : "Copy"}</button>
          </>
        ) : (
          <p className="tg-muted">No access link yet. Open the link to create one.</p>
        )}
      </div>
      {access.message ? <p className="tg-hint" role="alert">{access.message}{access.unavailable ? " " : ""}{access.unavailable ? <button type="button" className="tg-quiet" onClick={replace}>Replace link</button> : null}</p> : null}
      <button type="button" className="tg-card-link" onClick={onOpen}>
        <span>View / Edit</span>
        <span aria-hidden="true">›</span>
      </button>
    </article>
  );
}

function PlanCard({ plan }: { plan: Plan | null }) {
  if (!plan) {
    return (
      <section className="tg-card tg-plan">
        <div>
          <h2 className="tg-card-title">No active plan</h2>
          <p className="tg-muted">Subscribe on the website to create links.</p>
        </div>
        <button type="button" className="tg-secondary" onClick={() => openWebsite("/account/plan/")}>Subscribe</button>
      </section>
    );
  }
  const label = plan.status === "past_due" ? "Payment due" : plan.cancelAtPeriodEnd ? "Plan ending" : "Plan active";
  return (
    <section className="tg-card tg-plan">
      <div>
        <h2 className="tg-card-title">{label}</h2>
        <p>{euro(plan.priceCents)} <span className="tg-muted">/ month</span></p>
        {plan.currentPeriodEnd ? <p className="tg-muted">{plan.cancelAtPeriodEnd ? "Ends on" : "Renews on"} {formatDate(plan.currentPeriodEnd)}</p> : null}
      </div>
      <button type="button" className="tg-secondary" onClick={() => openWebsite("/account/plan/")}>Account ›</button>
    </section>
  );
}

function ListView({ data, setView, reload, fail }: { data: LinksResponse; setView: (v: View) => void; reload: () => void; fail: (m: string) => void }) {
  return (
    <>
      <h1>Your VPN links</h1>
      <p className="tg-lede">Create and manage your VPN links. Use them in any compatible client.</p>
      <div className="tg-stack">
        {data.plan ? (
          <button type="button" className="tg-primary" onClick={() => setView({ name: "create" })}>Create link →</button>
        ) : null}
        {data.links.length === 0 ? <p className="tg-notice">No VPN links yet. Create one and paste it into a compatible VPN client.</p> : null}
        {data.links.map((link) => (
          <LinkCard key={link.id} link={link} onOpen={() => setView({ name: "detail", id: link.id })} onChanged={reload} fail={fail} />
        ))}
        <PlanCard plan={data.plan} />
      </div>
    </>
  );
}

function CreateView({ data, setView, reload }: { data: LinksResponse; setView: (v: View) => void; reload: () => void }) {
  const [name, setName] = useState("");
  const [routing, setRouting] = useState<Routing>("one");
  const [location, setLocation] = useState<LocationChoice>("auto");
  const [routeId, setRouteId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitted = useRef(false);
  const twoAvailable = data.routes.some((r) => r.privacyClass === "privacy_plus");
  const candidates = data.routes.filter((r) => (routing === "two" ? r.privacyClass === "privacy_plus" : r.privacyClass === "fast"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || submitted.current) return;
    const trimmed = name.trim();
    if (!isValidLinkName(trimmed)) {
      setError(trimmed ? `That name is not allowed. ${NAME_HINT}` : "Give your link a name.");
      return;
    }
    if (location === "manual" && !candidates.some((r) => r.id === routeId)) {
      setError("Choose a location.");
      return;
    }
    submitted.current = true;
    setBusy(true);
    setError(null);
    try {
      const created = await call<{ id: string; configurationUrl: string }>("/api/telegram/links", {
        body: { name: trimmed, locationMode: location, routeId: location === "manual" ? routeId : undefined },
      });
      reload();
      setView({ name: "ready", url: created.configurationUrl, title: "Your VPN link is ready" });
    } catch (err) {
      submitted.current = false;
      setBusy(false);
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <h1>Create VPN link</h1>
      <p className="tg-lede">Choose how your VPN connects.</p>
      <form className="tg-stack" onSubmit={submit} noValidate>
        <div>
          <label className="tg-field-label" htmlFor="link-name">Link name</label>
          <input id="link-name" value={name} maxLength={40} placeholder="My phone" autoComplete="off" onChange={(e) => setName(e.target.value)} aria-describedby="name-hint" />
          <p className="tg-hint" id="name-hint">{NAME_HINT}</p>
        </div>
        <ChoiceGroup<Routing>
          legend="Routing"
          name="routing"
          value={routing}
          onChange={setRouting}
          options={[
            { value: "one", title: "1 server", text: "Connect through one server." },
            { value: "two", title: "2 servers", text: "Connect through two servers for extra privacy.", disabled: !twoAvailable, note: "Not available yet for compatible VPN clients." },
          ]}
        />
        <ChoiceGroup<LocationChoice>
          legend="Location"
          name="location"
          value={location}
          onChange={setLocation}
          options={[
            { value: "auto", title: "Automatic", text: "Arcana selects an available location for you." },
            { value: "manual", title: "Choose location", text: "Select a specific country or server." },
          ]}
        />
        {location === "manual" ? (
          <div>
            <label className="tg-field-label" htmlFor="link-route">Country or server</label>
            <select id="link-route" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
              <option value="">Choose a location</option>
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>{r.displayName}</option>
              ))}
            </select>
          </div>
        ) : null}
        {error ? <p className="tg-error" role="alert">{error}</p> : null}
        <button className="tg-primary" disabled={busy}>{busy ? "Creating…" : "Create link"}</button>
        <button type="button" className="tg-secondary" onClick={() => setView({ name: "list" })}>Cancel</button>
        <p className="tg-muted">Works with compatible VPN clients.</p>
      </form>
    </>
  );
}

function ReadyView({ view, setView }: { view: Extract<View, { name: "ready" }>; setView: (v: View) => void }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <h1>{view.title}</h1>
      <p className="tg-lede">Paste it into a compatible VPN client. Anyone with this link can connect, so keep it private.</p>
      <div className="tg-stack">
        <div className="tg-urlbox tg-urlbox--open">{view.url}</div>
        {view.warning ? <p className="tg-error" role="alert">{view.warning}</p> : null}
        {failed ? <p className="tg-hint">Copying was blocked. Press and hold the link to copy it.</p> : null}
        <button
          type="button"
          className="tg-primary"
          onClick={async () => {
            const ok = await copyText(view.url);
            setCopied(ok);
            setFailed(!ok);
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button type="button" className="tg-secondary" onClick={() => setView({ name: "list" })}>Done</button>
        <p className="tg-muted">You can copy this link again at any time from your VPN links.</p>
      </div>
    </>
  );
}

function DetailView({ id, data, setView, reload }: { id: string; data: LinksResponse; setView: (v: View) => void; reload: () => void }) {
  const link = data.links.find((l) => l.id === id);
  const access = useAccessLink(id);
  const initialRouting: Routing = routingOf({ privacy_class: link?.privacyClass ?? "fast" });
  const [routing, setRouting] = useState<Routing>(initialRouting);
  const [location, setLocation] = useState<LocationChoice>(link?.locationMode ?? "auto");
  const [routeId, setRouteId] = useState(link?.routeId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!link) {
    return (
      <>
        <h1>Link not found</h1>
        <div className="tg-stack"><button type="button" className="tg-secondary" onClick={() => setView({ name: "list" })}>Back to your links</button></div>
      </>
    );
  }

  const twoAvailable = data.routes.some((r) => r.privacyClass === "privacy_plus") || link.privacyClass === "privacy_plus";
  const candidates = data.routes.filter((r) => (routing === "two" ? r.privacyClass === "privacy_plus" : r.privacyClass === "fast"));
  const changed = routing !== initialRouting || location !== link.locationMode || (location === "manual" && routeId !== link.routeId);
  const needsRoute = location === "manual" && !candidates.some((r) => r.id === routeId);

  async function save() {
    if (!(await confirmAction("Changing routing or location gives you a new link. This link stops working as soon as the new one is ready."))) return;
    setBusy(true);
    setError(null);
    try {
      const moved = await call<{ id: string; configurationUrl: string; oldRevoked: boolean }>(`/api/telegram/links/${id}/move`, {
        body: { locationMode: location, routeId: location === "manual" ? routeId : undefined },
      });
      reload();
      setView({
        name: "ready",
        url: moved.configurationUrl,
        title: "Your new link is ready",
        warning: moved.oldRevoked ? undefined : "The previous link could not be revoked. Revoke it from your VPN links so it stops working.",
      });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function replace() {
    if (!(await confirmAction("Replace this link? The current link stops working immediately."))) return;
    setBusy(true);
    setError(null);
    try {
      const { configurationUrl } = await call<{ configurationUrl: string }>(`/api/telegram/links/${id}/replace`, { method: "POST" });
      access.adopt(configurationUrl);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!(await confirmAction(`Revoke “${link!.name}”? It stops working immediately.`))) return;
    setBusy(true);
    setError(null);
    try {
      await call(`/api/telegram/links/${id}`, { method: "DELETE" });
      reload();
      setView({ name: "list" });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h1>{link.name}</h1>
      <p className="tg-lede">VPN link • {configurationSummary(link).replace(" · ", " • ")}</p>
      <p className="tg-muted">{configurationDetail(link)}</p>
      <div className="tg-stack">
        <div>
          <h2 className="tg-card-title">Your HTTPS access link</h2>
          {link.primaryClientId ? (
            <>
              <div className="tg-urlrow">
                <div className={`tg-urlbox${access.url ? " tg-urlbox--open" : ""}`}>{access.url ?? maskedLink()}</div>
              </div>
              <div className="tg-urlrow">
                <button type="button" className="tg-primary" disabled={access.busy} onClick={() => void access.copy()}>{access.copied ? "Copied" : "Copy link"}</button>
                <button type="button" disabled={access.busy} onClick={() => (access.url ? access.hide() : void access.reveal())}>{access.url ? "Hide" : "Reveal"}</button>
              </div>
              <p className="tg-hint">Anyone with this link can connect. Keep it private.</p>
              {access.message ? <p className="tg-hint" role="alert">{access.message}</p> : null}
              <button type="button" className="tg-quiet" disabled={busy} onClick={replace}>Replace link</button>
            </>
          ) : (
            <p className="tg-muted">This link has no access link yet.</p>
          )}
        </div>
        <ChoiceGroup<Routing>
          legend="Routing"
          name="routing"
          value={routing}
          onChange={(v) => {
            setRouting(v);
            setRouteId("");
          }}
          options={[
            { value: "one", title: "1 server", text: "Connect through a single server." },
            { value: "two", title: "2 servers", text: "Route your connection through two servers for extra privacy.", disabled: !twoAvailable, note: "Not available yet for compatible VPN clients." },
          ]}
        />
        <ChoiceGroup<LocationChoice>
          legend="Location"
          name="location"
          value={location}
          onChange={setLocation}
          options={[
            { value: "auto", title: "Automatic", text: "Arcana selects an available location for you." },
            { value: "manual", title: "Choose location", text: "Select a specific country or server." },
          ]}
        />
        {location === "manual" ? (
          <div>
            <label className="tg-field-label" htmlFor="detail-route">Country or server</label>
            <select id="detail-route" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
              <option value="">Choose a location</option>
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>{r.displayName}</option>
              ))}
            </select>
          </div>
        ) : null}
        {changed ? <p className="tg-notice">Saving changes creates a new link and revokes this one, so you will need to update your VPN client.</p> : null}
        {error ? <p className="tg-error" role="alert">{error}</p> : null}
        <button type="button" className="tg-primary" disabled={!changed || needsRoute || busy} onClick={save}>Save changes</button>
        <button type="button" className="tg-secondary" onClick={() => setView({ name: "list" })}>Cancel</button>
        <button type="button" className="tg-danger" disabled={busy} onClick={revoke}>Revoke link</button>
      </div>
    </>
  );
}

export default function TelegramMiniAppPage() {
  const scheme = useScheme();
  const [data, setData] = useState<LinksResponse | null>(null);
  const [view, setView] = useState<View>({ name: "list" });
  const [state, setState] = useState<"loading" | "ready" | "not_linked" | "no_telegram" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!webApp()?.initData) {
      setState("no_telegram");
      return;
    }
    try {
      setData(await call<LinksResponse>("/api/telegram/links"));
      setState("ready");
      setError(null);
    } catch (err) {
      if (err instanceof MiniAppError && err.code === "not_linked") setState("not_linked");
      else {
        setError(errorMessage(err));
        setState("error");
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const goBack = useCallback(() => setView({ name: "list" }), []);
  useBackButton(view.name !== "list", goBack);

  return (
    <main className="tma" data-scheme={scheme}>
      {state === "loading" && <p className="tg-muted">Loading…</p>}
      {state === "no_telegram" && (
        <p className="tg-notice">Open this page from the Arcana bot in Telegram. On the web, use your account page instead.</p>
      )}
      {state === "not_linked" && (
        <LinkForm
          onLinked={() => {
            setState("loading");
            void load();
          }}
        />
      )}
      {state === "error" && (
        <div className="tg-stack">
          <p className="tg-error" role="alert">{error}</p>
          <button
            className="tg-secondary"
            onClick={() => {
              setState("loading");
              void load();
            }}
          >
            Try again
          </button>
        </div>
      )}
      {state === "ready" && data ? (
        <>
          {error ? <p className="tg-error" role="alert">{error}</p> : null}
          {view.name === "list" && <ListView data={data} setView={setView} reload={() => void load()} fail={setError} />}
          {view.name === "create" && <CreateView data={data} setView={setView} reload={() => void load()} />}
          {view.name === "detail" && <DetailView key={view.id} id={view.id} data={data} setView={setView} reload={() => void load()} />}
          {view.name === "ready" && <ReadyView view={view} setView={setView} />}
        </>
      ) : null}
    </main>
  );
}
