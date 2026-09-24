"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { useSession } from "@/hooks/useSession";
import type { AccountInfo } from "@/components/MembersCard";

const MembersCard = dynamic(
  () => import("@/components/MembersCard").then((mod) => mod.MembersCard),
  { loading: () => null }
);
const UsageCard = dynamic(
  () => import("@/components/UsageCard").then((mod) => mod.UsageCard),
  { loading: () => null }
);
const DevicesCard = dynamic(
  () => import("@/components/DevicesCard").then((mod) => mod.DevicesCard),
  { loading: () => null }
);
const AccountActionsCard = dynamic(
  () => import("@/components/AccountActionsCard").then((mod) => mod.AccountActionsCard),
  { loading: () => null }
);
const SecurityCard = dynamic(
  () => import("@/components/SecurityCard").then((mod) => mod.SecurityCard),
  { loading: () => null }
);
const TelegramCard = dynamic(
  () => import("@/components/TelegramCard").then((mod) => mod.TelegramCard),
  { loading: () => null }
);

type ConfigState =
  | { phase: "loading" }
  | { phase: "none"; trialAvailable: boolean }
  | { phase: "provisioning" }
  | {
      phase: "ready";
      subscriptionUrl: string;
      provisioningUrl: string | null;
      preferredSetupUrl: string;
      entitlementSource: "stripe" | "admin_grant";
      status: string;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
      account: AccountInfo;
    }
  | { phase: "error" };

