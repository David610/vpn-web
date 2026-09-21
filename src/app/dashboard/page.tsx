"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { useSession } from "@/hooks/useSession";

export default function DashboardPage() {
  const router = useRouter();
  const { session, loading } = useSession();
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  async function handleSubscribe() {
    if (!session) return;
    setCheckoutLoading(true);
    setCheckoutError(null);
    try {
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Could not start checkout");
      }
      window.location.href = data.url;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : "Something went wrong.");
      setCheckoutLoading(false);
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
            <p className="section-sub">
              No active subscription yet.
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
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
