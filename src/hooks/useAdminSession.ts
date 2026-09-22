"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/hooks/useSession";

/**
 * Admin access has three distinct outcomes, not two, and the dashboard
 * needs to tell them apart:
 *
 *   "ok"           – admin with a stepped-up (aal2) session
 *   "mfa-required" – really an admin, but the session is password-only
 *   "denied"       – authenticated, but not in admin_users at all
 *
 * There is no dedicated "am I admin" endpoint — GET /api/admin/overview
 * doubles as the check, since every admin page needs its data anyway.
 * requireAdmin() answers 403 + code "mfa_required" for the middle case and
 * a flat 401 for the last, so a customer who wanders into /admin is never
 * invited to enroll a second factor for an account that has no admin role.
 */
export type AdminAccess = "ok" | "mfa-required" | "denied";

export function useAdminSession() {
  const { session, loading: sessionLoading } = useSession();
  const [access, setAccess] = useState<AdminAccess | null>(null);

  useEffect(() => {
    if (sessionLoading) return;
    if (!session) {
      setAccess("denied");
      return;
    }
    let cancelled = false;
    fetch("/api/admin/overview", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) return setAccess("ok");
        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          return setAccess(body.code === "mfa_required" ? "mfa-required" : "denied");
        }
        setAccess("denied");
      })
      .catch(() => {
        if (!cancelled) setAccess("denied");
      });
    return () => {
      cancelled = true;
    };
  }, [session, sessionLoading]);

  return {
    session,
    access,
    isAdmin: access === "ok",
    loading: sessionLoading || access === null,
  };
}
