"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AuthShell from "@/components/auth/AuthShell";
import PasswordField from "@/components/auth/PasswordField";
import { supabase } from "@/lib/supabase";
import { signInErrorMessage } from "@/lib/auth-errors";
import { safeNextPath } from "@/lib/next-path";

const ACCOUNT_HOME = "/account/";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Someone who is already signed in has no reason to see the form. A
  // deliberate ?next= (an invite, a deep link) is kept; safeNextPath
  // rejects anything that is not a same-origin path.
  useEffect(() => {
    let live = true;
    supabase.auth.getSession().then(({ data }) => {
      if (live && data.session) router.replace(safeNextPath(window.location.search, ACCOUNT_HOME));
    });
    return () => {
      live = false;
    };
  }, [router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setSubmitting(false);
    if (signInError) {
      // Do not render signInError.message verbatim — under this repo's
      // config it distinguishes "Email not confirmed" from "Invalid login
      // credentials," which is a user-enumeration oracle. Log it for our
      // own debugging only.
      console.error("signIn failed:", signInError.message);
      setError(signInErrorMessage(signInError));
      return;
    }
    // An invitee arrives here from an invite link and must land back on
    // it, not on the account home. safeNextPath rejects anything that is
    // not a same-origin path.
    router.replace(safeNextPath(window.location.search, ACCOUNT_HOME));
  }

  return (
    <AuthShell
      corner="help"
      title="Log in to Arcana"
      sub="Manage your VPN links."
      foot={
        <p>
          New to Arcana?{" "}
          <Link href="/signup" className="text-link">
            Create account
          </Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit} className="auth-form">
        <div>
          <label className="field-label" htmlFor="email">
            Email
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
          autoComplete="current-password"
          placeholder="Enter your password"
          value={password}
          onChange={setPassword}
          error={error}
        />
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={submitting}>
          {submitting ? (
            "Logging in…"
          ) : (
            <>
              Log in <span aria-hidden="true">→</span>
            </>
          )}
        </button>
        <p className="auth-form__aside">
          <Link href="/forgot-password" className="text-link">
            Forgot password?
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
