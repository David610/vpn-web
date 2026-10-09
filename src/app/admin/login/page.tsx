"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import AuthShell from "@/components/auth/AuthShell";
import PasswordField from "@/components/auth/PasswordField";
import { supabaseAdmin } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-base";

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
  async function routeBySessionLevel(accessToken: string, otp = "") {
    const res = await fetch(apiUrl("/api/admin/overview"), {
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
            // A code typed into the combined form is verified right away; with
            // none (or a wrong one) the dedicated code screen takes over.
            if (/^\d{6}$/.test(otp) && (await verifyCode(totp.id, otp))) return;
            setFactorId(totp.id);
            setCode("");
            setPhase("totp");
            setError(otp ? "That code is not valid. Check your authenticator and try again." : null);
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

  /** Verifies a TOTP code, which upgrades the session to aal2 in place, then routes on. */
  async function verifyCode(id: string, otp: string): Promise<boolean> {
    const { error: verifyError } = await supabaseAdmin.auth.mfa.challengeAndVerify({ factorId: id, code: otp.trim() });
    if (verifyError) {
      console.error("admin MFA verify failed:", verifyError.message);
      return false;
    }
    const { data } = await supabaseAdmin.auth.getSession();
    if (!data.session) return false;
    await routeBySessionLevel(data.session.access_token);
    return true;
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

    await routeBySessionLevel(data.session.access_token, code);
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
    <AuthShell
      corner="none"
      title={phase === "credentials" ? "Admin sign in" : "Two-factor code"}
      sub={phase === "credentials" ? "Sign in to manage Arcana." : "Enter the 6-digit code from your authenticator app."}
      foot={<p>Two-step verification is required for administrators.</p>}
    >
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
          <PasswordField id="password" label="Password" autoComplete="current-password" value={password} onChange={setPassword} error={error} />
          <div>
            <label className="field-label" htmlFor="otp">
              Authenticator code
            </label>
            <input
              id="otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="6-digit code"
              className="field"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
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
          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={submitting || code.length !== 6}>
            {submitting ? "Verifying…" : "Verify"}
          </button>
          <p className="auth-form__aside">
            <button type="button" onClick={startOver} className="text-link">
              Log in as someone else
            </button>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
