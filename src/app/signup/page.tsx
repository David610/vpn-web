"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { supabase } from "@/lib/supabase";

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
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
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
      // live session directly — go straight to the dashboard instead of
      // telling an already-logged-in user to check their email.
      router.replace("/dashboard/");
      return;
    }
    setSubmitted(true);
  }

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Sign up</p>
          <h1 className="section-h2">Create your account</h1>
        </div>
        <div className="dm-card" style={{ maxWidth: "26rem" }}>
          <div style={{ padding: "var(--space-6)" }}>
            {submitted ? (
              <p className="section-sub">
                Check your email for a confirmation link, then{" "}
                <Link href="/login" className="text-link">
                  log in
                </Link>
                .
              </p>
            ) : (
              <form
                onSubmit={handleSubmit}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-4)",
                }}
              >
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
                    minLength={6}
                    autoComplete="new-password"
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
                  {submitting ? "Creating account…" : "Create account"}
                </button>
                <p className="text-tiny">
                  Already have an account?{" "}
                  <Link href="/login" className="text-link">
                    Log in
                  </Link>
                </p>
              </form>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
