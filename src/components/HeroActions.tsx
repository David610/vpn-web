"use client";

import Link from "next/link";
import { useLocalSessionFlag } from "@/hooks/useLocalSessionFlag";

/**
 * The hero's secondary action depends on auth state — an authenticated
 * visitor should never see "Create account" next to "Account · Log out" in
 * the header above it. Split out from the (server) homepage so only this
 * sliver needs a client session check.
 *
 * Reads localStorage directly rather than useSession()/the Supabase client
 * (F-44/K-04): this renders on the homepage for every visitor, so pulling in
 * the ~65 kB gzip Supabase chunk just to pick a link label is wasteful.
 */
export default function HeroActions() {
  const { hasSession, loading } = useLocalSessionFlag();
  const signedIn = !loading && hasSession;

  return (
    <div className="hero__actions">
      <Link href="/locations" className="btn btn-secondary">
        View locations
      </Link>
      {!loading && (
        <Link href={signedIn ? "/account/" : "/signup"} className="text-link hero__signup">
          {signedIn ? "Account" : "Create account"}
        </Link>
      )}
    </div>
  );
}
