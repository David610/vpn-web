"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { supabase } from "@/lib/supabase";
import { signInErrorMessage } from "@/lib/auth-errors";
import { safeNextPath } from "@/lib/next-path";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
    // it, not on the dashboard. safeNextPath rejects anything that is not
    // a same-origin path.
    router.replace(safeNextPath(window.location.search));
  }

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="auth-frame">
          <p className="auth-brand">Arcana</p>
          <div className="auth-head">
            <h1 className="section-h2">Log in</h1>
          </div>
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
                className="field"
                aria-invalid={error ? "true" : undefined}
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
          <p className="text-tiny auth-foot">
            <Link href="/forgot-password" className="text-link">
              Forgot your password?
            </Link>
          </p>
          <p className="text-tiny auth-foot">
            No account yet?{" "}
            <Link href="/signup" className="text-link">
              Sign up
            </Link>
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
