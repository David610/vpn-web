"use client";

import Link from "next/link";
import { useLocalSessionFlag } from "@/hooks/useLocalSessionFlag";

/**
 * The hero's primary action depends on auth state: a signed-in visitor goes to
 * their account instead of being asked to sign up again. Split out from the
 * (server) homepage so only this sliver needs a client session check.
 *
 * Reads localStorage directly rather than useSession()/the Supabase client
 * (F-44/K-04): this renders on the homepage for every visitor, so pulling in
 * the ~65 kB gzip Supabase chunk just to pick a link is wasteful.
 */
export default function HeroActions() {
  const { hasSession, loading } = useLocalSessionFlag();
  const signedIn = !loading && hasSession;

  return (
    <div className="hero-actions">
      <Link href={signedIn ? "/account/" : "/signup"} className="btn btn-primary btn-lg">
        {signedIn ? "Open your account" : "Get Arcana"}
      </Link>
      <Link href="/apps" className="hero-actions__more">
        Learn more <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}
