"use client";

// Password recovery page. Supabase sends a recovery email containing a
// ?code= parameter (PKCE flow, same mechanism as /auth/callback). We exchange
// the code for a session, then let the user set a new password.
//
// If exchange fails (already used, wrong browser, expired) we show a friendly
// message with a link back to /forgot-password so the user can request a fresh
// link, rather than a raw SDK error.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { supabase } from "@/lib/supabase";

type Phase = "exchanging" | "set-password" | "exchange-failed" | "success" | "error";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("exchanging");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function exchange() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      if (!code) {
        setPhase("exchange-failed");
        return;
      }
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.error("reset-password exchangeCodeForSession failed:", error.message);
        setPhase("exchange-failed");
        return;
      }
      setPhase("set-password");
    }
    exchange();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFieldError(null);
    if (password.length < 6) {
      setFieldError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setFieldError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (error) {
      console.error("reset-password updateUser failed:", error.message);
      setPhase("error");
      return;
    }
    setPhase("success");
    setTimeout(() => router.replace("/dashboard/"), 2000);
  }

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Password reset</p>
          {phase === "exchanging" && (
            <h1 className="section-h2">Verifying your reset link…</h1>
          )}
          {phase === "exchange-failed" && (
            <>
              <h1 className="section-h2">Link expired or already used</h1>
              <p className="section-sub">
                This reset link didn&apos;t work — it may have already been
                used or expired. You can{" "}
                <Link href="/forgot-password" className="text-link">
                  request a new reset link
                </Link>
                .
              </p>
            </>
          )}
          {(phase === "set-password" || phase === "error") && (
            <h1 className="section-h2">Set a new password</h1>
          )}
          {phase === "success" && (
            <>
              <h1 className="section-h2">Password updated</h1>
              <p className="section-sub">
                Your password has been changed. Redirecting you to your
                dashboard…
              </p>
            </>
          )}
        </div>

        {phase === "set-password" || phase === "error" ? (
          <div className="dm-card" style={{ maxWidth: "26rem" }}>
            <div style={{ padding: "var(--space-6)" }}>
              {phase === "error" && (
                <p
                  className="field-error"
                  style={{ marginBottom: "var(--space-4)" }}
                >
                  Something went wrong updating your password. Please try again
                  or{" "}
                  <Link href="/forgot-password" className="text-link">
                    request a new reset link
                  </Link>
                  .
                </p>
              )}
              <form
                onSubmit={handleSubmit}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-4)",
                }}
              >
                <div>
                  <label className="field-label" htmlFor="password">
                    New password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    autoComplete="new-password"
                    className="field"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="confirm">
                    Confirm new password
                  </label>
                  <input
                    id="confirm"
                    type="password"
                    required
                    autoComplete="new-password"
                    className="field"
                    aria-invalid={fieldError ? "true" : undefined}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                  {fieldError && (
                    <span className="field-error">{fieldError}</span>
                  )}
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                  style={{ width: "100%" }}
                >
                  {submitting ? "Updating…" : "Update password"}
                </button>
              </form>
            </div>
          </div>
        ) : null}
      </main>
      <Footer />
    </>
  );
}