export default function DashboardPage() {
  const router = useRouter();
  const { session, loading } = useSession();
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutStatus, setCheckoutStatus] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigState>({ phase: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Static export (output: 'export') means no Suspense-wrapped
    // useSearchParams available here — read the redirect-back status
    // straight off the client-side URL instead, consistent with how the
    // rest of this file reads client-only state.
    const params = new URLSearchParams(window.location.search);
    setCheckoutStatus(params.get("checkout"));
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const res = await fetch("/api/vpn/config", {
          headers: { Authorization: `Bearer ${session!.access_token}` },
        });
        if (cancelled) return;
        if (res.status === 200) {
          const data = await res.json();
          setConfig({
            phase: "ready",
            subscriptionUrl: data.subscription_url,
            provisioningUrl: data.provisioning_url ?? null,
            preferredSetupUrl: data.preferred_setup_url ?? data.subscription_url,
            entitlementSource: data.entitlement_source ?? "stripe",
            status: data.status,
            currentPeriodEnd: data.current_period_end,
            cancelAtPeriodEnd: data.cancel_at_period_end,
            account: data.account,
          });
          return;
        }
        if (res.status === 404) {
          // Payment succeeded and a provisioning job exists, but the agent
          // hasn't completed it yet — keep polling until it does.
          setConfig({ phase: "provisioning" });
          timer = setTimeout(poll, 3000);
          return;
        }
        if (res.status === 403) {
          const data = await res.json().catch(() => ({}));
          setConfig({ phase: "none", trialAvailable: data.trial_available === true });
          return;
        }
        setConfig({ phase: "error" });
      } catch {
        if (!cancelled) setConfig({ phase: "error" });
      }
    }
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [session]);

  async function handleSubscribe(trial: boolean) {
    if (!session) return;
    setCheckoutLoading(true);
    setCheckoutError(null);
    try {
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trial }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Could not start checkout");
      }
      window.location.href = data.url;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : "Something went wrong.");
      setCheckoutLoading(false);
    }
  }

  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  async function handleCancel() {
    if (!session) return;
    if (
      !window.confirm(
        "Are you sure you want to cancel your subscription? You'll keep access until the end of your current billing period."
      )
    ) {
      return;
    }
    setCancelLoading(true);
    setCancelError(null);
    try {
      const res = await fetch("/api/cancel-subscription", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || "Could not cancel subscription");
      }
      setConfig((prev) =>
        prev.phase === "ready" ? { ...prev, cancelAtPeriodEnd: true } : prev
      );
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setCancelLoading(false);
    }
  }

  async function handleResume() {
    if (!session) return;
    setResumeLoading(true);
    setResumeError(null);
    try {
      const res = await fetch("/api/resume-subscription", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || "Could not resume subscription");
      }
      setConfig((prev) =>
        prev.phase === "ready" ? { ...prev, cancelAtPeriodEnd: false } : prev
      );
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setResumeLoading(false);
    }
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the field itself is still selectable.
    }
  }

  useEffect(() => {
    if (!loading && !session) {
      router.replace("/login/");
    }
  }, [loading, session, router]);

  if (loading || !session) {
    // Also covers the static-export pre-hydration paint: no session is
    // known at build time, so this branch is exactly what a crawler or a
    // logged-out visitor sees in the raw HTML — no user data, ever, in the
    // static shell.
    return (
      <>
        <Nav />
        <main className="dm-section" style={{ borderBottom: "none" }}>
          <div className="section-head">
            <p className="section-eyebrow">Account</p>
            <h1 className="section-h2">
              {loading ? "Loading…" : "Redirecting to login…"}
            </h1>
          </div>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Account</p>
          <h1 className="section-h2">Welcome, {session.user.email}</h1>
        </div>
        <div className="dm-card" style={{ maxWidth: "26rem" }}>
          <div className="dm-card-header">
            <span className="dm-card-title">Subscription</span>
          </div>
          <div style={{ padding: "var(--space-6)" }}>
            {config.phase === "ready" ? (
              <>
                {config.status === "trialing" && !config.cancelAtPeriodEnd && (
                  <p className="section-sub" style={{ marginBottom: "var(--space-3)" }}>
                    You&apos;re on a free trial
                    {config.currentPeriodEnd
                      ? ` until ${new Date(config.currentPeriodEnd).toLocaleDateString()}`
                      : ""}
                    . Billing starts automatically when it ends — cancel before then
                    and you won&apos;t be charged.
                  </p>
                )}
                <p className="section-sub">Your VPN is ready. Import this URL into your client:</p>
                <div
                  style={{
                    display: "flex",
                    gap: "var(--space-2)",
                    marginTop: "var(--space-3)",
                    alignItems: "center",
                  }}
                >
                  <input
                    className="field"
                    readOnly
                    value={config.subscriptionUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    style={{ flex: 1, fontSize: "0.85em" }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => handleCopy(config.subscriptionUrl)}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                {config.entitlementSource === "admin_grant" ? (
                  <p className="section-sub" style={{ marginTop: "var(--space-4)" }}>
                    Support access is active
                    {config.currentPeriodEnd
                      ? ` until ${new Date(config.currentPeriodEnd).toLocaleDateString()}`
                      : " with no expiry"}
                    . It is separate from Stripe billing.
                  </p>
                ) : config.cancelAtPeriodEnd ? (
                  <>
                    <p className="section-sub" style={{ marginTop: "var(--space-4)" }}>
                      Your subscription is canceled and will end on{" "}
                      {config.currentPeriodEnd
                        ? new Date(config.currentPeriodEnd).toLocaleDateString()
                        : "the end of the current billing period"}
                      .
                    </p>
                    {resumeError && <p className="field-error">{resumeError}</p>}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleResume}
                      disabled={resumeLoading}
                      style={{ marginTop: "var(--space-4)" }}
                    >
                      {resumeLoading ? "Resuming…" : "Resume subscription"}
                    </button>
                  </>
                ) : (
                  <>
                    {cancelError && <p className="field-error">{cancelError}</p>}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleCancel}
                      disabled={cancelLoading}
                      style={{ marginTop: "var(--space-4)" }}
                    >
                      {cancelLoading ? "Canceling…" : "Cancel subscription"}
                    </button>
                  </>
                )}
              </>
            ) : config.phase === "provisioning" ? (
              <p className="section-sub">
                Payment received — setting up your VPN configuration now, this usually takes a
                few seconds…
              </p>
            ) : config.phase === "error" ? (
              <p className="field-error">
                Could not load your VPN configuration. Try refreshing this page.
              </p>
            ) : config.phase === "loading" ? (
              <p className="section-sub">Loading…</p>
            ) : (
              <>
                <p className="section-sub">
                  {checkoutStatus === "cancel"
                    ? "Checkout was canceled."
                    : config.trialAvailable
                      ? "No active subscription yet. Try Arcana free for 3 days — cancel any time before it ends and you won't be charged."
                      : "No active subscription yet. Subscribe whenever you're ready."}
                </p>
                {checkoutError && <p className="field-error">{checkoutError}</p>}
                <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
                  {config.trialAvailable && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => handleSubscribe(true)}
                      disabled={checkoutLoading}
                      style={{ width: "100%" }}
                    >
                      {checkoutLoading ? "Redirecting…" : "Start 3-day free trial"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleSubscribe(false)}
                    disabled={checkoutLoading}
                    style={{ width: "100%" }}
                  >
                    Subscribe now
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        {config.phase === "ready" && (
          <>
            <MembersCard session={session} initialAccount={config.account} />
            <DevicesCard session={session} />
            <UsageCard session={session} />
            <AccountActionsCard
              session={session}
              setupUrl={config.preferredSetupUrl}
              canManageBilling={config.entitlementSource === "stripe"}
            />
          </>
        )}
        <SecurityCard session={session} />
        <TelegramCard session={session} />
      </main>
      <Footer />
    </>
  );
}
