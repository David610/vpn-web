"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { supabase } from "@/lib/supabase";

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
      setError("Invalid email or password.");
      return;
    }
    router.replace("/dashboard/");
  }

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Log in</p>
          <h1 className="section-h2">Welcome back</h1>
        </div>
        <div className="dm-card" style={{ maxWidth: "26rem" }}>
          <div style={{ padding: "var(--space-6)" }}>
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
              <p className="text-tiny">
                No account yet?{" "}
                <Link href="/signup" className="text-link">
                  Sign up
                </Link>
              </p>
            </form>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
