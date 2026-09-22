"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Phase = "credentials" | "totp";

const FIELD =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500";

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
          await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aal?.nextLevel === "aal2") {
          // A verified factor exists; challenge it. listFactors() narrows
          // `.totp` to verified factors, so the first entry is usable as-is.
          const { data: factors } = await supabase.auth.mfa.listFactors();
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
    await supabase.auth.signOut();
    setPhase("credentials");
    setError("This account does not have admin access.");
  }

  async function handleCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
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

    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
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
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      await routeBySessionLevel(data.session.access_token);
    } else {
      setError("Your session expired. Please sign in again.");
      setPhase("credentials");
    }
    setSubmitting(false);
  }

  async function startOver() {
    await supabase.auth.signOut();
    setPhase("credentials");
    setPassword("");
    setCode("");
    setFactorId(null);
    setError(null);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Arcana VPN
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">
            {phase === "credentials" ? "Admin sign in" : "Two-factor code"}
          </h1>
          {phase === "totp" && (
            <p className="mt-2 text-sm text-gray-500">
              Enter the 6-digit code from your authenticator app.
            </p>
          )}
        </div>

        {phase === "credentials" ? (
          <form onSubmit={handleCredentials} className="flex flex-col gap-4">
            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium text-gray-700">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                className={FIELD}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1 block text-sm font-medium text-gray-700">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                aria-invalid={error ? "true" : undefined}
                className={FIELD}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleTotp} className="flex flex-col gap-4">
            <div>
              <label htmlFor="code" className="mb-1 block text-sm font-medium text-gray-700">
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
                className={`${FIELD} text-center text-lg tracking-[0.4em]`}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </div>

            {error && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || code.length !== 6}
              className="mt-2 w-full rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {submitting ? "Verifying…" : "Verify"}
            </button>

            <button
              type="button"
              onClick={startOver}
              className="text-sm text-gray-500 underline hover:text-gray-700"
            >
              Sign in as someone else
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
