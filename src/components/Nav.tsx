"use client";

import Link from "next/link";
import { SITE_NAME } from "@/lib/site-config";
import { useSession } from "@/hooks/useSession";
import { supabase } from "@/lib/supabase";

export default function Nav() {
  const { session, loading } = useSession();

  async function handleLogout() {
    await supabase.auth.signOut().catch((err) => {
      console.error("Sign out failed:", err.message);
    });
    window.location.href = "/";
  }

  return (
    <header className="dm-nav">
      <Link href="/" className="dm-nav__brand">
        {SITE_NAME}
      </Link>
      <nav className="dm-nav__desktop" aria-label="Main">
        <Link href="/#features" className="dm-nav__link">
          Features
        </Link>
        <Link href="/#locations" className="dm-nav__link">
          Locations
        </Link>
        <Link href="/#pricing" className="dm-nav__link">
          Pricing
        </Link>
        {loading ? null : session ? (
          <>
            <Link href="/account/" className="dm-nav__link">
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
          <Link href="/login" className="btn btn-secondary dm-nav__cta">
            Log in
          </Link>
        )}
      </nav>
    </header>
  );
}
