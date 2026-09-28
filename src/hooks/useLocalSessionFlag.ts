"use client";

import { useEffect, useState } from "react";

// Must match src/lib/supabase.ts's storageKey. Duplicated as a literal
// (rather than imported) so public pages that only need a yes/no "is
// someone logged in" answer for a nav link never pull in the Supabase SDK
// module graph — see F-44/K-04.
const STORAGE_KEY = "arcana-auth-v1";

function readHasSession(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const expiresAt = parsed?.expires_at ?? parsed?.currentSession?.expires_at ?? null;
    const accessToken = parsed?.access_token ?? parsed?.currentSession?.access_token ?? null;
    if (!accessToken) return false;
    if (typeof expiresAt === "number") {
      return expiresAt * 1000 > Date.now();
    }
    // No expiry field we recognise: fall back to "a token is present". This
    // is a UI hint only (which nav link to show) — every real request still
    // goes through the server's own token verification.
    return true;
  } catch {
    return false;
  }
}

/**
 * A same-tab, no-network read of whether a Supabase session looks present,
 * for pages that only need that to decide which nav link to render (e.g.
 * "Log in" vs "Account"). Deliberately does not import "@/lib/supabase" —
 * that pulls in the ~65 kB gzip Supabase client chunk, which public pages
 * (/, /pricing, /locations, legal pages) have no other reason to load.
 *
 * Pages that actually perform auth (login, signup, account, admin) should
 * keep using useSession(), which reads the real, validated session.
 */
export function useLocalSessionFlag(): { hasSession: boolean; loading: boolean } {
  const [state, setState] = useState({ hasSession: false, loading: true });

  useEffect(() => {
    setState({ hasSession: readHasSession(), loading: false });

    // Cross-tab only (the storage event never fires in the tab that made
    // the change) — good enough for a nav link, which re-reads on next
    // navigation anyway.
    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY || event.key === null) {
        setState({ hasSession: readHasSession(), loading: false });
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return state;
}
