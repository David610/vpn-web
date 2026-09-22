"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/hooks/useSession";

/**
 * Extends useSession with an admin-role check. There is no dedicated
 * "am I admin" endpoint — GET /api/admin/overview doubles as the check,
 * since every admin page needs its data anyway and a 401 there means
 * "not an admin" just as reliably as a separate endpoint would.
 */
export function useAdminSession() {
  const { session, loading: sessionLoading } = useSession();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (sessionLoading) return;
    if (!session) {
      setIsAdmin(false);
      return;
    }
    fetch("/api/admin/overview", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((res) => setIsAdmin(res.status === 200))
      .catch(() => setIsAdmin(false));
  }, [session, sessionLoading]);

  return { session, isAdmin, loading: sessionLoading || isAdmin === null };
}
