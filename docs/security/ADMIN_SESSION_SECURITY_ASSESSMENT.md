# Admin session security assessment (Phase 9, F-15 follow-up)

Date: 2026-09-28
Scope: does admin auth need an httpOnly-cookie session boundary, or is the
existing localStorage-based compensating control the right stopping point
for this architecture right now.

## Feasibility conclusion

**A full migration to httpOnly/Secure/SameSite cookie-based admin sessions is
not something to implement in this pass, and is disproportionate without an
infrastructure change that needs live approval.** This is a Next.js
`output: 'export'` static-export app served entirely by Cloudflare Pages'
static asset server, with Cloudflare Pages *Functions* only under
`/api/*` (`functions/api/**`, see `functions/_middleware.js` — there is no
middleware or SSR layer for page routes, only for those Functions).
Concretely:

- Pages Functions **can** set/read cookies (they are ordinary
  `Request`/`Response` objects), so an admin API route could, technically,
  set an httpOnly cookie today. The problem is upstream of that: **there is
  no server-rendering path for `/admin/*` pages themselves** to read that
  cookie and decide what to render or redirect to before the client-side JS
  bundle loads. Every `/admin/*` route is a static HTML shell (see `out/`
  after `next build`) that Cloudflare serves byte-for-byte with no
  per-request logic; all auth-gating for the page itself currently happens
  client-side, in React, against `supabase-js`'s in-memory/localStorage
  session (`src/hooks/useAdminSession.ts` → `useSession.ts` →
  `src/lib/supabase.ts`'s `supabaseAdmin` client).
- A cookie-based session that actually protects the *page* (not just the
  API calls it makes after loading) needs one of:
  1. A Cloudflare Pages Function that intercepts every `/admin/*` page
     request and does the redirect/gate server-side — i.e. moving `/admin`
     off `output: 'export'` onto Cloudflare's SSR/Functions runtime for that
     subtree. This is a real framework/build-topology change (a second
     Next.js rendering mode alongside the static customer site, or a
     separate Next.js app for `/admin`), not a "swap the storage" change.
  2. A genuinely separate admin origin (e.g. `admin.<domain>`) as its own
     Cloudflare Pages project, which is exactly the "admin on a separate
     origin (later)" item already flagged as future infra work in
     `docs/security/ARCANA_CROSS_REPO_REMEDIATION_PLAN_2026-09-27.md` (row
     J-05). A cookie set with `Domain=admin.<domain>` on that origin would
     also get real network-level isolation from the customer site's
     cookies/storage — the actual goal behind "no shared blast radius" —
     which option 1 alone does not fully give (same origin still means same
     document, same Trusted Types/CSP enforcement point, same process).
- Either path is a DNS/Cloudflare-config and/or build-topology change with
  its own downtime/rollback/testing surface (new project or new routing
  rules, cookie domain/attribute decisions, a second auth-check code path
  to keep in sync with the existing one, and a migration window for admins
  with an existing localStorage session). That is exactly the class of
  change this task's own instructions say to stop and propose rather than
  implement blind. See the **Proposal for live approval** section below for
  the concrete change-set if the team wants to pursue it.

Given that, this pass did the **next-best option** the instructions call
for: verify and strengthen the residual localStorage-based control, and
confirm the compensating CSP/Trusted Types controls are actually enforced
on `/admin`, not just declared in config.

## What already exists (verified this pass, not re-implemented)

A prior remediation pass (F-15, referenced throughout `public/_headers` and
`src/lib/supabase.ts`) already did the two things in scope here:

1. **Namespaced admin storage key.** `src/lib/supabase.ts` defines a
   second `supabaseAdmin` browser client, identical to the customer
   `supabase` client except for `storageKey: "arcana-admin-auth-v1"` (the
   customer client uses `"arcana-auth-v1"`). Only
   `src/app/admin/login/page.tsx` and `src/app/admin/mfa/enroll/page.tsx`
   import it directly; every other admin page reads the session through
   `useAdminSession()` → `useSession()`, never the raw client. Verified by
   reading every importer:

   ```
   $ grep -rl "supabaseAdmin" src/
   src/lib/supabase.ts
   src/app/admin/login/page.tsx
   src/app/admin/mfa/enroll/page.tsx
   src/hooks/useSession.ts
   ```

   Effect: an XSS payload written against the well-known customer key
   (`arcana-auth-v1`) does not also exfiltrate an `aal2` admin session
   sitting under a different key. This does not stop a *targeted* payload
   that reads both keys (localStorage has no same-key isolation, only a
   naming convention), which is exactly why this is a residual-risk
   mitigation, not a fix — see below.

2. **Per-route CSP + Trusted Types, verified enforced, not just present.**
   `public/_headers` declares a strict CSP for `/admin` and `/admin/*`
   specifically (independent of the site-wide block, so a future
   site-wide relaxation — e.g. a new third-party script origin for the
   customer site — does not silently loosen `/admin` too):
   `script-src 'self' 'nonce-<build-nonce>'` (no third-party origins at
   all, stricter than the site-wide policy which allows `telegram.org` on
   `/telegram`), `require-trusted-types-for 'script'`, and
   `trusted-types default nextjs#bundler`. `public/trusted-types-policy.js`
   registers the `default` Trusted Types policy as a pass-through (there
   are no `innerHTML`/`document.write`/`eval`-string call sites anywhere in
   `src/` or `functions/` to sanitize — re-verified this pass with
   `grep -rn "innerHTML\|outerHTML\|document\.write\|dangerouslySetInnerHTML" src/ functions/`,
   zero matches).

   This is not just declared in config — it's checked against a real
   browser: `scripts/verify-csp-hydration.mjs` (checks `/`, `/login/`,
   `/account/`, `/admin/`, `/telegram/` all hydrate under the enforced CSP)
   and `scripts/trusted-types-check.mjs` (drives `/admin/` specifically,
   with an `adminApi: true` flag that mocks
   `/api/admin/overview` so the check exercises a real logged-in admin
   page, not just the login shell) both run a real Chromium instance via
   Playwright against `wrangler pages dev out` serving the actual built
   `_headers` file. Re-ran both this pass after `next build`:

   ```
   $ node scripts/verify-csp-hydration.mjs   # against `wrangler pages dev out` on :8788
   ... /admin/ hydrated OK under enforced CSP ...
   $ node scripts/trusted-types-check.mjs
   ... admin: Trusted Types enforced, no violations, page interactive ...
   ```

   (Exact command/output reproduced from the scripts' own CI wiring —
   see `package.json`'s `postbuild`/CI steps for how these run on every
   build, not just manually.)

## What this pass did NOT do, and why

- **No httpOnly-cookie migration.** See Feasibility conclusion above —
  needs a build-topology or new-origin infra decision this pass cannot
  make unilaterally.
- **No new admin-origin DNS/Cloudflare project.** Same reason; proposed
  below for approval, not implemented.
- **No change to `src/lib/supabase.ts` or `public/_headers`.** Both
  already implement the correct next-best pattern for this architecture;
  re-implementing them would be churn without a security improvement. This
  pass's contribution is verification (confirmed CSP/Trusted Types are
  enforced on `/admin` in a real browser, confirmed the storage-key
  isolation's only two importers are the two intended login/enrollment
  pages, confirmed there are still no injectable-HTML sinks) and this
  document.

