"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import ActionMenu from "@/components/account/ActionMenu";
import { maskedLink, useAccessLink } from "@/components/account/AccessLink";
import { configurationDetail, configurationSummary, type VpnLink } from "@/components/account/links";
import { LIVE, monthlyCents, statusLabel } from "@/components/account/types";
import { ConfirmDialog } from "@/components/Dialog";
import { api, euro, shortDate } from "@/lib/api";

function PlanStrip() {
  const { overview } = useAccount();
  const sub = overview?.subscriptions.find((s) => LIVE.has(s.status)) ?? overview?.subscriptions[0] ?? null;
  return (
    <section className="ps-strip" aria-label="Plan and connection status">
      <div className="ps-strip__cell">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h18v12H3zM3 10h18" />
        </svg>
        {overview ? (
          sub ? (
            <p>
              Plan: <strong>{euro(monthlyCents(overview.plan, sub.extraPacks))}/month</strong>
              <span aria-hidden="true"> · </span>
              <span className={`badge${sub.status === "active" || sub.status === "trialing" ? " badge--ok" : " badge--warn"}`}>{statusLabel(sub)}</span>
            </p>
          ) : (
            <p>
              Plan: <strong>Not subscribed</strong>
              <span aria-hidden="true"> · </span>
              <Link className="text-link" href="/account/plan/">Subscribe</Link>
            </p>
          )
        ) : (
          <p className="muted">Loading plan…</p>
        )}
      </div>
      <div className="ps-strip__cell">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 16a6 6 0 0 1 0-8M5 19a10 10 0 0 1 0-14M12 12h.01" />
        </svg>
        <div>
          <p>
            Devices connected now: <strong>—</strong>
            <span className="ps-info" role="img" aria-label="Live connection status is not available yet." title="Live connection status is not available yet.">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8h.01" />
              </svg>
            </span>
          </p>
          <p className="muted">Live status unavailable.</p>
        </div>
      </div>
    </section>
  );
}

