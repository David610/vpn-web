"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { supabaseAdmin } from "@/lib/supabase";

type Phase = "credentials" | "totp";

export default function AdminLoginPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * Decides where an authenticated session goes next. /api/admin/overview
   * is the authority: 200 means admin at aal2, 403 + mfa_required means a
   * real admin on a password-only session, 401 means not an admin at all.
   * Asking the server rather than reading local claims keeps the browser
   * from deciding its own privilege, and means a non-admin is never shown
   * an MFA prompt for a role they do not hold.
   */
  async function routeBySessionLevel(accessToken: string) {
    const res = await fetch("/api/admin/overview", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.ok) {
      router.replace("/admin");
      return;
    }

    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      if (body.code === "mfa_required") {
        const { data: aal } =
          await supabaseAdmin.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aal?.nextLevel === "aal2") {
          // A verified factor exists; challenge it. listFactors() narrows
          // `.totp` to verified factors, so the first entry is usable as-is.
          const { data: factors } = await supabaseAdmin.auth.mfa.listFactors();
          const totp = factors?.totp[0];
          if (totp) {
            setFactorId(totp.id);
            setCode("");
            setPhase("totp");
            setError(null);
            return;
          }
        }
        // Admin with no verified factor yet — enroll one.
        router.replace("/admin/mfa/enroll");
        return;
      }
    }

    // 401, or anything else we cannot make sense of: not an admin. Drop the
    // session so nobody is left half-authenticated on an admin URL.
    await supabaseAdmin.auth.signOut();
    setPhase("credentials");
    setError("This account does not have admin access.");
  }

  async function handleCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const { data, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError || !data.session) {
      setSubmitting(false);
      // Never rendered verbatim: under this repo's Supabase config the
      // message distinguishes "Email not confirmed" from "Invalid login
      // credentials," which is a user-enumeration oracle.
      console.error("admin signIn failed:", signInError?.message);
      setError("Invalid email or password.");
      return;
    }

    await routeBySessionLevel(data.session.access_token);
    setSubmitting(false);
  }

  async function handleTotp(e: FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setError(null);
    setSubmitting(true);

    const { error: verifyError } = await supabaseAdmin.auth.mfa.challengeAndVerify({
      factorId,
      code: code.trim(),
    });

    if (verifyError) {
      setSubmitting(false);
      console.error("admin MFA verify failed:", verifyError.message);
      setError("That code is not valid. Check your authenticator and try again.");
      setCode("");
      return;
    }

    // challengeAndVerify upgrades the current session to aal2 in place, so
    // the stored session now carries a token the admin routes will accept.
    const { data } = await supabaseAdmin.auth.getSession();
    if (data.session) {
      await routeBySessionLevel(data.session.access_token);
    } else {
      setError("Your session expired. Please sign in again.");
      setPhase("credentials");
    }
    setSubmitting(false);
  }

  async function startOver() {
    await supabaseAdmin.auth.signOut();
    setPhase("credentials");
    setPassword("");
    setCode("");
    setFactorId(null);
    setError(null);
  }

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="auth-frame">
          <p className="auth-brand">Arcana admin</p>
          <div className="auth-head">
            <h1 className="section-h2">
              {phase === "credentials" ? "Admin log in" : "Two-factor code"}
            </h1>
            {phase === "totp" && (
              <p className="section-sub">
                Enter the 6-digit code from your authenticator app.
              </p>
            )}
          </div>

          {phase === "credentials" ? (
            <form onSubmit={handleCredentials} className="auth-form">
              <div>
                <label className="field-label" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  className="field"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  aria-invalid={error ? "true" : undefined}
                  className="field"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {error && <span className="field-error">{error}</span>}
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting}
                style={{ width: "100%" }}
              >
                {submitting ? "Logging in…" : "Log in"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleTotp} className="auth-form">
              <div>
                <label className="field-label" htmlFor="code">
                  Authentication code
                </label>
                <input
                  id="code"
                  type="text"
                  required
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  aria-invalid={error ? "true" : undefined}
                  className="field"
                  style={{ textAlign: "center", letterSpacing: "0.4em" }}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                />
                {error && <span className="field-error">{error}</span>}
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting || code.length !== 6}
                style={{ width: "100%" }}
              >
                {submitting ? "Verifying…" : "Verify"}
              </button>
              <p className="text-tiny auth-foot">
                <button type="button" onClick={startOver} className="text-link">
                  Log in as someone else
                </button>
              </p>
            </form>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
