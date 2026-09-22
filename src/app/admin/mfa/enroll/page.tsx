"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

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
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      router.replace("/admin/login");
      return;
    }

    // Confirm this really is an admin before enrolling anything. Verifying a
    // factor signs the user out of all their other sessions, so a customer
    // who wandered onto this URL would be logged out everywhere to gain a
    // factor nothing ever challenges. 403 + mfa_required is the server
    // saying "admin, not stepped up" — exactly who belongs here.
    const probe = await fetch("/api/admin/overview", {
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

    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
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
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }

    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
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

    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
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
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Arcana VPN
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">
            Set up two-factor authentication
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Admin accounts require an authenticator app. Scan this code, then
            enter the 6-digit number it shows.
          </p>
        </div>

        {fatal ? (
          <p className="text-center text-sm text-red-600" role="alert">
            {fatal}
          </p>
        ) : !enrollment ? (
          <p className="text-center text-sm text-gray-500">Preparing…</p>
        ) : (
          <>
            <div className="mb-4 flex justify-center">
              {/* qr_code is an inline SVG data URL from Supabase, so there is
                  nothing for next/image to optimise and no remote host to
                  allow-list. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enrollment.qrCode}
                alt="QR code for two-factor authentication setup"
                width={200}
                height={200}
                className="rounded-lg border border-gray-200 bg-white p-2"
              />
            </div>

            <div className="mb-6 text-center">
              {showSecret ? (
                <p className="break-all rounded-lg bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700">
                  {enrollment.secret}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSecret(true)}
                  className="text-xs text-gray-500 underline hover:text-gray-700"
                >
                  Can&apos;t scan? Enter the key manually
                </button>
              )}
            </div>

            <form onSubmit={handleVerify} className="flex flex-col gap-4">
              <div>
                <label htmlFor="code" className="mb-1 block text-sm font-medium text-gray-700">
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
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-center text-lg tracking-[0.4em] outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500"
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
                className="w-full rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {submitting ? "Verifying…" : "Activate"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
