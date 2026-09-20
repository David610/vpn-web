"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
        setError(exchangeError.message);
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
          {error && <p className="section-sub">{error}</p>}
        </div>
      </main>
      <Footer />
    </>
  );
}
