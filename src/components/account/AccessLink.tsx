"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api, ApiError } from "@/lib/api";

export type AccessState = "hidden" | "loading" | "revealed" | "unavailable" | "none" | "error";

const AUTO_HIDE_MS = 60_000;
const COPIED_MS = 2_000;

/**
 * Holds one access link in memory only while the user asked to see it. The URL
 * is a bearer credential: it is fetched on demand, hidden again after a
 * minute, and never written to storage or the page when hidden.
 */
export function useAccessLink(session: Session, linkId: string, clientId: string | null) {
  const [state, setState] = useState<AccessState>(clientId ? "hidden" : "none");
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
      clearTimeout(copiedTimer.current);
    },
    []
  );

  useEffect(() => {
    setState(clientId ? "hidden" : "none");
    setUrl(null);
  }, [clientId]);

  const show = useCallback((value: string) => {
    setUrl(value);
    setState("revealed");
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setUrl(null);
      setState("hidden");
    }, AUTO_HIDE_MS);
  }, []);

  const fetchUrl = useCallback(async (): Promise<string | null> => {
    if (!clientId) return null;
    setMessage(null);
    setState("loading");
    try {
      const data = await api<{ configurationUrl: string }>(
        session,
        `/api/account/links/${encodeURIComponent(linkId)}/clients/${encodeURIComponent(clientId)}/access-link`
      );
      return data.configurationUrl;
    } catch (err) {
      if (err instanceof ApiError && err.code === "access_link_unavailable") {
        setState("unavailable");
        setMessage(err.message);
      } else {
        setState("error");
        setMessage(err instanceof Error ? err.message : "Could not load this link.");
      }
      return null;
    }
  }, [session, linkId, clientId]);

  const reveal = useCallback(async () => {
    const value = url ?? (await fetchUrl());
    if (value) show(value);
  }, [url, fetchUrl, show]);

  const hide = useCallback(() => {
    clearTimeout(hideTimer.current);
    setUrl(null);
    setState(clientId ? "hidden" : "none");
  }, [clientId]);

  const copy = useCallback(async () => {
    const value = url ?? (await fetchUrl());
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
      // Copying does not need the secret on screen; keep it hidden if it was.
      if (state !== "revealed") {
        setUrl(null);
        setState("hidden");
      }
    } catch {
      show(value);
      setMessage("Copying was blocked by your browser. Select the link and copy it.");
    }
  }, [url, fetchUrl, show, state]);

  /** Show a link that was just issued (creation or replacement) without another request. */
  const adopt = useCallback((value: string) => show(value), [show]);

  return { state, url, copied, message, reveal, hide, copy, adopt };
}

/** The masked placeholder shown while a link is hidden. */
export function maskedLink() {
  const host = typeof window === "undefined" ? "arcana" : window.location.host;
  return `https://${host}/sub/${"•".repeat(16)}`;
}
