// Shared fetch helper for the /admin dashboard pages. The admin API routes
// (functions/api/admin/**) return `{ error: string }` with a non-2xx status
// on failure (401/403/404/500) — this wraps `fetch` so every admin page
// throws a readable Error on those instead of quietly resolving with a
// response body the page then destructures blindly.
export async function adminFetch<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}
