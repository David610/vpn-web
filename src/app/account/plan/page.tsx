"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AccountShell, Feedback, useAccount } from "@/components/account/AccountShell";
import { ChangeEmailForm, ChangePasswordForm, DeleteAccountBlock } from "@/components/account/AccountForms";
import { LIVE, monthlyCents, statusLabel, type Subscription } from "@/components/account/types";
import { ConfirmDialog } from "@/components/Dialog";
import { api, euro, shortDate } from "@/lib/api";
import { PLAN_PRICE_LABEL, SITE_NAME } from "@/lib/site-config";

function AccountCard() {
  const { session, overview } = useAccount();
  const [editing, setEditing] = useState<"email" | "password" | null>(null);
  return (
    <section className="ps-card" aria-labelledby="account-heading">
      <h2 id="account-heading">Account</h2>
      <div className="ps-rows">
        <div>
          <span className="ps-row__label">Email</span>
          <span className="ps-row__value">{overview?.email ?? session.user.email}</span>
          <button type="button" className="btn btn-secondary" aria-expanded={editing === "email"} onClick={() => setEditing(editing === "email" ? null : "email")}>
            Change email
          </button>
        </div>
        {editing === "email" ? <div className="ps-rows__form"><ChangeEmailForm onDone={() => setEditing(null)} /></div> : null}
        <div>
          <span className="ps-row__label">Password</span>
          <span className="ps-row__value" aria-label="Hidden">••••••••</span>
          <button type="button" className="btn btn-secondary" aria-expanded={editing === "password"} onClick={() => setEditing(editing === "password" ? null : "password")}>
            Change password
          </button>
        </div>
        {editing === "password" ? <div className="ps-rows__form"><ChangePasswordForm session={session} onDone={() => setEditing(null)} /></div> : null}
      </div>
    </section>
  );
}

