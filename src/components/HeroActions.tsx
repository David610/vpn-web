"use client";

import Link from "next/link";
import { useSession } from "@/hooks/useSession";

/**
 * The hero's secondary action depends on auth state — an authenticated
 * visitor should never see "Create account" next to "Account · Log out" in
 * the header above it. Split out from the (server) homepage so only this
 * sliver needs a client session check.
 */
export default function HeroActions() {
  const { session, loading } = useSession();
  const signedIn = !loading && !!session;

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
