import { describe, it, expect } from "vitest";
import { supabase, supabaseAdmin } from "../supabase";

// F-15 (admin-origin isolation, code-only half): admin and customer pages
// share one origin, so the only isolation achievable without a separate
// domain is keeping their sessions in different localStorage slots. These
// tests pin that contract at the client-construction level; the browser
// end-to-end version of this (a login on one client never populating the
// other's key) is exercised by scripts/trusted-types-check.mjs against a
// real page, since vitest runs in a Node environment with no localStorage.
describe("supabase client storage isolation (F-15)", () => {
  it("uses a distinct storageKey for the admin client than the customer client", () => {
    const customerKey = (supabase.auth as unknown as { storageKey: string }).storageKey;
    const adminKey = (supabaseAdmin.auth as unknown as { storageKey: string }).storageKey;

    expect(customerKey).toBe("arcana-auth-v1");
    expect(adminKey).toBe("arcana-admin-auth-v1");
    expect(adminKey).not.toBe(customerKey);
  });

  it("keeps every other auth option identical between the two clients", () => {
    // Only the storage key should differ -- the admin client must behave
    // exactly like the customer client otherwise (same PKCE flow, same
    // refresh/persistence semantics), so a diff here is a signal something
    // drifted rather than an intentional isolation change.
    const customerAuth = supabase.auth as unknown as Record<string, unknown>;
    const adminAuth = supabaseAdmin.auth as unknown as Record<string, unknown>;

    for (const key of ["flowType", "detectSessionInUrl", "persistSession", "autoRefreshToken"] as const) {
      expect(adminAuth[key]).toEqual(customerAuth[key]);
    }
  });

  it("are separate client instances, not the same object re-exported twice", () => {
    expect(supabaseAdmin).not.toBe(supabase);
  });
});