function PlanBlock({ sub }: { sub: Subscription }) {
  const { session, overview, reload } = useAccount();
  const [busy, setBusy] = useState<"portal" | "cancel" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const isOwner = overview?.role === "owner";
  const live = LIVE.has(sub.status);

  async function openPortal() {
    setBusy("portal");
    setError(null);
    try {
      const data = await api<{ url: string }>(session, "/api/billing/portal", { method: "POST" });
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open billing management.");
      setBusy(null);
    }
  }

  async function change(action: "cancel" | "resume") {
    setBusy(action);
    setError(null);
    try {
      await api(session, `/api/account/subscriptions/${sub.id}/${action}`, { method: "POST" });
      setCancelling(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} your plan.`);
    } finally {
      setBusy(null);
    }
  }

  const date = shortDate(sub.currentPeriodEnd);
  const price = euro(monthlyCents(overview!.plan, sub.extraPacks));
  return (
    <div className="plan-block">
      <div className="plan-block__main">
        <h3>{SITE_NAME}</h3>
        <p className="plan-block__price">{price} <span>/ month</span></p>
        <p className="muted">
          {sub.currentPeriodEnd ? (sub.cancelAtPeriodEnd ? `Ends on ${date}` : `Next payment ${date}`) : statusLabel(sub)}
          {" · "}
          {sub.used} of {sub.capacity} devices in use
        </p>
      </div>
      <div className="plan-block__side">
        <span className={`badge${sub.status === "active" || sub.status === "trialing" ? " badge--ok" : " badge--warn"}`}>{statusLabel(sub)}</span>
        {isOwner ? (
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={openPortal}>
            {busy === "portal" ? "Opening…" : "Manage plan & payment"}
          </button>
        ) : null}
      </div>
      {isOwner && live ? (
        <p className="plan-block__links">
          {sub.cancelAtPeriodEnd ? (
            <button type="button" className="btn-link" disabled={busy !== null} onClick={() => void change("resume")}>
              {busy === "resume" ? "Resuming…" : "Resume plan"}
            </button>
          ) : (
            <button type="button" className="btn-link" disabled={busy !== null} onClick={() => setCancelling(true)}>Cancel plan</button>
          )}
        </p>
      ) : null}
      {!isOwner ? <p className="muted plan-block__links">Only the account owner can manage billing.</p> : null}
      <Feedback error={error} />
      <ConfirmDialog
        open={cancelling}
        title="Cancel your plan?"
        description="Your links keep working until the end of the billing period you have already paid for."
        confirmLabel="Cancel plan"
        danger
        busy={busy === "cancel"}
        onConfirm={() => void change("cancel")}
        onCancel={() => setCancelling(false)}
      />
    </div>
  );
}

function PlanCard() {
  const { session, overview, reload } = useAccount();
  const params = useSearchParams();
  const checkout = params.get("checkout");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLive = overview?.subscriptions.some((s) => LIVE.has(s.status)) ?? false;

  // Stripe confirms the subscription by webhook, which can trail the redirect by a few seconds.
  useEffect(() => {
    if (checkout !== "success" || hasLive) return;
    const timers = [2000, 5000, 10000].map((ms) => setTimeout(() => void reload(), ms));
    return () => timers.forEach(clearTimeout);
  }, [checkout, hasLive, reload]);

  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ url: string }>(session, "/api/create-checkout-session", { body: { trial: false, name: SITE_NAME } });
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout.");
      setBusy(false);
    }
  }

  return (
    <section className="ps-card" aria-labelledby="plan-heading">
      <h2 id="plan-heading">Plan</h2>
      {checkout === "success" ? <p className="notice" role="status">Thank you. Your plan is being activated. This can take a few seconds.</p> : null}
      {checkout === "cancel" ? <p className="notice" role="status">Checkout was canceled. You have not been charged.</p> : null}
      {!overview ? (
        <p className="muted">Loading…</p>
      ) : overview.subscriptions.length === 0 ? (
        <div className="plan-block">
          <div className="plan-block__main">
            <h3>{SITE_NAME}</h3>
            <p className="plan-block__price">{PLAN_PRICE_LABEL} <span>/ month</span></p>
            <p className="muted">One plan. Up to {overview.plan.includedDevices} devices.</p>
          </div>
          <div className="plan-block__side">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void subscribe()}>
              {busy ? "Redirecting…" : "Subscribe"}
            </button>
          </div>
          <Feedback error={error} />
        </div>
      ) : (
        overview.subscriptions.map((sub) => <PlanBlock key={sub.id} sub={sub} />)
      )}
    </section>
  );
}

function TelegramSummary() {
  const { session } = useAccount();
  const [linked, setLinked] = useState<{ username: string | null } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api<{ linked: boolean; telegramUsername: string | null }>(session, "/api/account/telegram")
      .then((d) => live && setLinked(d.linked ? { username: d.telegramUsername } : null))
      .catch(() => live && setLinked(undefined));
    return () => {
      live = false;
    };
  }, [session]);
  return (
    <section className="ps-card" aria-labelledby="telegram-heading">
      <h2 id="telegram-heading">Telegram</h2>
      <div className="telegram-row">
        <span className="telegram-row__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 3L10 14M21 3l-7 18-4-7-7-4z" />
          </svg>
        </span>
        <div>
          <h3>{linked ? `Linked${linked.username ? ` to @${linked.username}` : ""}` : "Link your Telegram account"}</h3>
          <p className="muted">Open Arcana in Telegram to quickly access and manage your VPN links.</p>
        </div>
        <Link className="btn btn-secondary" href="/account/telegram/">{linked ? "Manage" : "Link Telegram"}</Link>
      </div>
    </section>
  );
}

function PlanPageBody() {
  const { session, overview } = useAccount();
  return (
    <>
      <AccountCard />
      <PlanCard />
      <TelegramSummary />
      {overview ? <DeleteAccountBlock session={session} /> : null}
    </>
  );
}

export default function AccountPlanPage() {
  return (
    <AccountShell title="Account & plan">
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <PlanPageBody />
      </Suspense>
    </AccountShell>
  );
}