function LinkRow({ link, onChanged }: { link: VpnLink; onChanged: () => Promise<void> }) {
  const { session } = useAccount();
  const access = useAccessLink(session, link.id, link.primaryClientId);
  const [confirm, setConfirm] = useState<"replace" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function replace() {
    if (!link.primaryClientId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ subscriptionUrl: string }>(
        session,
        `/api/account/links/${encodeURIComponent(link.id)}/clients/${encodeURIComponent(link.primaryClientId)}/replace-link`,
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

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await api(session, `/api/account/links/${encodeURIComponent(link.id)}`, { method: "DELETE" });
      setConfirm(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke this link.");
      setBusy(false);
    }
  }

  const detailHref = `/account/links/detail/?id=${encodeURIComponent(link.id)}`;
  const shown = access.state === "revealed" && access.url ? access.url : maskedLink();

  return (
    <li className="link-row">
      <div className="link-row__name">
        <Link href={detailHref} className="link-row__title">{link.name}</Link>
        <p className="muted">Created on {shortDate(link.createdAt)}</p>
      </div>
      <div className="link-row__config">
        <p>{configurationSummary(link)}</p>
        <p className="muted">{configurationDetail(link)}</p>
      </div>
      <div className="link-row__url">
        {link.primaryClientId ? (
          <div className={`linkfield${access.state === "revealed" ? " linkfield--open" : ""}`}>
            <code aria-label={access.state === "revealed" ? "Your HTTPS access link" : "Access link hidden"}>{shown}</code>
            <button
              type="button"
              className="linkfield__toggle"
              onClick={() => (access.state === "revealed" ? access.hide() : void access.reveal())}
              disabled={access.state === "loading"}
            >
              {access.state === "loading" ? "…" : access.state === "revealed" ? "Hide" : "Reveal"}
            </button>
          </div>
        ) : (
          <p className="muted">No access link yet. <Link className="text-link" href={detailHref}>Create one</Link></p>
        )}
        {access.state === "unavailable" ? (
          <p className="link-row__note">
            {access.message}{" "}
            <button type="button" className="btn-link" onClick={() => setConfirm("replace")}>Replace link</button>
          </p>
        ) : null}
        {access.state === "error" || (access.state === "revealed" && access.message) ? (
          <p className="link-row__note" role="alert">{access.message}</p>
        ) : null}
        {notice ? <p className="link-row__note" role="status">{notice}</p> : null}
        {error ? <p className="link-row__note link-row__note--error" role="alert">{error}</p> : null}
      </div>
      <div className="link-row__actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void access.copy()}
          disabled={!link.primaryClientId || access.state === "loading"}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 9h10v11H9zM5 15V4h10" />
          </svg>
          {access.copied ? "Copied" : "Copy link"}
        </button>
        <ActionMenu
          label={`More actions for ${link.name}`}
          items={[
            { label: "View / edit", href: detailHref },
            ...(link.primaryClientId ? [{ label: "Replace link", onSelect: () => setConfirm("replace") }] : []),
            { label: "Revoke link", danger: true, onSelect: () => setConfirm("revoke") },
          ]}
        />
      </div>
      <ConfirmDialog
        open={confirm === "replace"}
        title="Replace this link?"
        description="You get a new link. The current link stops working immediately, so update it in your VPN client."
        confirmLabel="Replace link"
        busy={busy}
        error={confirm === "replace" ? error : null}
        onConfirm={replace}
        onCancel={() => { setConfirm(null); setError(null); }}
      />
      <ConfirmDialog
        open={confirm === "revoke"}
        title="Revoke this link?"
        description={`“${link.name}” stops working immediately and frees its device place. This cannot be undone.`}
        confirmLabel="Revoke link"
        danger
        busy={busy}
        error={confirm === "revoke" ? error : null}
        onConfirm={revoke}
        onCancel={() => { setConfirm(null); setError(null); }}
      />
    </li>
  );
}

function LinksBody() {
  const { session, overview } = useAccount();
  const [links, setLinks] = useState<VpnLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ links: VpnLink[] }>(session, "/api/account/links");
      setLinks(data.links.filter((l) => l.status === "active").reverse());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your links.");
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <p className="notice notice--error" role="alert">
        {error} <button type="button" className="btn-link" onClick={() => void load()}>Try again</button>
      </p>
    );
  }
  if (!links) return <p className="muted">Loading…</p>;
  if (links.length === 0) {
    const subscribed = overview?.subscriptions.some((s) => LIVE.has(s.status));
    return (
      <div className="empty-card">
        <h2>No VPN links yet</h2>
        <p>{subscribed ? "Create a link and paste it into a compatible VPN client." : "Subscribe, then create a link to use in a compatible VPN client."}</p>
        <Link className="btn btn-primary" href={subscribed ? "/account/links/new/" : "/account/plan/"}>
          {subscribed ? "Create link" : "Subscribe"}
        </Link>
      </div>
    );
  }
  return (
    <section className="link-table" aria-label="Your VPN links">
      <div className="link-table__head" aria-hidden="true">
        <span>Name</span>
        <span>Configuration</span>
        <span>HTTPS link</span>
        <span>Actions</span>
      </div>
      <ul>
        {links.map((link) => (
          <LinkRow key={link.id} link={link} onChanged={load} />
        ))}
      </ul>
    </section>
  );
}

function CreateLinkButton() {
  const { overview } = useAccount();
  const subscribed = overview?.subscriptions.some((s) => LIVE.has(s.status));
  if (overview && !subscribed) return null;
  return (
    <Link className="btn btn-primary btn-lg" href="/account/links/new/">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      Create link
    </Link>
  );
}

export default function AccountHomePage() {
  return (
    <AccountShell title="Your VPN links" sub="Use a link in any compatible VPN client." top={<PlanStrip />} action={<CreateLinkButton />}>
      <LinksBody />
    </AccountShell>
  );
}
