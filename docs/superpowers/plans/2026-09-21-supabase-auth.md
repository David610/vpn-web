# Arcana Supabase auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Next.js static-export site up to the already-merged Supabase schema's auth: email+password signup with required email verification, login, logout, a session-aware nav, and a minimal auth-gated `/dashboard` page — proving the full signup → verify → login → protected-page flow works end to end against a real local Supabase instance.

**Architecture:** This app has **no server runtime** (`output: 'export'`) and **no Next.js middleware** (unsupported under static export). Every piece of this plan is therefore client-side: a single shared browser Supabase client (`@supabase/supabase-js`'s `createClient`, not `@supabase/ssr`'s cookie-juggling server/middleware clients — those exist to solve a server-rendering problem this app doesn't have), session state read via `supabase.auth.getSession()`/`onAuthStateChange` in a small hook, and route protection done client-side (a page checks session after hydration and redirects if absent — the pre-hydration static HTML never contains user data, since it's rendered with no session available at build time). Any privileged, server-side operation (reading `vpn_secrets`, checking `subscriptions` against Stripe) is explicitly **out of scope** here — that's the future Cloudflare Pages Functions work the spec describes, which receives the browser's access token over `Authorization` header and verifies it server-side; this plan only gets a user logged in and holding a valid session.

**Tech Stack:** `@supabase/supabase-js` (browser-only usage), the existing design-system CSS (`.field`/`.field-label`/`.field-error`/`.btn*`/`.dm-card*` from the scaffold plan), Next.js client components (`'use client'`) for every new interactive piece.

**Spec:** `docs/superpowers/specs/2026-09-20-vpn-website-mvp-design.md` in the sibling repo `singbox-vpn` (absolute path: `D:\ISDA\singbox-vpn\docs\superpowers\specs\2026-09-20-vpn-website-mvp-design.md`) — §8 (auth: email+password+required verification, no magic-link-only), §3 (static frontend, no server runtime here).

## Global Constraints

