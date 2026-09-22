"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAdminSession } from "@/hooks/useAdminSession";
import { AdminNav } from "./AdminNav";

export function AdminShell({ children }: { children: React.ReactNode }) {
  const { session, isAdmin, loading } = useAdminSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !session) router.replace("/admin/login");
  }, [loading, session, router]);

  if (loading) return <div className="p-8">Loading…</div>;
  if (!session) return null;
  if (isAdmin === false) {
    return <div className="p-8 text-red-600">You do not have admin access.</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <AdminNav />
      <main className="mx-auto max-w-6xl p-6">{children}</main>
    </div>
  );
}
