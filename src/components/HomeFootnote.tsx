"use client";

import Link from "next/link";
import { useSession } from "@/hooks/useSession";

/** "Already have an account? Log in" — only for a signed-out visitor. */
export default function HomeFootnote() {
  const { session, loading } = useSession();
  if (loading || session) return null;
  return (
    <p className="muted" style={{ padding: "var(--space-6) var(--edge) var(--space-12)" }}>
      Already have an account? <Link href="/login" className="text-link">Log in</Link>
    </p>
  );
}
