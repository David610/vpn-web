"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

/** Loads a read-only admin fleet endpoint with periodic refresh. */
export function useFleetData<T>(url: string, refreshMs = 15_000) {
  const { session } = useAdminSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setData(await adminFetch<T>(url, session.access_token));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load.");
    }
  }, [session, url]);

  useEffect(() => {
    if (!session) return;
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [session, load, refreshMs]);

  return { data, error, reload: load };
}
