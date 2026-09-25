"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * /dashboard is superseded by /account/* (ADR-0001 companion IA work).
 * Kept as a compatibility redirect — including the query string, since
 * Stripe checkout/cancel return URLs may still carry ?checkout=... here for
 * a transition period — rather than deleted outright, so old bookmarks and
 * any not-yet-updated external links keep working.
 */
export default function DashboardRedirect() {
  const router = useRouter();

  useEffect(() => {
    const search = window.location.search;
    router.replace(`/account/${search}`);
  }, [router]);

  return null;
}
