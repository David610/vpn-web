"use client";

import { useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

/**
 * The one place this app reads Supabase auth state. Every page that needs
 * to know "is someone logged in" uses this hook rather than rolling its own
 * getSession()/onAuthStateChange wiring — see src/lib/supabase.ts's doc
 * comment for why there is no server-side session source in this app.
 *
 * Accepts an optional client so admin pages can pass `supabaseAdmin` (its
 * own storage key, see src/lib/supabase.ts) instead of the default customer
 * client, keeping the two sessions in separate localStorage slots.
 */
export function useSession(
  client: SupabaseClient = supabase
): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    client.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: listener } = client.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
      }
    );
    return () => listener.subscription.unsubscribe();
  }, [client]);

  return { session, loading };
}