- Email + password only, with required email verification (`supabase.auth.signUp` + Supabase's built-in confirmation email) — no magic-link-only flow, no OAuth providers, matching the spec's explicit choice.
- No Next.js middleware, no `@supabase/ssr` server/middleware clients — this app has no server runtime under `output: 'export'`. Every Supabase call in this plan runs in the browser.
- The pre-hydration static HTML for `/dashboard` must never contain any user-specific data — it's generated at build time with no session available. The dashboard's real content only renders after a client-side session check.
- CAPTCHA/abuse protection on signup and custom SMTP are Supabase-project-level configuration (spec §9 item 3) on a real, non-local project that doesn't exist yet — explicitly out of scope for this plan, same deferral already used for the scaffold and schema plans.
- `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` must never throw at module load if unset (a `next build` with no env configured, e.g. CI without secrets, must still succeed) — the Supabase client falls back to harmless placeholder values that only fail at actual network-call time, not at import time.
- Every new page reuses the existing `.field`/`.field-label`/`.field-error`/`.btn*`/`.dm-card*` classes from `src/app/globals.css` (scaffold plan) — no new ad hoc CSS, no inline styles beyond what those existing pages already establish as acceptable (`var(--space-*)` tokens only, per the scaffold's own carried-forward Important-finding-turned-convention).

---

## Task 1: Supabase browser client, signup, login, and email-confirmation callback

**Files:**
- Modify: `package.json` (add `@supabase/supabase-js`)
- Create: `.env.local.example`
- Create: `src/lib/supabase.ts`
- Create: `src/app/signup/page.tsx`
- Create: `src/app/login/page.tsx`
- Create: `src/app/auth/callback/page.tsx`

**Interfaces:**
- Consumes: `SITE_NAME` from `src/lib/site-config.ts` (scaffold plan). CSS classes `.field`, `.field-label`, `.field-error`, `.btn`, `.btn-primary`, `.dm-card*`, `.section-*`, `.hero*`-adjacent layout classes already in `globals.css`.
- Produces: `export const supabase` from `src/lib/supabase.ts` — a single shared browser `SupabaseClient` instance every later file in this plan (and every later plan: dashboard, Stripe checkout trigger, `/api/vpn/config` caller) imports. This is the one and only place a Supabase client is constructed in this repo.

- [ ] **Step 1: Add the Supabase dependency**

In `package.json`, add to `"dependencies"`:
```json
    "@supabase/supabase-js": "^2.58.0",
```
(Keep the existing `next`/`react`/`react-dom` entries as-is, just add this one line to the dependencies object.)

Run: `npm install`. Expected: succeeds, adds `@supabase/supabase-js` and its transitive deps to `package-lock.json`.

- [ ] **Step 2: Write `.env.local.example`**

```
# Copy this file to .env.local for local development. These are the
# well-known, publicly-documented demo values `npx supabase start` prints —
# meaningless outside your own local Docker instance, safe to commit as an
# example. A real (non-local) Supabase project's own URL/anon key replace
# these when this app is actually deployed.
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
```

(Confirm this anon key still matches what your local `npx supabase start` actually prints for `ANON_KEY` before committing — Supabase CLI versions occasionally change the demo project's signing key. If it differs, use the value your own `supabase start` run prints instead of the one above.)

- [ ] **Step 3: Write `src/lib/supabase.ts`**

```ts
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
export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder-anon-key"
);
```

- [ ] **Step 4: Write `src/app/signup/page.tsx`**

```tsx
"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { supabase } from "@/lib/supabase";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setSubmitting(true);
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo:
          typeof window !== "undefined"
            ? `${window.location.origin}/auth/callback/`
            : undefined,
      },
    });
    setSubmitting(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }
    setSubmitted(true);
  }

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Sign up</p>
          <h1 className="section-h2">Create your account</h1>
        </div>
        <div className="dm-card" style={{ maxWidth: "26rem" }}>
          <div style={{ padding: "var(--space-6)" }}>
            {submitted ? (
              <p className="section-sub">
                Check your email for a confirmation link, then{" "}
                <Link href="/login" className="text-link">
                  log in
                </Link>
                .
              </p>
            ) : (
              <form
                onSubmit={handleSubmit}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-4)",
                }}
              >
                <div>
                  <label className="field-label" htmlFor="email">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    className="field"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="password">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    className="field"
                    aria-invalid={error ? "true" : undefined}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {error && <span className="field-error">{error}</span>}
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                  style={{ width: "100%" }}
                >
                  {submitting ? "Creating account…" : "Create account"}
                </button>
                <p className="text-tiny">
                  Already have an account?{" "}
                  <Link href="/login" className="text-link">
                    Log in
                  </Link>
                </p>
              </form>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
```

- [ ] **Step 5: Write `src/app/login/page.tsx`**

```tsx
"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { supabase } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    router.push("/dashboard/");
  }

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Log in</p>
          <h1 className="section-h2">Welcome back</h1>
        </div>
        <div className="dm-card" style={{ maxWidth: "26rem" }}>
          <div style={{ padding: "var(--space-6)" }}>
            <form
              onSubmit={handleSubmit}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-4)",
              }}
            >
              <div>
                <label className="field-label" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  className="field"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  className="field"
                  aria-invalid={error ? "true" : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {error && <span className="field-error">{error}</span>}
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting}
                style={{ width: "100%" }}
              >
                {submitting ? "Logging in…" : "Log in"}
              </button>
              <p className="text-tiny">
                No account yet?{" "}
                <Link href="/signup" className="text-link">
                  Sign up
                </Link>
              </p>
            </form>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
```

- [ ] **Step 6: Write `src/app/auth/callback/page.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { supabase } from "@/lib/supabase";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function run() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      if (!code) {
        setError(
          "Missing confirmation code — this link may be incomplete or already used."
        );
        return;
      }
      const { error: exchangeError } =
        await supabase.auth.exchangeCodeForSession(code);
      if (exchangeError) {
        setError(exchangeError.message);
        return;
      }
      router.replace("/dashboard/");
    }
    run();
  }, [router]);

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Confirming</p>
          <h1 className="section-h2">
            {error ? "Something went wrong" : "Confirming your email…"}
          </h1>
          {error && <p className="section-sub">{error}</p>}
        </div>
      </main>
      <Footer />
    </>
  );
}
```

- [ ] **Step 7: Verify the build succeeds**

Run: `npm run build`

Expected: PASSES. Confirms `src/lib/supabase.ts`'s placeholder-fallback logic (Step 3) really does prevent a build-time throw — this build environment has no `.env.local` yet (Step 2 only created the `.example` file), so this is the real proof the fallback works, not just a claim.

- [ ] **Step 8: Verify lint is clean**

Run: `npm run lint`

Expected: no errors, no warnings.

- [ ] **Step 9: Copy the example env file and start the local Supabase stack**

Run: `cp .env.local.example .env.local` (or the Windows equivalent — this file must exist for the next steps' live verification, and must NOT be committed, confirm `.env.local` is already covered by the scaffold plan's `.gitignore` entry).

Run: `npx supabase start` (the schema plan's migration + seed apply automatically if the local DB was reset since; if the stack is already running from prior work, this is a no-op that just re-prints the connection info).

- [ ] **Step 10: Verify the real signup → confirm → login flow against the live local instance**

This can't be done with `curl` alone (signup/login are real Supabase Auth API calls the browser SDK makes, and email confirmation needs the actual confirmation link) — write a short, throwaway Node verification script (do not commit it) that exercises the exact same `@supabase/supabase-js` calls this app's pages make, then delete it when done. Suggested approach:

```js
// scratch-verify-auth.mjs (throwaway, not committed)
import { createClient } from "@supabase/supabase-js";

const url = "http://127.0.0.1:54321";
const anonKey = "<the same ANON_KEY your .env.local uses>";
const serviceRoleKey = "<the SERVICE_ROLE_KEY your local `supabase start` printed>";

const email = `verify-${Date.now()}@example.test`;
const password = "verify-test-password";

const anon = createClient(url, anonKey);
const admin = createClient(url, serviceRoleKey);

// 1. Sign up.
const { data: signUpData, error: signUpError } = await anon.auth.signUp({ email, password });
if (signUpError) throw signUpError;
console.log("signUp OK, user id:", signUpData.user?.id);

// 2. Confirm the profiles row was auto-created by the migration's trigger
//    (this proves the trigger fires through the REAL auth flow, not just
//    the schema plan's own migration-level test).
const { data: profile, error: profileError } = await admin
  .from("profiles")
  .select("id")
  .eq("id", signUpData.user.id)
  .single();
if (profileError) throw profileError;
console.log("profiles row exists:", profile);

// 3. Local dev has autoconfirm/Mailpit rather than a real inbox — fetch the
//    confirmation link Mailpit captured and follow it, OR (simpler for
//    local dev, since supabase/config.toml's mailer_autoconfirm is
//    commonly on for local stacks — check yours) attempt signInWithPassword
//    directly and see whether it's already confirmed. Report whichever is
//    actually true for this project's config.toml in your report — don't
//    assume, check the actual `[auth.email]` section.
const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
console.log("signInWithPassword result:", signInError?.message ?? "OK, session obtained");
```

Run it: `node scratch-verify-auth.mjs`. Report the actual output. If `mailer_autoconfirm` is off in `supabase/config.toml` (check it — don't guess), `signInWithPassword` will correctly fail with an "email not confirmed" error until the confirmation link is followed; in that case, fetch the confirmation email from Mailpit's API (`http://127.0.0.1:54324/api/v1/messages` — local dev's captured-email inbox) and extract+follow the real confirmation link's `code` param via `supabase.auth.exchangeCodeForSession(code)` to complete the flow, then retry `signInWithPassword` and confirm it now succeeds. Delete the scratch script when done (`rm scratch-verify-auth.mjs`) — it must not be committed.

- [ ] **Step 11: Stop the local Supabase stack**

Run: `npx supabase stop`.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json .env.local.example src/lib/supabase.ts src/app/signup/page.tsx src/app/login/page.tsx src/app/auth/callback/page.tsx
git commit -m "Add Supabase browser client, signup, login, and email-confirmation callback

Client-side only (no Next.js middleware, no server runtime under
output: 'export') — a single shared browser Supabase client, an
email+password signup form with required verification, login, and
the confirmation-link callback page. Verified against a real local
Supabase instance: signup fires the schema's profiles-creation
trigger through the actual auth flow, not just the migration's own
test."
```

---

## Task 2: Session-aware nav, auth guard, and a minimal dashboard

**Files:**
- Create: `src/hooks/useSession.ts`
- Modify: `src/components/Nav.tsx`
- Create: `src/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `supabase` from `src/lib/supabase.ts` (Task 1).
- Produces: `useSession(): { session: Session | null, loading: boolean }` from `src/hooks/useSession.ts` — the dashboard page (this task) and every later page that needs to know "is someone logged in" (the future Stripe checkout trigger, the real subscription-aware dashboard) import this same hook rather than each rolling their own `getSession()`/`onAuthStateChange` wiring.

- [ ] **Step 1: Write `src/hooks/useSession.ts`**

```ts
"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

/**
 * The one place this app reads Supabase auth state. Every page that needs
 * to know "is someone logged in" uses this hook rather than rolling its own
 * getSession()/onAuthStateChange wiring — see src/lib/supabase.ts's doc
 * comment for why there is no server-side session source in this app.
 */
export function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
      }
    );
    return () => listener.subscription.unsubscribe();
  }, []);

  return { session, loading };
}
```

- [ ] **Step 2: Modify `src/components/Nav.tsx` to be session-aware**

Replace the entire file with:

```tsx
"use client";

import Link from "next/link";
import { SITE_NAME } from "@/lib/site-config";
import { useSession } from "@/hooks/useSession";
import { supabase } from "@/lib/supabase";

export default function Nav() {
  const { session, loading } = useSession();

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = "/";
  }

  return (
    <header className="dm-nav">
      <Link href="/" className="dm-nav__brand">
        {SITE_NAME}
      </Link>
      <nav className="dm-nav__desktop">
        {loading ? null : session ? (
          <>
            <Link href="/dashboard" className="dm-nav__link">
              Dashboard
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="btn btn-secondary dm-nav__cta"
            >
              Log out
            </button>
          </>
        ) : (
          <>
            <Link href="/login" className="dm-nav__link">
              Log in
            </Link>
            <Link href="/signup" className="btn btn-primary dm-nav__cta">
              Get started
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
```

Note: `Nav` becoming a client component (it already needed to be one implicitly once it reads session state) means every page importing it (`page.tsx`, `not-found.tsx`, and this task's new `dashboard/page.tsx`) still works exactly as before for the static-export build — a `'use client'` component still gets prerendered to static HTML, it just also hydrates and updates after load. The `loading ? null : ...` branch is what keeps the very first static-rendered paint from showing a wrong/flashing state (no session is known yet at that point, so it shows neither logged-in nor logged-out chrome until the client-side check resolves).

- [ ] **Step 3: Write `src/app/dashboard/page.tsx`**

```tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { useSession } from "@/hooks/useSession";

export default function DashboardPage() {
  const router = useRouter();
  const { session, loading } = useSession();

  useEffect(() => {
    if (!loading && !session) {
      router.replace("/login/");
    }
  }, [loading, session, router]);

  if (loading || !session) {
    // Also covers the static-export pre-hydration paint: no session is
    // known at build time, so this branch is exactly what a crawler or a
    // logged-out visitor sees in the raw HTML — no user data, ever, in the
    // static shell.
    return (
      <>
        <Nav />
        <main className="dm-section" style={{ borderBottom: "none" }}>
          <div className="section-head">
            <p className="section-eyebrow">Dashboard</p>
            <h1 className="section-h2">
              {loading ? "Loading…" : "Redirecting to login…"}
            </h1>
          </div>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Dashboard</p>
          <h1 className="section-h2">Welcome, {session.user.email}</h1>
        </div>
        <div className="dm-card" style={{ maxWidth: "26rem" }}>
          <div className="dm-card-header">
            <span className="dm-card-title">Subscription</span>
          </div>
          <div style={{ padding: "var(--space-6)" }}>
            <p className="section-sub">
              No active subscription yet. Billing isn&apos;t wired up on
              this site yet — once it is, this page will show your VPN
              configuration here.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
```

- [ ] **Step 4: Verify the build succeeds**

Run: `npm run build`

Expected: PASSES. Confirms the new `/dashboard` route builds statically with no server-side data dependency.

- [ ] **Step 5: Verify lint is clean**

Run: `npm run lint`

- [ ] **Step 6: Inspect the static-exported dashboard HTML for a data leak**

Run: `grep -i "welcome\|@example" out/dashboard/index.html` (or the equivalent `out/dashboard.html` — check which `next build` actually produced given `trailingSlash: true`) after the build.

Expected: NO MATCH. The static-rendered shell must show only the loading/redirect state (`Loading…`), never a real welcome message or email address, since no session exists at build time. If this grep finds a match, that's a real data-leak bug to report, not something to explain away.

- [ ] **Step 7: Manual verification against the live local Supabase instance (adapted per this repo's established pattern — no real browser available)**

Start the stack if not already running (`npx supabase start`), run `npm run dev`, and re-run a version of Task 1 Step 10's verification script (or extend it) to: sign up + confirm a fresh user, obtain a session via `signInWithPassword`, and confirm the session's `access_token` is a real non-empty JWT string. This confirms the data `useSession`/`Nav`/`dashboard/page.tsx` depend on is real and well-formed — the actual client-side rendering/redirect behavior (Nav switching to "Dashboard"/"Log out", the dashboard's `useEffect` redirect firing) needs a real browser to observe directly, which isn't available in this environment; note this limitation explicitly in your report rather than claiming it was visually verified. Stop the dev server and the Supabase stack when done.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useSession.ts src/components/Nav.tsx src/app/dashboard/page.tsx
git commit -m "Add session-aware nav, auth guard, and a minimal dashboard page

useSession() is the one place this app reads Supabase auth state.
Nav switches between logged-out (Log in/Get started) and logged-in
(Dashboard/Log out) chrome; the dashboard redirects unauthenticated
visitors to /login and never renders user data in its static-export
pre-hydration shell (verified: grep finds no email/welcome text in
the built out/dashboard HTML)."
```

---

## Explicitly not in this plan

- Any privileged/server-side operation (reading `vpn_secrets`, checking real subscription status, calling the provisioning agent) — the future Cloudflare Pages Functions work, which receives the browser's access token and verifies it server-side.
- Stripe Checkout, the webhook handler, real subscription state on the dashboard — separate, later plan.
- CAPTCHA and custom SMTP on signup — Supabase-project-level config on a real (non-local) project that doesn't exist yet (spec §9 item 3).
- Password reset / "forgot password" flow — not in the spec's stated v1 scope; add if/when actually requested.
- OAuth providers (Google, Apple, etc.) — explicitly excluded by the spec's §8 decision (email+password only for v1).
