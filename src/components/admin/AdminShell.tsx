"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAdminSession } from "@/hooks/useAdminSession";
import { SITE_NAME } from "@/lib/site-config";
import { AdminNav } from "./AdminNav";

export function AdminShell({ children }: { children: React.ReactNode }) {
  const { session, access, loading } = useAdminSession();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace("/admin/login");
      return;
    }
    // A real admin on a password-only session: send them to step up rather
    // than showing an error. /admin/login works out whether that means
    // entering a TOTP code or enrolling a first factor.
    if (access === "mfa-required") router.replace("/admin/login");
  }, [loading, session, access, router]);

  if (loading) return <div className="admin-status">Loading…</div>;
  if (!session || access === "mfa-required") return null;
  if (access === "denied") {
    return <div className="admin-status text-danger">You do not have admin access.</div>;
  }

  return (
    <div className="area area--wide">
      <aside className="area__side">
        <Link href="/admin" className="admin-wordmark">
          {SITE_NAME}
        </Link>
        <p className="area__label">Admin</p>
        <AdminNav />
      </aside>
      <main className="area__main">{children}</main>
    </div>
  );
}
