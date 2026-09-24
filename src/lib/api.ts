import type { Session } from "@supabase/supabase-js";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
  }
}

/**
 * Calls a customer API with the session token. A sensitive action that
 * needs a fresh sign-in sends the user to log in again and come back.
 */
export async function api<T = unknown>(
  session: Session,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data?.code === "reauth_required") {
    const back = window.location.pathname;
    window.location.href = `/login/?next=${encodeURIComponent(back)}&reauth=1`;
    throw new ApiError("Please sign in again to continue.", 403, "reauth_required");
  }
  if (!res.ok) throw new ApiError(data?.error ?? "Something went wrong.", res.status, data?.code);
  return data as T;
}

export function euro(cents: number) {
  return `€${(cents / 100).toFixed(2)}`;
}

export function shortDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function relative(iso: string | null | undefined) {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
