"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AuthShell from "@/components/auth/AuthShell";
import PasswordField from "@/components/auth/PasswordField";
import { supabase } from "@/lib/supabase";
import { safeNextPath } from "@/lib/next-path";
import { PLAN_PRICE_LABEL } from "@/lib/site-config";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    setSubmitting(true);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo:
          typeof window !== "undefined"
            ? `${window.location.origin}/auth/callback/`
            : undefined,
      },
    });
    setSubmitting(false);
    if (signUpError) {
      // Do not render signUpError.message verbatim — under this repo's
      // config it distinguishes "User already registered" from a new-email
      // success, which is a user-enumeration oracle. Log it for our own
      // debugging only.
      console.error("signUp failed:", signUpError.message);
      setError(
        "Something went wrong creating your account. If you already have an account with this email, try logging in instead."
      );
      return;
    }
    if (data.session) {
      // Confirmation is off (or already satisfied) and signUp() returned a
      // live session directly — go straight on instead of telling an
      // already-logged-in user to check their email. An invitee signing up
      // to accept a seat returns to the invite via ?next=.
      router.replace(safeNextPath(window.location.search, "/account/"));
      return;
    }
    setSubmitted(true);
  }

  return (
    <AuthShell
      corner="login"
      title={submitted ? "Check your email" : "Create your account"}
      sub={submitted ? undefined : "Manage your VPN links in one place."}
      foot={
        submitted ? undefined : (
          <p>
            {PLAN_PRICE_LABEL} / month <span aria-hidden="true">·</span> One plan. Subscribe after signup.
          </p>
        )
      }
    >
      {submitted ? (
        <p className="auth-card__sub">
          We sent a confirmation link to {email}. Open it, then{" "}
          <Link
            href={`/login/${typeof window !== "undefined" ? window.location.search : ""}`}
            className="text-link"
          >
            log in
          </Link>
          .
        </p>
      ) : (
        <>
          <form onSubmit={handleSubmit} className="auth-form">
            <div>
              <label className="field-label" htmlFor="email">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="field"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <PasswordField
              id="password"
              label="Password"
              autoComplete="new-password"
              placeholder="Create a strong password"
              minLength={12}
              value={password}
              onChange={setPassword}
              error={error}
            />
            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={submitting}>
              {submitting ? (
                "Creating account…"
              ) : (
                <>
                  Create account <span aria-hidden="true">→</span>
                </>
              )}
            </button>
          </form>
          <p className="auth-form__aside auth-form__aside--center">
            Already have an account?{" "}
            <Link href="/login" className="text-link">
              Log in
            </Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
