"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SITE_NAME } from "@/lib/site-config";
import { useLocalSessionFlag } from "@/hooks/useLocalSessionFlag";

const LINKS = [
  { href: "/apps", label: "Product" },
  { href: "/locations", label: "Locations" },
  { href: "/pricing", label: "Pricing" },
  { href: "/help", label: "Help" },
];

// Same localStorage entry useLocalSessionFlag reads; only the email is taken from it, for the avatar chip.
function readEmail(): string | null {
  try {
    const raw = window.localStorage.getItem("arcana-auth-v1");
    const email = raw ? JSON.parse(raw)?.user?.email : null;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

export default function Nav() {
  // Reads localStorage directly instead of useSession()/the Supabase client
  // (F-44/K-04) — this component renders on every public page, and the only
  // thing it needs auth state for is which nav link to show.
  const { hasSession: session, loading } = useLocalSessionFlag();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => setEmail(readEmail()), [session]);
  const pathname = usePathname() ?? "";

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

  const close = () => setOpen(false);
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

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
        <div className="dm-nav__links">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`dm-nav__link${isActive(l.href) ? " dm-nav__link--active" : ""}`}
              aria-current={isActive(l.href) ? "page" : undefined}
              onClick={close}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="dm-nav__actions">
          {loading ? null : session ? (
            <>
              <Link href="/account/" className="dm-nav__account" onClick={close}>
                <span className="dm-nav__avatar" aria-hidden="true">
                  {(email ?? "A").charAt(0).toUpperCase()}
                </span>
                <span className="dm-nav__email">{email ?? "Account"}</span>
              </Link>
              <button type="button" onClick={handleLogout} className="dm-nav__link dm-nav__logout">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="dm-nav__link" onClick={close}>
                Log in
              </Link>
              <Link href="/signup" className="btn btn-primary dm-nav__cta" onClick={close}>
                Get {SITE_NAME}
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
