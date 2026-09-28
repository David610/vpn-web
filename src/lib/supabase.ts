import { createClient } from "@supabase/supabase-js";

// This app has no server runtime (output: 'export') and no Next.js
// middleware (unsupported under static export), so there is exactly one
// Supabase client in this codebase: a browser client whose session lives in
// localStorage. Never add a second client, and never reach for
// @supabase/ssr's server/middleware clients here — those solve a
// server-rendering cookie problem this app structurally does not have.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// Falls back to harmless placeholder values so `next build`'s static-render
// pass (which executes this module even for 'use client' pages) never
// throws when env vars aren't set, e.g. in CI without secrets configured.
// A real network call against these placeholders fails clearly at runtime
// instead — a broken build is worse than a clear runtime auth error.
// PKCE flow: confirmation links carry a real `?code=` query param that
// auth/callback/page.tsx exchanges via exchangeCodeForSession(code). The
// SDK's default 'implicit' flow instead redirects with tokens in the URL
// hash fragment, which that page never reads.
//
// detectSessionInUrl: false is required alongside flowType: 'pkce'. The
// SDK's own _initialize() runs automatically at client construction time,
// before React ever hydrates the callback page, and by default
// (detectSessionInUrl: true) it races auth/callback/page.tsx's explicit
// exchangeCodeForSession(code) call for the same one-time-use PKCE code
// verifier stored in localStorage. Whichever of the two consumes the
// verifier first wins; the loser gets a "both auth code and code verifier
// should be non-empty" (or similar) error even on a legitimate,
// first-use confirmation link. Disabling detectSessionInUrl removes the
// SDK's automatic consumer entirely, so the callback page's manual
// exchange is the only code path that ever touches the verifier.
export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder-anon-key",
  {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      // Make the intended UX explicit instead of relying on SDK defaults:
      // sessions survive browser restarts and refresh automatically while
      // the app is in the foreground. Sensitive operations still enforce
      // the separate 15-minute recent-auth window on the server.
      persistSession: true,
      autoRefreshToken: true,
      storageKey: "arcana-auth-v1",
    },
  }
);

// F-15 (admin-origin isolation, code-only half): admin and customer pages
// currently share one origin, so they cannot get the full separate-domain
// isolation a real "admin origin" implies -- that needs its own
// DNS/Cloudflare Pages project and is a production/infra decision, not
// something this module can do. What *is* achievable here: a distinct
// localStorage key for the admin session, so an XSS payload that specifically
// targets the known customer key (`arcana-auth-v1`) does not also hand over
// an aal2 admin session sitting under the same key. This is a second
// browser-client instance against the same Supabase project, differing only
// in storageKey -- same PKCE/detectSessionInUrl/persist/refresh config as
// `supabase` above, so admin/login and admin/mfa/enroll behave identically
// to the customer flow, just against their own storage slot. Only
// src/app/admin/login/page.tsx and src/app/admin/mfa/enroll/page.tsx (via
// useAdminSession -> useSession) should ever import this; every other admin
// page reads the session through useAdminSession, not this client directly.
export const supabaseAdmin = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder-anon-key",
  {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
      storageKey: "arcana-admin-auth-v1",
    },
  }
);
