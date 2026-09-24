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

const LINKS = [
  { href: "/account/", label: "Overview" },
  { href: "/account/subscriptions/", label: "Subscriptions" },
  { href: "/account/devices/", label: "Devices" },
  { href: "/account/connections/", label: "Connections" },
  { href: "/account/billing/", label: "Billing" },
  { href: "/account/security/", label: "Security" },
  { href: "/account/help/", label: "Help" },
];

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
  children,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
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

  return (
    <>
      <Nav />
      <div className="area">
        <aside className="area__side">
          <p className="area__label">Account</p>
          <nav className="area__nav" aria-label="Account">
            {LINKS.map((link) => (
              <Link key={link.href} href={link.href} aria-current={current(link.href) ? "page" : undefined}>
                {link.label}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="area__main">
          <header className="area__head">
            <p className="area__eyebrow">{eyebrow}</p>
            <h1 className="area__title">{title}</h1>
            {sub ? <p className="area__sub">{sub}</p> : null}
          </header>
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
