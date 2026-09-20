"use client";

// Do not "fix" cross-device / already-used confirmation links by adding
// @supabase/ssr or cookie-based session handling. This app has no server
// runtime (output: 'export') and no middleware, so a server/cookie auth
// client is architecturally wrong here — see src/lib/supabase.ts. The
// account is already confirmed server-side even when this page's client-side
// exchange fails (e.g. the link was opened in a different browser than the
// one that holds the PKCE code verifier, or already used); the correct and
// complete fix is exactly the friendly-message-plus-login-link below, since
// the user can simply log in directly once the server-side confirmation has
// happened.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { supabase } from "@/lib/supabase";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function run() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      if (!code) {
        setError(
          "Missing confirmation code — this link may be incomplete or already used."
        );
        return;
      }
      const { error: exchangeError } =
        await supabase.auth.exchangeCodeForSession(code);
      if (exchangeError) {
        // Do not render exchangeError.message to the user — it's raw SDK
        // text that can differ by cause (already used, wrong browser,
        // expired) without ever telling the user their account may already
        // be confirmed. Log it for our own debugging only.
        console.error("exchangeCodeForSession failed:", exchangeError.message);
        setError(
          "This confirmation link didn't work — it may have already been used, or opened in a different browser than you signed up in. If you already tried to confirm your email, you can just log in directly."
        );
        return;
      }
      router.replace("/dashboard/");
    }
    run();
  }, [router]);

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Confirming</p>
          <h1 className="section-h2">
            {error ? "Something went wrong" : "Confirming your email…"}
          </h1>
          {error && (
            <p className="section-sub">
              {error}{" "}
              <Link href="/login" className="text-link">
                Log in
              </Link>
              .
            </p>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
