"use client";

import { useState } from "react";
import Link from "next/link";
import { SITE_NAME } from "@/lib/site-config";
import { useLocalSessionFlag } from "@/hooks/useLocalSessionFlag";

export default function Nav() {
  // Reads localStorage directly instead of useSession()/the Supabase client
  // (F-44/K-04) — this component renders on every public page, and the only
  // thing it needs auth state for is which nav link to show.
  const { hasSession: session, loading } = useLocalSessionFlag();
  const [open, setOpen] = useState(false);

  async function handleLogout() {
    // Dynamically imported so the Supabase SDK chunk still isn't part of
    // this component's own bundle — it only loads if someone who is signed
    // in actually clicks "Log out".
    const { supabase } = await import("@/lib/supabase");
    await supabase.auth.signOut().catch((err: { message: string }) => {
      console.error("Sign out failed:", err.message);
    });
    window.location.href = "/";
  }

  return (
    <header className="dm-nav">
      <Link href="/" className="dm-nav__brand">
        {SITE_NAME}
      </Link>
      <button
        type="button"
        className="dm-nav__toggle"
        aria-expanded={open}
        aria-controls="dm-nav-menu"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Close" : "Menu"}
      </button>
      <nav
        id="dm-nav-menu"
        className={`dm-nav__desktop${open ? " dm-nav__desktop--open" : ""}`}
        aria-label="Main"
      >
        <Link href="/locations" className="dm-nav__link" onClick={() => setOpen(false)}>
          Locations
        </Link>
        <Link href="/pricing" className="dm-nav__link" onClick={() => setOpen(false)}>
          Pricing
        </Link>
        {loading ? null : session ? (
          <>
            <Link href="/account/" className="dm-nav__link" onClick={() => setOpen(false)}>
              Account
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="btn btn-secondary dm-nav__cta"
            >
              Log out
            </button>
          </>
        ) : (
          <Link href="/login" className="btn btn-secondary dm-nav__cta" onClick={() => setOpen(false)}>
            Log in
          </Link>
        )}
      </nav>
    </header>
  );
}
