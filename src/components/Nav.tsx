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
      <nav className="dm-nav__desktop">
        {loading ? null : session ? (
          <>
            <Link href="/dashboard" className="dm-nav__link">
              Dashboard
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
          <>
            <Link href="/login" className="dm-nav__link">
              Log in
            </Link>
            <Link href="/signup" className="btn btn-primary dm-nav__cta">
              Get started
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
