"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import UserMenu from "@/components/UserMenu";
import { useSession } from "@/hooks/useSession";
import { api } from "@/lib/api";
import { SITE_NAME } from "@/lib/site-config";
import type { Overview } from "./types";

const ICONS = {
  links: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  account: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5",
  telegram: "M21 3L10 14M21 3l-7 18-4-7-7-4z",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01",
} as const;

const NAV = [
  { href: "/account/", label: "VPN links", icon: "links" as const, match: (p: string) => p === "/account" || p.startsWith("/account/links") },
  { href: "/account/plan/", label: "Account & plan", icon: "account" as const, match: (p: string) => p.startsWith("/account/plan") },
  { href: "/account/telegram/", label: "Telegram", icon: "telegram" as const, match: (p: string) => p.startsWith("/account/telegram") },
  { href: "/account/help/", label: "Help", icon: "help" as const, match: (p: string) => p.startsWith("/account/help") },
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

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

async function signOutCustomer() {
  // Dynamic import keeps the Supabase client out of the shell's first paint.
  const { supabase } = await import("@/lib/supabase");
  await supabase.auth.signOut().catch((err: { message: string }) => {
    console.error("Sign out failed:", err.message);
  });
  window.location.href = "/";
}

/**
 * Signed-in portal: brand and user menu on top, four sections on the left, no
 * marketing navigation. Loads the account overview once for every page.
 */
export function AccountShell({
  title,
  sub,
  action,
  top,
  back,
  narrow = false,
  children,
}: {
  title?: string;
  sub?: string;
  action?: React.ReactNode;
  top?: React.ReactNode;
  back?: { href: string; label: string };
  narrow?: boolean;
  children: React.ReactNode;
}) {
  const { session, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname() ?? "";
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

  const email = overview?.email ?? session?.user.email ?? "";

  return (
    <div className="ps">
      <header className="ps-top">
        <Link href="/account/" className="ps-top__brand">
          {SITE_NAME}
        </Link>
        {email ? <UserMenu email={email} onSignOut={signOutCustomer} /> : null}
      </header>
      <div className="ps-body">
        <nav className="ps-side" aria-label="Account">
          {NAV.map((item) => {
            const current = item.match(pathname.replace(/\/$/, "") || "/");
            return (
              <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined}>
                <Icon name={item.icon} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <main className={`ps-main${narrow ? " ps-main--narrow" : ""}`} id="portal-main">
          {!session ? (
            <p className="muted">{loading ? "Loading…" : "Redirecting to log in…"}</p>
          ) : (
            <Ctx.Provider value={{ session, overview, error, reload }}>
              {back ? (
                <Link href={back.href} className="ps-back">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M19 12H5M11 6l-6 6 6 6" />
                  </svg>
                  {back.label}
                </Link>
              ) : null}
              {top}
              {title || action ? (
                <header className="ps-head">
                  <div>
                    {title ? <h1 className="ps-title">{title}</h1> : null}
                    {sub ? <p className="ps-sub">{sub}</p> : null}
                  </div>
                  {action ? <div className="ps-head__action">{action}</div> : null}
                </header>
              ) : null}
              {error && !overview ? <p className="notice notice--error" role="alert">{error}</p> : null}
              {children}
            </Ctx.Provider>
          )}
        </main>
      </div>
    </div>
  );
}

/** Inline error/success line for a form or action. */
export function Feedback({ error, done }: { error: string | null; done?: string | null }) {
  if (error) return <p className="notice notice--error" role="alert">{error}</p>;
  if (done) return <p className="notice" role="status">{done}</p>;
  return null;
}
