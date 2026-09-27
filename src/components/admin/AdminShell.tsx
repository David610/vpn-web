"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAdminSession } from "@/hooks/useAdminSession";
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

  if (loading) return <div className="p-8 text-fg-2">Loading…</div>;
  if (!session || access === "mfa-required") return null;
  if (access === "denied") {
    return <div className="p-8 text-danger">You do not have admin access.</div>;
  }

  return (
    <div className="min-h-screen bg-bg-alt">
      <AdminNav />
      <main className="mx-auto max-w-6xl p-6">{children}</main>
    </div>
  );
}
