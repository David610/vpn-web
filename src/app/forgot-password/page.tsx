"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { supabase } from "@/lib/supabase";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    // Anti-enumerate: always show the same generic success message regardless
    // of whether this email exists in the system. Do not surface the error.
    await supabase.auth
      .resetPasswordForEmail(email, {
        redirectTo:
          typeof window !== "undefined"
            ? `${window.location.origin}/auth/reset-password/`
            : undefined,
      })
      .catch((err) => {
        console.error("resetPasswordForEmail failed:", err.message);
      });
    setSubmitting(false);
    setSubmitted(true);
  }

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="auth-frame">
          <p className="auth-brand">Arcana</p>
          <div className="auth-head">
            <h1 className="section-h2">Forgot your password?</h1>
            {!submitted && (
              <p className="section-sub">
                Enter your email address and we&apos;ll send you a reset link.
              </p>
            )}
          </div>
          {submitted ? (
            <>
              <p style={{ marginBottom: "var(--space-4)" }}>
                If an account exists for this email, you will receive a reset
                link shortly. Check your inbox and spam folder.
              </p>
              <p className="text-tiny auth-foot">
                <Link href="/login" className="text-link">
                  Back to log in
                </Link>
              </p>
            </>
          ) : (
            <>
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
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                  style={{ width: "100%" }}
                >
                  {submitting ? "Sending…" : "Send reset link"}
                </button>
              </form>
              <p className="text-tiny auth-foot">
                <Link href="/login" className="text-link">
                  Back to log in
                </Link>
              </p>
            </>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
