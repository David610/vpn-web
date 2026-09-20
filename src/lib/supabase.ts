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
export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder-anon-key",
  {
    auth: {
      flowType: "pkce",
    },
  }
);
