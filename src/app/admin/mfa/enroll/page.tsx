"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import AuthShell from "@/components/auth/AuthShell";
import { supabaseAdmin } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-base";

type Enrollment = { factorId: string; qrCode: string; secret: string };

export default function AdminMfaEnrollPage() {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // React 18+ StrictMode double-invokes effects in development; enrolling
  // twice would leave an orphaned unverified factor and a QR code that no
  // longer matches the factor we verify against.
  const started = useRef(false);

  const begin = useCallback(async () => {
    const { data: sessionData } = await supabaseAdmin.auth.getSession();
    if (!sessionData.session) {
      router.replace("/admin/login");
      return;
    }

    // Confirm this really is an admin before enrolling anything. Verifying a
    // factor signs the user out of all their other sessions, so a customer
    // who wandered onto this URL would be logged out everywhere to gain a
    // factor nothing ever challenges. 403 + mfa_required is the server
    // saying "admin, not stepped up" — exactly who belongs here.
    const probe = await fetch(apiUrl("/api/admin/overview"), {
      headers: { Authorization: `Bearer ${sessionData.session.access_token}` },
    });
    if (probe.ok) {
      router.replace("/admin");
      return;
    }
    const probeBody = await probe.json().catch(() => ({}));
    if (probe.status !== 403 || probeBody.code !== "mfa_required") {
      router.replace("/admin/login");
      return;
    }

    const { data: factors, error: listError } = await supabaseAdmin.auth.mfa.listFactors();
    if (listError) {
      console.error("mfa.listFactors failed:", listError.message);
      setFatal("Could not read your authentication factors. Please try again.");
      return;
    }

    // listFactors() narrows `.totp` to verified factors; `.all` is the only
    // place unverified ones appear.
    if (factors && factors.totp.length > 0) {
      // Already has a working factor: this page has nothing to add, and the
      // session just needs to step up. Send them back to sign in.
      router.replace("/admin/login");
      return;
    }

    // Clear out abandoned half-finished enrollments so a fresh QR code is
    // the only one in play. Unverified factors grant nothing, so dropping
    // them cannot weaken the account.
    const stale =
      factors?.all.filter(
        (f) => f.factor_type === "totp" && f.status === "unverified"
      ) ?? [];
    for (const factor of stale) {
      await supabaseAdmin.auth.mfa.unenroll({ factorId: factor.id });
    }

    const { data, error: enrollError } = await supabaseAdmin.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Arcana Admin (${new Date().toISOString().slice(0, 10)})`,
    });
    if (enrollError || !data) {
      console.error("mfa.enroll failed:", enrollError?.message);
      setFatal("Could not start enrollment. Please try again.");
      return;
    }

    setEnrollment({
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    });
  }, [router]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin();
  }, [begin]);

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    if (!enrollment) return;
    setError(null);
    setSubmitting(true);

    const { error: verifyError } = await supabaseAdmin.auth.mfa.challengeAndVerify({
      factorId: enrollment.factorId,
      code: code.trim(),
    });

    setSubmitting(false);

    if (verifyError) {
      console.error("mfa enrollment verify failed:", verifyError.message);
      setError("That code is not valid. Check your authenticator and try again.");
      setCode("");
      return;
    }

    // Verifying promotes this session to aal2, so the admin routes will now
    // accept it without a second sign-in.
    router.replace("/admin");
  }

  return (
    <AuthShell
      corner="none"
      title="Set up two-factor authentication"
      sub="Admin accounts require an authenticator app. Scan this code, then enter the 6-digit number it shows."
    >

          {fatal ? (
            <span className="field-error" role="alert">
              {fatal}
            </span>
          ) : !enrollment ? (
            <p className="text-tiny">Preparing…</p>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  marginBottom: "var(--space-4)",
                }}
              >
                {/* qr_code is an inline SVG data URL from Supabase, so there is
                    nothing for next/image to optimise and no remote host to
                    allow-list. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={enrollment.qrCode}
                  alt="QR code for two-factor authentication setup"
                  width={200}
                  height={200}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-lg)",
                    background: "#fff",
                    padding: "var(--space-2)",
                  }}
                />
              </div>

              <p
                className="text-tiny"
                style={{ textAlign: "center", marginBottom: "var(--space-6)" }}
              >
                {showSecret ? (
                  <code style={{ wordBreak: "break-all" }}>{enrollment.secret}</code>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowSecret(true)}
                    className="text-link"
                  >
                    Can&apos;t scan? Enter the key manually
                  </button>
                )}
              </p>

              <form onSubmit={handleVerify} className="auth-form">
                <div>
                  <label className="field-label" htmlFor="code">
                    Authentication code
                  </label>
                  <input
                    id="code"
                    type="text"
                    required
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
                  className="btn btn-primary btn-block btn-lg"
                  disabled={submitting || code.length !== 6}
                >
                  {submitting ? "Verifying…" : "Activate"}
                </button>
              </form>
            </>
          )}
    </AuthShell>
  );
}