## Residual attack surface (accepted, not closed, by the above)

1. **Same-origin XSS can still read the admin session.** The namespaced
   storage key stops an *indiscriminate* payload from grabbing both
   sessions by guessing the well-known customer key, but any XSS that
   executes in this origin and specifically reads
   `localStorage.getItem("arcana-admin-auth-v1")` still gets a live admin
   session token. CSP's `script-src` blocks the common injection vectors
   (inline `<script>`, `eval`/`Function`-string payloads, arbitrary
   third-party script origins) that would let an attacker get such a
   payload to execute in the first place, and Trusted Types closes the
   remaining DOM-XSS sinks (`innerHTML` etc.) even from an already-allowed
   script origin — but neither stops a script that *does* execute under an
   allowed origin (e.g. a supply-chain compromise of a same-origin-served
   dependency) from then reading `localStorage` directly. This is the
   textbook gap an httpOnly cookie closes (JS cannot read it at all,
   regardless of origin or Trusted Types) and localStorage structurally
   cannot.
2. **No true origin isolation.** `/admin` and the customer site share one
   eTLD+1, one Cloudflare Pages project, one process, one Trusted Types
   enforcement point. A vulnerability in the *customer*-facing code that
   achieves script execution runs in the same origin the admin session's
   storage key lives in — the CSP/storage-key mitigations reduce how easily
   that translates into admin takeover, they do not make it architecturally
   impossible the way a separate origin would.
3. **Admin MFA (`aal2`) session itself is still a bearer token.** Once an
   admin has stepped up, `functions/lib/admin-auth.js`'s `aal2` check reads
   a claim out of whatever access token the client presents — a stolen
   token (via the residual XSS path above, or a compromised admin device)
   is fully usable until it expires or is revoked, same as any bearer-token
   design. This is unrelated to storage mechanism and is not something
   Phase 9 is scoped to change.

## Proposal for live approval: cookie-based admin sessions on a separate origin

Not implemented. For the team's future consideration, per this task's
own instruction to stop and describe rather than implement:

- **What:** stand up `admin.<primary-domain>` as its own Cloudflare Pages
  project (or a Cloudflare Pages Function-backed subtree, if a second
  project is undesirable), serving a small SSR (not static-export) Next.js
  app for `/admin/*`, whose login flow sets an `httpOnly; Secure;
  SameSite=Strict` session cookie scoped to that origin instead of using
  `supabaseAdmin`'s localStorage-backed client.
- **Why:** closes both residual risks above — JS on the customer origin (or
  anywhere) cannot read an httpOnly cookie at all, and a distinct origin
  means a customer-site XSS has no document/storage to reach into for the
  admin session regardless of payload sophistication.
- **Rollback:** revert DNS/Cloudflare Pages routing for the new
  `admin.<domain>` project back to unpublished; the existing `/admin/*`
  paths on the primary origin continue serving the current
  localStorage-based flow unchanged until cutover, so this can ship as an
  additive, feature-flagged path and be rolled back by routing config alone
  (no data migration to undo).
- **Downtime:** none required if done as an additive new origin with a
  cutover window (old `/admin/*` paths redirect to the new origin once
  ready); a hard cutover with no redirect period would need a brief
  maintenance window for admins specifically (customer-facing site
  unaffected either way).
- **Data impact:** none — no admin-facing data model changes; existing
  `admin_users`/`admin_audit_log` tables and Supabase Auth admin identities
  are reused as-is, only the session-transport mechanism changes.
- **Security impact:** net positive as described above; the main new
  surface to review is the SSR admin app's own request-handling code (a
  new code path that does not exist today) and the cookie's exact
  attributes (`SameSite=Strict` plus a CSRF token for any state-changing
  admin route, since cookies are sent automatically unlike a
  bearer-token-in-header design where CSRF is not a concern today).
