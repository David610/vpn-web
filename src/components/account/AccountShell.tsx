"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { useSession } from "@/hooks/useSession";
import { api } from "@/lib/api";
import type { Overview } from "./types";

const ICONS: Record<string, string> = {
  Overview: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  Devices: "M5 5h14v10H5zM3 19h18",
  Links: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  Subscription: "M4 6h16v12H4zM4 10h16",
  Billing: "M7 3h10v18l-2-1.5-3 1.5-3-1.5L7 21zM10 8h4M10 12h4",
  Settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
};

const LINKS = [
  { href: "/account/", label: "Overview" },
  { href: "/account/devices/", label: "Devices" },
  { href: "/account/links/", label: "Links" },
  { href: "/account/subscription/", label: "Subscription" },
  { href: "/account/billing/", label: "Billing" },
  { href: "/account/settings/", label: "Settings" },
];

function NavIcon({ label }: { label: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[label]} />
    </svg>
  );
}

type AccountContext = {
  session: Session;
  overview: Overview | null;
  error: string | null;
  reload: () => Promise<void>;
};

const Ctx = createContext<AccountContext | null>(null);

export function useAccount() {
  const value = useContext(Ctx);
  if (!value) throw new Error("useAccount outside AccountShell");
  return value;
}

/**
 * Signed-in account area: text sidebar, page heading, and the account
 * overview (subscriptions, devices, capacity) shared by every page.
 */
export function AccountShell({
  eyebrow,
  title,
  sub,
  action,
  crumbs,
  children,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  action?: React.ReactNode;
  crumbs?: Array<{ label: string; href?: string }>;
  children: React.ReactNode;
}) {
  const { session, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!session) return;
    try {
      setOverview(await api<Overview>(session, "/api/account/overview"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your account.");
    }
  }, [session]);

  useEffect(() => {
    if (!loading && !session) router.replace(`/login/?next=${encodeURIComponent(pathname)}`);
  }, [loading, session, router, pathname]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = (href: string) =>
    href === "/account/" ? pathname === "/account" || pathname === "/account/" : pathname.startsWith(href.slice(0, -1));

  const currentLink = LINKS.find((link) => current(link.href)) ?? LINKS[0];

  return (
    <>
      <Nav />
      <div className="area">
        <aside className="area__side">
          <p className="area__label">Account</p>
          <nav className="area__nav" aria-label="Account">
            {LINKS.map((link) => (
              <Link key={link.href} href={link.href} aria-current={current(link.href) ? "page" : undefined}>
                <NavIcon label={link.label} />
                {link.label}
              </Link>
            ))}
          </nav>
          <details className="area__nav-mobile">
            <summary>
              <span className="area__nav-mobile-label">
                Account <span aria-hidden="true">/</span> {currentLink.label}
              </span>
              <span className="area__nav-mobile-chevron" aria-hidden="true">⌄</span>
            </summary>
            <nav className="area__nav-mobile-list" aria-label="Account sections">
              {LINKS.map((link) => (
                <Link key={link.href} href={link.href} aria-current={current(link.href) ? "page" : undefined}>
                  {link.label}
                </Link>
              ))}
            </nav>
          </details>
        </aside>
        <main className="area__main">
          {title || action || crumbs ? <header className="area__head">
            <div>
              {crumbs ? (
                <nav className="crumbs" aria-label="Breadcrumb">
                  {crumbs.map((c, i) => (
                    <span key={c.label}>
                      {i > 0 ? <span aria-hidden="true"> › </span> : null}
                      {c.href ? <Link href={c.href}>{c.label}</Link> : c.label}
                    </span>
                  ))}
                </nav>
              ) : null}
              <p className="area__eyebrow">{eyebrow}</p>
              {title ? <h1 className="area__title">{title}</h1> : null}
              {sub ? <p className="area__sub">{sub}</p> : null}
            </div>
            {action ? <div className="area__action">{action}</div> : null}
          </header> : null}
          {!session ? (
            <p className="muted">{loading ? "Loading…" : "Redirecting to log in…"}</p>
          ) : (
            <Ctx.Provider value={{ session, overview, error, reload }}>
              {error && !overview ? <p className="notice notice--error">{error}</p> : null}
              {children}
            </Ctx.Provider>
          )}
        </main>
      </div>
      <Footer />
    </>
  );
}

/** Inline error/success line for a form or action. */
export function Feedback({ error, done }: { error: string | null; done?: string | null }) {
  if (error) return <p className="notice notice--error" role="alert">{error}</p>;
  if (done) return <p className="notice" role="status">{done}</p>;
  return null;
}
