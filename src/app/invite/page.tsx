"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { useSession } from "@/hooks/useSession";

type Phase =
  | { name: "reading" }
  | { name: "no-token" }
  | { name: "needs-account"; authHref: string; signupHref: string }
  | { name: "accepting" }
  | { name: "accepted"; provisioning: boolean }
  | { name: "failed"; message: string };

export default function InvitePage() {
  const router = useRouter();
  const { session, loading } = useSession();
  const [phase, setPhase] = useState<Phase>({ name: "reading" });
  const [token, setToken] = useState<string | null>(null);
  // Accepting spends the invite, so it must happen exactly once even though
  // the session effect can re-run.
  const attempted = useRef(false);

  useEffect(() => {
    // Static export: no Suspense-wrapped useSearchParams here, so read the
    // token off the client-side URL, as the dashboard does for its own
    // query params.
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token"));
  }, []);

  const accept = useCallback(
    async (accessToken: string, inviteToken: string) => {
      setPhase({ name: "accepting" });
      try {
        const res = await fetch("/api/account/accept-invite", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token: inviteToken }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setPhase({
            name: "failed",
            message: data.error ?? "This invitation could not be accepted.",
          });
          return;
        }
        setPhase({ name: "accepted", provisioning: Boolean(data.provisioning) });
      } catch {
        setPhase({
          name: "failed",
          message: "Could not reach the server. Check your connection and try again.",
        });
      }
    },
    []
  );

  useEffect(() => {
    if (loading || token === null) return;

    if (!token) {
      setPhase({ name: "no-token" });
      return;
    }

    if (!session) {
      // A seat is bound to a Supabase user, so the invitee has to be signed
      // in before it can be claimed. Carry this page (token and all) through
      // the auth pages so they land back here afterwards.
      const here = `/invite/?token=${encodeURIComponent(token)}`;
      const next = `?next=${encodeURIComponent(here)}`;
      setPhase({
        name: "needs-account",
        authHref: `/login/${next}`,
        signupHref: `/signup/${next}`,
      });
      return;
    }

    if (attempted.current) return;
    attempted.current = true;
    accept(session.access_token, token);
  }, [loading, token, session, accept]);

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Invitation</p>
          <h1 className="section-h2">
            {phase.name === "accepted" ? "You're on the plan" : "Join an Arcana VPN plan"}
          </h1>
        </div>
        <div className="dm-card" style={{ maxWidth: "26rem" }}>
          <div style={{ padding: "var(--space-6)" }}>
            {phase.name === "reading" || phase.name === "accepting" ? (
              <p className="section-sub">
                {phase.name === "accepting" ? "Accepting your invitation…" : "Loading…"}
              </p>
            ) : phase.name === "no-token" ? (
              <p className="field-error">
                This invitation link is incomplete. Use the link from your invitation
                email exactly as it was sent.
              </p>
            ) : phase.name === "needs-account" ? (
              <>
                <p className="section-sub">
                  You&apos;ve been invited to share an Arcana VPN plan. Log in or create an
                  account to claim your seat — we&apos;ll bring you straight back here.
                </p>
                <div
                  style={{
                    display: "flex",
                    gap: "var(--space-2)",
                    marginTop: "var(--space-4)",
                  }}
                >
                  <Link
                    href={phase.signupHref}
                    className="btn btn-primary"
                    style={{ flex: 1, textAlign: "center" }}
                  >
                    Create account
                  </Link>
                  <Link
                    href={phase.authHref}
                    className="btn btn-secondary"
                    style={{ flex: 1, textAlign: "center" }}
                  >
                    Log in
                  </Link>
                </div>
              </>
            ) : phase.name === "accepted" ? (
              <>
                <p className="section-sub">
                  {phase.provisioning
                    ? "Your seat is active. We're setting up your own VPN configuration now — it usually takes a few seconds."
                    : "Your seat is active."}
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => router.replace("/dashboard/")}
                  style={{ width: "100%", marginTop: "var(--space-4)" }}
                >
                  Go to dashboard
                </button>
              </>
            ) : (
              <>
                <p className="field-error">{phase.message}</p>
                <p className="text-tiny" style={{ marginTop: "var(--space-4)" }}>
                  Already have a plan of your own?{" "}
                  <Link href="/dashboard" className="text-link">
                    Go to your dashboard
                  </Link>
                  .
                </p>
              </>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
