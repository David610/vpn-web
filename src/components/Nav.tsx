"use client";

import { useState } from "react";
import Link from "next/link";
import { SITE_NAME } from "@/lib/site-config";
import { useSession } from "@/hooks/useSession";
import { supabase } from "@/lib/supabase";

export default function Nav() {
  const { session, loading } = useSession();
  const [open, setOpen] = useState(false);

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
      <button
        type="button"
        className="btn btn-secondary dm-nav__toggle"
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
        <Link href="/#features" className="dm-nav__link" onClick={() => setOpen(false)}>
          Features
        </Link>
        <Link href="/#locations" className="dm-nav__link" onClick={() => setOpen(false)}>
          Locations
        </Link>
        <Link href="/#pricing" className="dm-nav__link" onClick={() => setOpen(false)}>
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
