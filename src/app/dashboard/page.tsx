"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { useSession } from "@/hooks/useSession";

type ConfigState =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "provisioning" }
  | { phase: "ready"; subscriptionUrl: string }
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
          setConfig({ phase: "ready", subscriptionUrl: data.subscription_url });
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
          setConfig({ phase: "none" });
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

  async function handleSubscribe() {
    if (!session) return;
    setCheckoutLoading(true);
    setCheckoutError(null);
    try {
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Could not start checkout");
      }
      window.location.href = data.url;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : "Something went wrong.");
      setCheckoutLoading(false);
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
            <p className="section-eyebrow">Dashboard</p>
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
          <p className="section-eyebrow">Dashboard</p>
          <h1 className="section-h2">Welcome, {session.user.email}</h1>
        </div>
        <div className="dm-card" style={{ maxWidth: "26rem" }}>
          <div className="dm-card-header">
            <span className="dm-card-title">Subscription</span>
          </div>
          <div style={{ padding: "var(--space-6)" }}>
            {config.phase === "ready" ? (
              <>
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
                    : "No active subscription yet."}
                </p>
                {checkoutError && <p className="field-error">{checkoutError}</p>}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSubscribe}
                  disabled={checkoutLoading}
                  style={{ width: "100%", marginTop: "var(--space-4)" }}
                >
                  {checkoutLoading ? "Redirecting…" : "Subscribe"}
                </button>
              </>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
