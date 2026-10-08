"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import UserMenu from "@/components/UserMenu";
import { useAdminSession } from "@/hooks/useAdminSession";
import { supabaseAdmin } from "@/lib/supabase";
import { ENV_LABEL, SITE_NAME } from "@/lib/site-config";
import { AdminNav } from "./AdminNav";

async function signOutAdmin() {
  await supabaseAdmin.auth.signOut().catch((err: { message: string }) => {
    console.error("Admin sign out failed:", err.message);
  });
  window.location.href = "/admin/login";
}

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
    <div className="ps ps--admin">
      <header className="ps-top">
        <Link href="/admin" className="ps-top__brand">
          {SITE_NAME} <span className="ps-tag">Admin</span>
        </Link>
        <div className="ps-top__right">
          {ENV_LABEL ? <span className="ps-env">{ENV_LABEL}</span> : null}
          <UserMenu email={session.user.email ?? "Admin"} label="Admin" onSignOut={signOutAdmin} />
        </div>
      </header>
      <div className="ps-body">
        <AdminNav />
        <main className="ps-main ps-main--wide" id="admin-main">
          {children}
        </main>
      </div>
    </div>
  );
}
