# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the site owner a narrow, auditable admin surface — customer lookup, node health, provisioning-job visibility, and three safe mutations (disable/enable/rotate) — built entirely on the existing job-queue architecture, with zero new inbound surface on the VPS side.

**Architecture:** Every admin mutation inserts a `provisioning_jobs` row — the same row the Stripe webhook already creates — and the existing provisioning agent (sibling `singbox-vpn` repo) claims and executes it exactly as today. The admin dashboard never calls `vpn-admin`, never opens an SSH session, and never receives `SUPABASE_SERVICE_ROLE_KEY` in the browser. Authorization is a new `admin_users` allow-list table checked server-side on every `/api/admin/*` request, mirroring the existing Bearer-token pattern in `functions/api/cancel-subscription.js`. Every mutation writes one `admin_audit_log` row.

**Tech Stack:** Cloudflare Pages Functions (existing `functions/api/**`), `@supabase/supabase-js` service-role client, Next.js App Router (existing `src/app/**`), Vitest (existing `vitest.config.mjs`, `"test": "vitest run"` in `package.json`).

**Spec:** No standalone spec document exists for this feature. This plan is informed by, and must stay consistent with, the existing architecture recorded in `docs/superpowers/plans/2026-09-21-provisioning-worker-api.md` (job queue, node auth) and `docs/superpowers/plans/2026-09-21-supabase-schema.md` (table shapes, RLS conventions). Read both before Task 1 if anything below is ambiguous.

## Global Constraints

- `SUPABASE_SERVICE_ROLE_KEY` is never sent to the browser and never appears in any `src/app/**` file — only in `functions/**` (Cloudflare Pages Functions run server-side).
- Every `/api/admin/*` route's first action is `requireAdmin(request, supabaseAdmin)` (Task 2) — no route trusts a client-supplied role or email.
- Every admin mutation route inserts a `provisioning_jobs` row and nothing else touches VPN state. No route calls SSH, `vpn-admin`, or any singbox-vpn HTTP endpoint directly.
- Every admin mutation route calls `writeAdminAudit(...)` (Task 3) after the mutation succeeds.
- `provisioning_jobs.result` and any VPN subscription URL/token must never reach an admin API response unredacted — always pass through `sanitizeJobResult()` (Task 3) first.
- Reuse the five existing `job_type` values only (`CREATE_USER`, `SET_EXPIRY`, `ENABLE_USER`, `DISABLE_USER`, `ROTATE_SUBSCRIPTION_TOKEN`) — this plan adds no new job type.
- Follow the existing Bearer-token auth pattern exactly as written in `functions/api/cancel-subscription.js` (`Authorization: Bearer <token>` → `supabaseAdmin.auth.getUser(token)`).
- Every new server-side file gets a Vitest test in the same relative `__tests__` directory as its siblings (`functions/api/__tests__/`, `functions/lib/__tests__/`), using the existing `vi.mock("@supabase/supabase-js", ...)` style already established in `functions/api/__tests__/cancel-subscription.test.js`.
- Out of scope for this plan (do not build): live traffic/DNS logs, a server shell or command box, a config/REALITY-key editor, a raw database editor, packet capture, a firewall editor, MFA enrollment, multi-node assignment logic, and a subscription-URL "reveal" flow. These are excluded on privacy/security grounds, not deferred-for-later convenience — do not add a partial version of any of them.

---

## File Structure

New backend files:
- `supabase/migrations/20260922000000_admin_dashboard.sql` — `admin_users`, `admin_audit_log`, `nodes.last_seen_at`, `vpn_accounts.enabled`.
- `functions/lib/admin-auth.js` — `authenticateAdmin`, `requireAdmin`.
- `functions/lib/admin-audit.js` — `writeAdminAudit`.
- `functions/lib/admin-sanitize.js` — `sanitizeJobResult`.
- `functions/lib/resolve-node.js` — `resolveNodeForUser`.
- `functions/api/admin/overview.js` — `GET /api/admin/overview`.
- `functions/api/admin/customers.js` — `GET /api/admin/customers`.
- `functions/api/admin/customers/[id]/index.js` — `GET /api/admin/customers/:id`.
- `functions/api/admin/customers/[id]/disable.js` — `POST`.
- `functions/api/admin/customers/[id]/enable.js` — `POST`.
- `functions/api/admin/customers/[id]/rotate.js` — `POST`.
- `functions/api/admin/jobs.js` — `GET /api/admin/jobs`.
- `functions/api/admin/jobs/[id]/retry.js` — `POST`.
- `functions/api/admin/nodes.js` — `GET /api/admin/nodes`.
- `functions/api/admin/audit.js` — `GET /api/admin/audit`.
- `scripts/grant-admin.mjs` — one-time CLI to bootstrap the first `owner` row (mirrors `scripts/register-node.mjs`).

Modified backend files:
- `functions/lib/stripe-events.js` — replace six `"node-1"` literals with `resolveNodeForUser()`.
- `functions/api/agent/claim.js` — update `nodes.last_seen_at` on successful auth.
- `functions/api/agent/jobs/[id]/complete.js` — set `vpn_accounts.enabled` on `ENABLE_USER`/`DISABLE_USER` completion.

New frontend files:
- `src/hooks/useAdminSession.ts` — like `useSession`, but also resolves admin role via `GET /api/admin/overview`'s 401/200 (no separate "am I admin" endpoint — the overview call doubles as the check, since every admin page needs it anyway).
- `src/components/admin/AdminShell.tsx`, `AdminNav.tsx`, `StatusBadge.tsx`, `MetricCard.tsx`, `ConfirmButton.tsx`.
- `src/app/admin/page.tsx` — overview.
- `src/app/admin/customers/page.tsx` — list.
- `src/app/admin/customers/[id]/page.tsx` — detail + mutations.
- `src/app/admin/jobs/page.tsx` — list + retry.
- `src/app/admin/nodes/page.tsx` — list.
- `src/app/admin/audit/page.tsx` — list.

---

### Task 1: Database migration

**Files:**
- Create: `supabase/migrations/20260922000000_admin_dashboard.sql`

**Interfaces:**
- Produces: `public.admin_users(user_id, role, created_at, created_by)`, `public.admin_audit_log(id, admin_user_id, action, target_type, target_id, metadata, created_at)`, `public.nodes.last_seen_at`, `public.vpn_accounts.enabled`. Every later task's queries depend on these exact column names.

- [x] **Step 1: Write the migration**

```sql
-- admin_users — allow-list of Supabase auth users who may call
-- /api/admin/*. service_role only, same revoke-by-default pattern as
-- nodes/vpn_secrets/stripe_events (supabase/migrations/20260921000000_initial_schema.sql).
-- There is no signup path for this table on purpose: the first "owner"
-- row is inserted once via scripts/grant-admin.mjs, run manually with
-- the service-role key, never through a client-facing endpoint.
create table public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'operator', 'readonly')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);

alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

-- admin_audit_log — append-only record of every admin mutation. Never
-- put secrets (subscription URLs, node API keys, private keys) into
-- metadata — see functions/lib/admin-audit.js's doc comment.
create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_user_id uuid not null references auth.users (id),
  action text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index admin_audit_log_created_at_idx on public.admin_audit_log (created_at desc);
create index admin_audit_log_target_idx on public.admin_audit_log (target_type, target_id);

alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from anon, authenticated;

-- nodes.last_seen_at — updated by functions/api/agent/claim.js on every
-- successful node authentication (Task 5). No separate heartbeat
-- endpoint yet: the agent already calls /api/agent/claim roughly every
-- 15s, so this piggybacks on an existing call instead of adding one.
alter table public.nodes add column last_seen_at timestamptz;

-- vpn_accounts.enabled — today's completion handler
-- (functions/api/agent/jobs/[id]/complete.js) does not persist
-- ENABLE_USER/DISABLE_USER outcomes anywhere; the admin dashboard's
-- customer view needs a real answer to "is this account currently
-- enabled", so Task 5 adds that write. Defaults true because every
-- vpn_accounts row is created by a successful CREATE_USER completion,
-- which leaves the account enabled.
alter table public.vpn_accounts add column enabled boolean not null default true;

revoke all on all sequences in schema public from anon, authenticated;
```

- [x] **Step 2: Apply locally and verify**

Run: `npx supabase db reset` (or `npx supabase migration up` against the local dev stack, whichever this repo's other plans used — see `docs/superpowers/plans/2026-09-21-billing-legal-hardening.md` for the exact local Supabase invocation this project already uses).

Expected: migration applies cleanly, no errors. Verify with:
```bash
docker exec -i <supabase-db-container> psql -U postgres -d postgres -c "\d public.admin_users" -c "\d public.admin_audit_log" -c "\d public.nodes" -c "\d public.vpn_accounts"
```
Expected: all four tables show the new columns/tables exactly as written above.

- [x] **Step 3: Commit**

```bash
git add supabase/migrations/20260922000000_admin_dashboard.sql
git commit -m "feat(db): add admin_users, admin_audit_log, nodes.last_seen_at, vpn_accounts.enabled"
```

---

### Task 2: `functions/lib/admin-auth.js`

**Files:**
- Create: `functions/lib/admin-auth.js`
- Test: `functions/lib/__tests__/admin-auth.test.js`

**Interfaces:**
- Produces: `authenticateAdmin(request, supabaseAdmin): Promise<{ userId: string, role: string } | null>`, `requireAdmin(request, supabaseAdmin): Promise<{ admin: { userId, role } | null, response: Response | null }>`. Every Task 7-14 route imports `requireAdmin` from this file.
- Consumes: nothing new — same `supabaseAdmin.auth.getUser` call already used in `functions/api/cancel-subscription.js`.

- [x] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const maybeSingle = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle,
    })),
  })),
}));

const { authenticateAdmin, requireAdmin } = await import("../admin-auth.js");
const { createClient } = await import("@supabase/supabase-js");
const supabaseAdmin = createClient("url", "key");

function makeRequest(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request("https://example.test/api/admin/overview", { headers });
}

beforeEach(() => {
  getUser.mockReset();
  maybeSingle.mockReset();
});

describe("authenticateAdmin", () => {
  it("returns null with no Authorization header", async () => {
    const result = await authenticateAdmin(makeRequest(), supabaseAdmin);
    expect(result).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("returns null when the token is invalid", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad token" } });
    const result = await authenticateAdmin(makeRequest("bad"), supabaseAdmin);
    expect(result).toBeNull();
  });

  it("returns null when the user is not in admin_users", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const result = await authenticateAdmin(makeRequest("good"), supabaseAdmin);
    expect(result).toBeNull();
  });

  it("returns { userId, role } for a valid admin", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
    const result = await authenticateAdmin(makeRequest("good"), supabaseAdmin);
    expect(result).toEqual({ userId: "user-1", role: "owner" });
  });
});

describe("requireAdmin", () => {
  it("returns a 401 Response when not an admin", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad" } });
    const { admin, response } = await requireAdmin(makeRequest("bad"), supabaseAdmin);
    expect(admin).toBeNull();
    expect(response.status).toBe(401);
  });

  it("returns the admin with a null response when authorized", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
    const { admin, response } = await requireAdmin(makeRequest("good"), supabaseAdmin);
    expect(admin).toEqual({ userId: "user-1", role: "owner" });
    expect(response).toBeNull();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run functions/lib/__tests__/admin-auth.test.js`
Expected: FAIL — `functions/lib/admin-auth.js` does not exist yet.

- [x] **Step 3: Write the implementation**

```js
/**
 * Authenticates an admin-dashboard request via the caller's Supabase
 * session (Bearer access token, same shape as every customer-facing
 * route — see functions/api/cancel-subscription.js), then checks
 * admin_users for a role. Returns null for any failure (missing header,
 * invalid token, or a real user who is simply not an admin) — the
 * caller is responsible for turning that into a 401, via requireAdmin
 * below for every route in this plan.
 *
 * @param {Request} request
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @returns {Promise<{ userId: string, role: string } | null>}
 */
export async function authenticateAdmin(request, supabaseAdmin) {
  const authHeader = request.headers.get("Authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return null;

  const {
    data: { user },
    error: tokenError,
  } = await supabaseAdmin.auth.getUser(accessToken);
  if (tokenError || !user) return null;

  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    console.error("authenticateAdmin: lookup failed:", error.message);
    return null;
  }
  if (!data) return null;
  return { userId: user.id, role: data.role };
}

/**
 * Convenience wrapper every /api/admin/* route calls first:
 *   const { admin, response } = await requireAdmin(request, supabaseAdmin);
 *   if (!admin) return response;
 * Keeps the 401 body/headers identical across every admin route instead
 * of each one re-implementing it.
 */
export async function requireAdmin(request, supabaseAdmin) {
  const admin = await authenticateAdmin(request, supabaseAdmin);
  if (!admin) {
    return {
      admin: null,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
  return { admin, response: null };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run functions/lib/__tests__/admin-auth.test.js`
Expected: PASS (6 tests).

- [x] **Step 5: Commit**

```bash
git add functions/lib/admin-auth.js functions/lib/__tests__/admin-auth.test.js
git commit -m "feat(admin): add admin-auth.js authorization helper"
```

---

### Task 3: `functions/lib/admin-audit.js` + `functions/lib/admin-sanitize.js`

**Files:**
- Create: `functions/lib/admin-audit.js`
- Create: `functions/lib/admin-sanitize.js`
- Test: `functions/lib/__tests__/admin-audit.test.js`
- Test: `functions/lib/__tests__/admin-sanitize.test.js`

**Interfaces:**
- Produces: `writeAdminAudit(supabaseAdmin, { adminUserId, action, targetType, targetId, metadata }): Promise<void>`; `sanitizeJobResult(result): object`. Tasks 9-14 (mutation/list routes) both import from here.

- [x] **Step 1: Write the failing tests**

```js
// functions/lib/__tests__/admin-audit.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn();
const supabaseAdmin = { from: vi.fn(() => ({ insert })) };

const { writeAdminAudit } = await import("../admin-audit.js");

beforeEach(() => {
  insert.mockReset();
  insert.mockResolvedValue({ error: null });
});

describe("writeAdminAudit", () => {
  it("inserts one admin_audit_log row with the given fields", async () => {
    await writeAdminAudit(supabaseAdmin, {
      adminUserId: "admin-1",
      action: "admin.disable_user",
      targetType: "vpn_account",
      targetId: 42,
      metadata: { node_id: "node-1" },
    });
    expect(supabaseAdmin.from).toHaveBeenCalledWith("admin_audit_log");
    expect(insert).toHaveBeenCalledWith({
      admin_user_id: "admin-1",
      action: "admin.disable_user",
      target_type: "vpn_account",
      target_id: "42",
      metadata: { node_id: "node-1" },
    });
  });

  it("defaults metadata to {} and does not throw when the insert fails", async () => {
    insert.mockResolvedValue({ error: { message: "db down" } });
    await expect(
      writeAdminAudit(supabaseAdmin, {
        adminUserId: "admin-1",
        action: "admin.enable_user",
        targetType: "vpn_account",
        targetId: 1,
      })
    ).resolves.toBeUndefined();
  });
});
```

```js
// functions/lib/__tests__/admin-sanitize.test.js
import { describe, it, expect } from "vitest";
import { sanitizeJobResult } from "../admin-sanitize.js";

describe("sanitizeJobResult", () => {
  it("redacts subscription_url", () => {
    const clean = sanitizeJobResult({ vpn_user_id: "vpn-1", subscription_url: "https://secret" });
    expect(clean.vpn_user_id).toBe("vpn-1");
    expect(clean.subscription_url).toBe("[redacted]");
  });

  it("passes through null/undefined unchanged", () => {
    expect(sanitizeJobResult(null)).toBeNull();
    expect(sanitizeJobResult(undefined)).toBeUndefined();
  });

  it("passes through a result with no sensitive keys unchanged", () => {
    const result = { foo: "bar" };
    expect(sanitizeJobResult(result)).toEqual({ foo: "bar" });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run functions/lib/__tests__/admin-audit.test.js functions/lib/__tests__/admin-sanitize.test.js`
Expected: FAIL — neither implementation file exists yet.

- [x] **Step 3: Write the implementations**

```js
// functions/lib/admin-audit.js

/**
 * Writes one row to admin_audit_log. Every /api/admin/* mutation route
 * calls this after its provisioning_jobs insert succeeds (never before —
 * an audit-log write failure must not block a real mutation, and a
 * mutation failure must not produce a misleading audit row).
 *
 * NEVER put a subscription URL, VPN token, node API key, or private key
 * into metadata. metadata is for identifiers only (node_id, job_id,
 * vpn_account_id) — see docs/superpowers/plans/2026-09-22-admin-dashboard.md
 * Global Constraints.
 */
export async function writeAdminAudit(
  supabaseAdmin,
  { adminUserId, action, targetType, targetId, metadata = {} }
) {
  const { error } = await supabaseAdmin.from("admin_audit_log").insert({
    admin_user_id: adminUserId,
    action,
    target_type: targetType,
    target_id: String(targetId),
    metadata,
  });
  if (error) {
    console.error("writeAdminAudit: insert failed:", error.message);
  }
}
```

```js
// functions/lib/admin-sanitize.js

// Keys that must never reach an admin API response. subscription_url is
// the plaintext VPN credential (see functions/api/agent/jobs/[id]/complete.js,
// where CREATE_USER/ROTATE_SUBSCRIPTION_TOKEN completions carry it in
// `result`). Extend this list if a future job_type's result ever carries
// another secret.
const SENSITIVE_RESULT_KEYS = ["subscription_url"];

/**
 * Returns a copy of a provisioning_jobs.result value with sensitive keys
 * redacted. Every admin route that returns job data (functions/api/admin/jobs.js,
 * functions/api/admin/customers/[id]/index.js) must pass result through
 * this before sending it to the browser.
 */
export function sanitizeJobResult(result) {
  if (!result || typeof result !== "object") return result;
  const clean = { ...result };
  for (const key of SENSITIVE_RESULT_KEYS) {
    if (key in clean) clean[key] = "[redacted]";
  }
  return clean;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run functions/lib/__tests__/admin-audit.test.js functions/lib/__tests__/admin-sanitize.test.js`
Expected: PASS (5 tests).

- [x] **Step 5: Commit**

```bash
git add functions/lib/admin-audit.js functions/lib/admin-sanitize.js functions/lib/__tests__/admin-audit.test.js functions/lib/__tests__/admin-sanitize.test.js
git commit -m "feat(admin): add audit-log writer and job-result sanitizer"
```

---

### Task 4: `functions/lib/resolve-node.js` and remove hardcoded `"node-1"`

**Files:**
- Create: `functions/lib/resolve-node.js`
- Test: `functions/lib/__tests__/resolve-node.test.js`
- Modify: `functions/lib/stripe-events.js` (6 occurrences of `"node-1"`)
- Modify: `functions/lib/__tests__/stripe-events.test.js` if any assertion hardcodes `"node-1"` as an expected literal (check first; if present, no change needed since the value is unchanged, only its source is)

**Interfaces:**
- Produces: `resolveNodeForUser(): string`. Tasks 10-11 (admin mutation routes) also import this instead of writing `"node-1"` themselves.

- [x] **Step 1: Write the failing test**

```js
import { describe, it, expect } from "vitest";
import { resolveNodeForUser } from "../resolve-node.js";

describe("resolveNodeForUser", () => {
  it("returns node-1 (the only node today)", () => {
    expect(resolveNodeForUser()).toBe("node-1");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run functions/lib/__tests__/resolve-node.test.js`
Expected: FAIL — file does not exist.

- [x] **Step 3: Write the implementation**

```js
/**
 * Single choke point for "which node does this user's VPN account live
 * on". Every call site that used to write the literal "node-1" now goes
 * through here — functions/lib/stripe-events.js and every admin
 * mutation route in this plan — so a second node later is a change in
 * this one function (once real routing logic exists: health, region,
 * capacity), not a grep-and-replace across the codebase. Deliberately
 * NOT parameterized by user/region yet — that logic does not exist, and
 * adding an unused parameter now would be speculative.
 */
export function resolveNodeForUser() {
  return "node-1";
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run functions/lib/__tests__/resolve-node.test.js`
Expected: PASS.

- [x] **Step 5: Replace the six literals in `functions/lib/stripe-events.js`**

Add near the top of the file:
```js
import { resolveNodeForUser } from "./resolve-node.js";
```

Replace each of these three patterns (two occurrences each, at the line numbers found by `grep -n 'node-1' functions/lib/stripe-events.js` before this edit):
```js
.eq("node_id", "node-1")
```
→
```js
.eq("node_id", resolveNodeForUser())
```
and
```js
node_id: "node-1",
```
→
```js
node_id: resolveNodeForUser(),
```

- [x] **Step 6: Run the full existing test suite to confirm no regression**

Run: `npx vitest run functions/lib/__tests__/stripe-events.test.js`
Expected: PASS, unchanged — the returned value is identical (`"node-1"`), only its source changed.

- [x] **Step 7: Commit**

```bash
git add functions/lib/resolve-node.js functions/lib/__tests__/resolve-node.test.js functions/lib/stripe-events.js
git commit -m "refactor(admin): introduce resolveNodeForUser, remove hardcoded node-1"
```

---

### Task 5: Node `last_seen_at` heartbeat + `vpn_accounts.enabled` on completion

**Files:**
- Modify: `functions/api/agent/claim.js`
- Modify: `functions/api/agent/jobs/[id]/complete.js`
- Modify (if present): `functions/api/__tests__/` — check whether tests exist for these two files today; if not, create `functions/api/__tests__/agent-claim.test.js` and extend/verify `functions/api/agent/jobs/[id]/complete.js`'s existing coverage (search first: `find functions -iname '*complete*test*'`)

**Interfaces:**
- Consumes: `authenticateNode` (unchanged, `functions/lib/node-auth.js`).
- Produces: `nodes.last_seen_at` updated on every successful `authenticateNode` call inside `claim.js`; `vpn_accounts.enabled` set to `false`/`true` on `DISABLE_USER`/`ENABLE_USER` completion.

- [x] **Step 1: Check existing test coverage**

Run: `find "D:/ISDA/vpn-web/functions/api" -iname "*claim*" -o -iname "*complete*"` and read whichever test files exist under `functions/api/__tests__/agent/` (or equivalent) before writing new tests, so Step 2 below extends rather than duplicates them. If no test file exists for `claim.js` or `complete.js` today, create `functions/api/agent/__tests__/claim.test.js` and `functions/api/agent/jobs/[id]/__tests__/complete.test.js` following the exact `vi.mock("@supabase/supabase-js", ...)` shape from `functions/api/__tests__/cancel-subscription.test.js`.

- [x] **Step 2: Write the failing test for `claim.js`**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const update = vi.fn();
const eqNodeId = vi.fn();
const rpc = vi.fn();

vi.mock("../../lib/node-auth.js", () => ({
  authenticateNode: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({ update: update.mockReturnValue({ eq: eqNodeId }) })),
    rpc,
  })),
}));

const { authenticateNode } = await import("../../lib/node-auth.js");
const { onRequestPost } = await import("../claim.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

beforeEach(() => {
  update.mockClear();
  eqNodeId.mockReset().mockResolvedValue({ error: null });
  rpc.mockReset().mockResolvedValue({ data: [], error: null });
});

describe("agent/claim last_seen_at", () => {
  it("updates nodes.last_seen_at after a successful authentication", async () => {
    authenticateNode.mockResolvedValue("node-1");
    const request = new Request("https://example.test/api/agent/claim", {
      method: "POST",
      headers: { Authorization: "Bearer key" },
    });
    await onRequestPost({ env, request });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ last_seen_at: expect.any(String) }));
    expect(eqNodeId).toHaveBeenCalledWith("node_id", "node-1");
  });

  it("does not touch nodes when authentication fails", async () => {
    authenticateNode.mockResolvedValue(null);
    const request = new Request("https://example.test/api/agent/claim", { method: "POST" });
    await onRequestPost({ env, request });
    expect(update).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `npx vitest run functions/api/agent/__tests__/claim.test.js` (or wherever Step 1 placed it)
Expected: FAIL — `claim.js` does not update `last_seen_at` yet.

- [x] **Step 4: Update `functions/api/agent/claim.js`**

Insert immediately after the existing `if (!nodeId) { ... }` unauthorized-return block, before the `try { ... rpc(...) }`:
```js
  await supabaseAdmin
    .from("nodes")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("node_id", nodeId);
```
Note: this write is fire-and-forget on purpose — a `last_seen_at` update failing must never block the actual job claim that follows. Do not `await` it inside a `try` that would turn its failure into a 500; if the project's lint rules complain about an unhandled promise, wrap only the logging: `.catch((err) => console.error("claim: last_seen_at update failed:", err.message))` rather than blocking the response on it.

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run functions/api/agent/__tests__/claim.test.js`
Expected: PASS.

- [x] **Step 6: Write the failing test for `complete.js`'s `vpn_accounts.enabled` write**

Extend whichever existing (or newly created per Step 1) test file for `complete.js` with:
```js
it("sets vpn_accounts.enabled = false on a DISABLE_USER completion", async () => {
  // job lookup mock returns { job_type: "DISABLE_USER", vpn_account_id: 7, node_id: "node-1", status: "claimed" }
  // assert supabaseAdmin.from("vpn_accounts").update({ enabled: false }).eq("id", 7) was called
});

it("sets vpn_accounts.enabled = true on an ENABLE_USER completion", async () => {
  // same shape, job_type: "ENABLE_USER", assert update({ enabled: true })
});
```
Write these against the actual mock scaffolding already in this file/its sibling — the exact mock shape depends on what Step 1 finds; match its existing `from(...).update(...).eq(...)` chain style.

- [x] **Step 7: Run test to verify it fails**

Expected: FAIL — `complete.js` does not write `vpn_accounts.enabled` yet.

- [x] **Step 8: Update `functions/api/agent/jobs/[id]/complete.js`**

In the `if (job.job_type === "CREATE_USER") { ... } else if (job.job_type === "ROTATE_SUBSCRIPTION_TOKEN") { ... }` chain, add:
```js
    } else if (job.job_type === "DISABLE_USER" || job.job_type === "ENABLE_USER") {
      if (!vpnAccountId) {
        throw new Error(`${job.job_type} job ${jobId} has no vpn_account_id`);
      }
      const { error: enabledError } = await supabaseAdmin
        .from("vpn_accounts")
        .update({ enabled: job.job_type === "ENABLE_USER" })
        .eq("id", vpnAccountId);
      if (enabledError) throw new Error(`vpn_accounts enabled-update failed: ${enabledError.message}`);
    }
```
Replace the now-inaccurate comment `// SET_EXPIRY / ENABLE_USER / DISABLE_USER: no additional writes here.` with `// SET_EXPIRY: no additional writes here.` since ENABLE_USER/DISABLE_USER now do write.

- [x] **Step 9: Run test to verify it passes**

Expected: PASS.

- [x] **Step 10: Commit**

```bash
git add functions/api/agent/claim.js functions/api/agent/jobs/[id]/complete.js functions/api/agent/__tests__/claim.test.js
git commit -m "feat(admin): record node last_seen_at and persist vpn_accounts.enabled"
```

---

### Task 6: `scripts/grant-admin.mjs`

**Files:**
- Create: `scripts/grant-admin.mjs`

**Interfaces:**
- Consumes: `admin_users` table (Task 1).
- Produces: nothing consumed by later tasks — this is an operator-run bootstrap script, not application code.

- [x] **Step 1: Write the script**

```js
#!/usr/bin/env node
// scripts/grant-admin.mjs — run manually, once, to grant the first
// "owner" admin role. Mirrors scripts/register-node.mjs's shape.
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/grant-admin.mjs <email> [role]
import { createClient } from "@supabase/supabase-js";

const email = process.argv[2];
const role = process.argv[3] ?? "owner";
if (!email) {
  console.error("Usage: node scripts/grant-admin.mjs <email> [owner|operator|readonly]");
  process.exit(1);
}
if (!["owner", "operator", "readonly"].includes(role)) {
  console.error(`Invalid role "${role}" — must be owner, operator, or readonly.`);
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment first.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// auth.users is not exposed via PostgREST even to service_role — the
// GoTrue admin API (auth.admin.*) is the only way to look up a user by
// email from a script like this.
const { data: usersPage, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
if (listError) {
  console.error("Failed to list users:", listError.message);
  process.exit(1);
}
const user = usersPage.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No Supabase auth user found with email "${email}". They must sign up first.`);
  process.exit(1);
}

const { error } = await supabase
  .from("admin_users")
  .upsert({ user_id: user.id, role });
if (error) {
  console.error("Failed to grant admin role:", error.message);
  process.exit(1);
}

console.log(`Granted role "${role}" to ${email} (user_id=${user.id}).`);
```

- [x] **Step 2: Verify manually**

Run against the local dev Supabase stack: `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/grant-admin.mjs you@example.com owner` after signing up that email locally.
Expected: prints `Granted role "owner" to you@example.com (user_id=...)`; a subsequent `select * from admin_users` shows the row.

- [x] **Step 3: Commit**

```bash
git add scripts/grant-admin.mjs
git commit -m "feat(admin): add grant-admin.mjs bootstrap script"
```

---

### Task 7: `GET /api/admin/overview`

**Files:**
- Create: `functions/api/admin/overview.js`
- Test: `functions/api/admin/__tests__/overview.test.js`

**Interfaces:**
- Consumes: `requireAdmin` (Task 2).
- Produces: `{ customers: { total, active, past_due, canceled }, vpn: { accounts }, jobs: { pending, claimed, failed }, nodes: { online, offline } }`. This exact shape is what `src/app/admin/page.tsx` (Task 16) renders.

- [x] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
const countQueries = {};

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      return countQueries[table]();
    }),
  })),
}));

const { onRequestGet } = await import("../overview.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/overview", {
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
});

describe("GET /api/admin/overview", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
  });

  it("returns aggregate counts for an admin", async () => {
    countQueries.subscriptions = () => ({
      select: vi.fn(() => Promise.resolve({ count: 43, data: null, error: null })),
    });
    // ... additional per-table mock wiring for vpn_accounts/provisioning_jobs/nodes,
    // following the same shape — implementer fills in exact counts and asserts
    // the full response body matches the documented shape.
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("customers");
    expect(body).toHaveProperty("vpn");
    expect(body).toHaveProperty("jobs");
    expect(body).toHaveProperty("nodes");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run functions/api/admin/__tests__/overview.test.js`
Expected: FAIL — `overview.js` does not exist.

- [x] **Step 3: Write the implementation**

```js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const [
      { count: activeCount },
      { count: pastDueCount },
      { count: canceledCount },
      { count: totalSubs },
      { count: vpnAccountCount },
      { count: pendingJobs },
      { count: claimedJobs },
      { count: failedJobs },
      { data: nodes },
    ] = await Promise.all([
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).in("status", ["trialing", "active"]),
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).eq("status", "past_due"),
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).eq("status", "canceled"),
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("vpn_accounts").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("provisioning_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabaseAdmin.from("provisioning_jobs").select("id", { count: "exact", head: true }).eq("status", "claimed"),
      supabaseAdmin.from("provisioning_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
      supabaseAdmin.from("nodes").select("last_seen_at, revoked_at"),
    ]);

    const now = Date.now();
    const onlineCount = (nodes ?? []).filter(
      (n) => !n.revoked_at && n.last_seen_at && now - new Date(n.last_seen_at).getTime() < 45_000
    ).length;
    const offlineCount = (nodes ?? []).filter((n) => !n.revoked_at).length - onlineCount;

    return jsonResponse({
      customers: { total: totalSubs ?? 0, active: activeCount ?? 0, past_due: pastDueCount ?? 0, canceled: canceledCount ?? 0 },
      vpn: { accounts: vpnAccountCount ?? 0 },
      jobs: { pending: pendingJobs ?? 0, claimed: claimedJobs ?? 0, failed: failedJobs ?? 0 },
      nodes: { online: onlineCount, offline: offlineCount },
    });
  } catch (err) {
    console.error("admin/overview: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run functions/api/admin/__tests__/overview.test.js`
Expected: PASS. Fill in the `countQueries` table-mock wiring left as a comment in Step 1 with concrete mocks for `vpn_accounts`, `provisioning_jobs`, and `nodes` before this passes — the implementer completes that wiring as part of making the test real, not left as a stub in the committed test file.

- [x] **Step 5: Commit**

```bash
git add functions/api/admin/overview.js functions/api/admin/__tests__/overview.test.js
git commit -m "feat(admin): add GET /api/admin/overview"
```

---

### Task 8: `GET /api/admin/customers`

**Files:**
- Create: `functions/api/admin/customers.js`
- Test: `functions/api/admin/__tests__/customers.test.js`

**Interfaces:**
- Consumes: `requireAdmin`.
- Produces: `{ customers: [{ userId, email, subscriptionStatus, currentPeriodEnd, vpnAccountId, vpnUserId, nodeId, enabled }] }`. Task 17's list page renders this array directly.

- [x] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
const listUsers = vi.fn();
let subsResult = { data: [], error: null };
let vpnResult = { data: [], error: null };

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser, admin: { listUsers } },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "subscriptions") {
        return { select: vi.fn(() => ({ order: vi.fn(() => Promise.resolve(subsResult)) })) };
      }
      if (table === "vpn_accounts") {
        return { select: vi.fn(() => Promise.resolve(vpnResult)) };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../customers.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(query = "") {
  return new Request(`https://example.test/api/admin/customers${query}`, {
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  listUsers.mockReset().mockResolvedValue({
    data: { users: [{ id: "user-1", email: "alice@example.com" }] },
    error: null,
  });
  subsResult = {
    data: [{ user_id: "user-1", status: "active", current_period_end: "2026-10-21T00:00:00Z" }],
    error: null,
  };
  vpnResult = {
    data: [{ id: 1, user_id: "user-1", vpn_user_id: "vpn-abc", node_id: "node-1", enabled: true }],
    error: null,
  };
});

describe("GET /api/admin/customers", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
  });

  it("merges subscriptions, vpn_accounts, and auth emails into one row per customer", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.customers).toEqual([
      {
        userId: "user-1",
        email: "alice@example.com",
        subscriptionStatus: "active",
        currentPeriodEnd: "2026-10-21T00:00:00Z",
        vpnAccountId: 1,
        vpnUserId: "vpn-abc",
        nodeId: "node-1",
        enabled: true,
      },
    ]);
  });

  it("filters by the q query param against email/vpn_user_id", async () => {
    const res = await onRequestGet({ env, request: makeRequest("?q=bob") });
    const body = await res.json();
    expect(body.customers).toEqual([]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run functions/api/admin/__tests__/customers.test.js`
Expected: FAIL.

- [x] **Step 3: Write the implementation**

```js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// v1 simplification: fetches all subscriptions/vpn_accounts and joins in
// memory, since auth.users (needed for email) is not queryable via
// PostgREST even for service_role — only the GoTrue admin API can look
// it up, and that API has no server-side "join with a public table"
// primitive. Fine at the customer counts docs/DEVICE_ACCEPTANCE_TESTS.md-
// style examples show (dozens); revisit with real SQL pagination if this
// grows into the thousands.
export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.toLowerCase() ?? "";

    const [{ data: subs, error: subsError }, { data: vpnAccounts, error: vpnError }, { data: usersPage, error: usersError }] =
      await Promise.all([
        supabaseAdmin.from("subscriptions").select("user_id, status, current_period_end").order("created_at", { ascending: false }),
        supabaseAdmin.from("vpn_accounts").select("id, user_id, vpn_user_id, node_id, enabled"),
        supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
      ]);
    if (subsError) throw new Error(`subscriptions query failed: ${subsError.message}`);
    if (vpnError) throw new Error(`vpn_accounts query failed: ${vpnError.message}`);
    if (usersError) throw new Error(`listUsers failed: ${usersError.message}`);

    const emailByUserId = new Map(usersPage.users.map((u) => [u.id, u.email]));
    const vpnByUserId = new Map(vpnAccounts.map((v) => [v.user_id, v]));

    let customers = subs.map((sub) => {
      const vpn = vpnByUserId.get(sub.user_id);
      return {
        userId: sub.user_id,
        email: emailByUserId.get(sub.user_id) ?? null,
        subscriptionStatus: sub.status,
        currentPeriodEnd: sub.current_period_end,
        vpnAccountId: vpn?.id ?? null,
        vpnUserId: vpn?.vpn_user_id ?? null,
        nodeId: vpn?.node_id ?? null,
        enabled: vpn?.enabled ?? null,
      };
    });

    if (q) {
      customers = customers.filter(
        (c) =>
          c.email?.toLowerCase().includes(q) ||
          c.userId.toLowerCase().includes(q) ||
          c.vpnUserId?.toLowerCase().includes(q)
      );
    }

    return jsonResponse({ customers });
  } catch (err) {
    console.error("admin/customers: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run functions/api/admin/__tests__/customers.test.js`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add functions/api/admin/customers.js functions/api/admin/__tests__/customers.test.js
git commit -m "feat(admin): add GET /api/admin/customers"
```

---

### Task 9: `GET /api/admin/customers/:id`

**Files:**
- Create: `functions/api/admin/customers/[id]/index.js`
- Test: `functions/api/admin/customers/[id]/__tests__/index.test.js`

**Interfaces:**
- Consumes: `requireAdmin`, `sanitizeJobResult` (Task 3).
- Produces: `{ userId, email, subscription: {...}, vpnAccount: {...} | null, jobs: [{ id, jobType, status, createdAt, claimedAt, completedAt, result }] }`. `result` is always passed through `sanitizeJobResult`. Task 18's detail page renders this.

- [x] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
const getUserById = vi.fn();
let subMaybeSingle, vpnMaybeSingle, jobsOrder;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser, admin: { getUserById } },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "subscriptions") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: subMaybeSingle };
      }
      if (table === "vpn_accounts") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vpnMaybeSingle };
      }
      if (table === "provisioning_jobs") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: jobsOrder };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../index.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/customers/user-1", {
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  getUserById.mockReset().mockResolvedValue({ data: { user: { email: "alice@example.com" } }, error: null });
  subMaybeSingle = vi.fn().mockResolvedValue({ data: { status: "active", current_period_end: "2026-10-21T00:00:00Z" }, error: null });
  vpnMaybeSingle = vi.fn().mockResolvedValue({ data: { id: 1, vpn_user_id: "vpn-abc", node_id: "node-1", enabled: true }, error: null });
  jobsOrder = vi.fn().mockResolvedValue({
    data: [{ id: 9, job_type: "CREATE_USER", status: "done", created_at: "t1", claimed_at: "t2", completed_at: "t3", result: { subscription_url: "https://secret" } }],
    error: null,
  });
});

describe("GET /api/admin/customers/:id", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(401);
  });

  it("redacts subscription_url in job history", async () => {
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.jobs[0].result.subscription_url).toBe("[redacted]");
  });

  it("returns null vpnAccount when the user has none", async () => {
    vpnMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    const body = await res.json();
    expect(body.vpnAccount).toBeNull();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [x] **Step 3: Write the implementation**

```js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { sanitizeJobResult } from "../../../lib/admin-sanitize.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  const userId = params.id;

  try {
    const [{ data: user, error: userError }, { data: sub }, { data: vpnAccount }] = await Promise.all([
      supabaseAdmin.auth.admin.getUserById(userId),
      supabaseAdmin.from("subscriptions").select("status, current_period_end, stripe_customer_id, stripe_subscription_id").eq("user_id", userId).maybeSingle(),
      supabaseAdmin.from("vpn_accounts").select("id, vpn_user_id, node_id, enabled").eq("user_id", userId).maybeSingle(),
    ]);
    if (userError || !user?.user) {
      return jsonResponse({ error: "Customer not found" }, 404);
    }

    let jobs = [];
    if (vpnAccount) {
      const { data: jobRows, error: jobsError } = await supabaseAdmin
        .from("provisioning_jobs")
        .select("id, job_type, status, created_at, claimed_at, completed_at, result")
        .eq("vpn_account_id", vpnAccount.id)
        .order("created_at", { ascending: false });
      if (jobsError) throw new Error(`provisioning_jobs query failed: ${jobsError.message}`);
      jobs = jobRows.map((j) => ({
        id: j.id,
        jobType: j.job_type,
        status: j.status,
        createdAt: j.created_at,
        claimedAt: j.claimed_at,
        completedAt: j.completed_at,
        result: sanitizeJobResult(j.result),
      }));
    }

    return jsonResponse({
      userId,
      email: user.user.email,
      subscription: sub
        ? {
            status: sub.status,
            currentPeriodEnd: sub.current_period_end,
            stripeCustomerId: sub.stripe_customer_id,
            stripeSubscriptionId: sub.stripe_subscription_id,
          }
        : null,
      vpnAccount: vpnAccount
        ? { id: vpnAccount.id, vpnUserId: vpnAccount.vpn_user_id, nodeId: vpnAccount.node_id, enabled: vpnAccount.enabled }
        : null,
      jobs,
    });
  } catch (err) {
    console.error("admin/customers/:id: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add "functions/api/admin/customers/[id]/index.js" "functions/api/admin/customers/[id]/__tests__/index.test.js"
git commit -m "feat(admin): add GET /api/admin/customers/:id"
```

---

### Task 10: `POST /api/admin/customers/:id/disable` and `.../enable`

**Files:**
- Create: `functions/api/admin/customers/[id]/disable.js`
- Create: `functions/api/admin/customers/[id]/enable.js`
- Test: `functions/api/admin/customers/[id]/__tests__/disable.test.js`
- Test: `functions/api/admin/customers/[id]/__tests__/enable.test.js`

**Interfaces:**
- Consumes: `requireAdmin`, `writeAdminAudit`, `resolveNodeForUser` is NOT used here — the existing `vpn_accounts.node_id` for this specific user is looked up directly, since the account may already be on a specific node (resolveNodeForUser is only for brand-new accounts at creation time, per Task 4's scope).
- Produces: a `provisioning_jobs` row with `job_type: "DISABLE_USER"` / `"ENABLE_USER"`, and one `admin_audit_log` row.

- [x] **Step 1: Write the failing test (disable; enable is the mirror)**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
const vpnMaybeSingle = vi.fn();
const jobInsert = vi.fn();
const auditInsert = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "vpn_accounts") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vpnMaybeSingle };
      if (table === "provisioning_jobs") return { insert: jobInsert };
      if (table === "admin_audit_log") return { insert: auditInsert };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestPost } = await import("../disable.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/customers/user-1/disable", {
    method: "POST",
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  vpnMaybeSingle.mockReset().mockResolvedValue({ data: { id: 1, node_id: "node-1" }, error: null });
  jobInsert.mockReset().mockResolvedValue({ error: null });
  auditInsert.mockReset().mockResolvedValue({ error: null });
});

describe("POST /api/admin/customers/:id/disable", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the user has no vpn_account", async () => {
    vpnMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(404);
  });

  it("inserts a DISABLE_USER job and an audit row", async () => {
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    expect(jobInsert).toHaveBeenCalledWith(
      expect.objectContaining({ job_type: "DISABLE_USER", node_id: "node-1", vpn_account_id: 1 })
    );
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.disable_user", target_type: "vpn_account", target_id: "1" })
    );
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [x] **Step 3: Write `disable.js`**

```js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../lib/admin-audit.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  const userId = params.id;

  try {
    const { data: vpnAccount, error: vpnError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id, node_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (vpnError) throw new Error(`vpn_accounts lookup failed: ${vpnError.message}`);
    if (!vpnAccount) return jsonResponse({ error: "No VPN account for this user" }, 404);

    const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: `admin-disable-user:${vpnAccount.id}:${Date.now()}`,
      node_id: vpnAccount.node_id,
      job_type: "DISABLE_USER",
      vpn_account_id: vpnAccount.id,
      payload: {},
    });
    if (jobError) throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.disable_user",
      targetType: "vpn_account",
      targetId: vpnAccount.id,
      metadata: { user_id: userId, node_id: vpnAccount.node_id },
    });

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("admin/customers/:id/disable: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Expected: PASS.

- [x] **Step 5: Write the mirrored `enable.js` and its test**

Same file shape as `disable.js`, with `job_type: "ENABLE_USER"`, `idempotency_key: \`admin-enable-user:${vpnAccount.id}:${Date.now()}\``, and `action: "admin.enable_user"`. Copy `disable.test.js`, changing the import to `../enable.js` and the assertions to `ENABLE_USER`/`admin.enable_user`.

- [x] **Step 6: Run both tests to verify they pass**

Run: `npx vitest run "functions/api/admin/customers/[id]/__tests__/disable.test.js" "functions/api/admin/customers/[id]/__tests__/enable.test.js"`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add "functions/api/admin/customers/[id]/disable.js" "functions/api/admin/customers/[id]/enable.js" "functions/api/admin/customers/[id]/__tests__/disable.test.js" "functions/api/admin/customers/[id]/__tests__/enable.test.js"
git commit -m "feat(admin): add disable/enable customer mutation routes"
```

---

### Task 11: `POST /api/admin/customers/:id/rotate`

**Files:**
- Create: `functions/api/admin/customers/[id]/rotate.js`
- Test: `functions/api/admin/customers/[id]/__tests__/rotate.test.js`

**Interfaces:**
- Same shape as Task 10, `job_type: "ROTATE_SUBSCRIPTION_TOKEN"`, `action: "admin.rotate_subscription"`. This is the first place in the codebase that ever creates a `ROTATE_SUBSCRIPTION_TOKEN` job — confirm the provisioning agent (sibling `singbox-vpn` repo) already implements this job type before shipping (it's declared in the job-type enum and handled in `complete.js`, but had no caller before this task).

- [x] **Step 1: Write the failing test**

Copy the structure of Task 10's `disable.test.js`, importing `../rotate.js` and asserting `job_type: "ROTATE_SUBSCRIPTION_TOKEN"` and `action: "admin.rotate_subscription"`.

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [x] **Step 3: Write the implementation**

Same shape as `disable.js`, with:
```js
    const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: `admin-rotate-subscription:${vpnAccount.id}:${Date.now()}`,
      node_id: vpnAccount.node_id,
      job_type: "ROTATE_SUBSCRIPTION_TOKEN",
      vpn_account_id: vpnAccount.id,
      payload: {},
    });
```
and
```js
    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.rotate_subscription",
      targetType: "vpn_account",
      targetId: vpnAccount.id,
      metadata: { user_id: userId, node_id: vpnAccount.node_id },
    });
```

- [x] **Step 4: Run test to verify it passes**

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add "functions/api/admin/customers/[id]/rotate.js" "functions/api/admin/customers/[id]/__tests__/rotate.test.js"
git commit -m "feat(admin): add rotate-subscription-token customer mutation route"
```

---

### Task 12: `GET /api/admin/jobs` and `POST /api/admin/jobs/:id/retry`

**Files:**
- Create: `functions/api/admin/jobs.js`
- Create: `functions/api/admin/jobs/[id]/retry.js`
- Test: `functions/api/admin/__tests__/jobs.test.js`
- Test: `functions/api/admin/jobs/[id]/__tests__/retry.test.js`

**Interfaces:**
- Consumes: `requireAdmin`, `sanitizeJobResult`, `writeAdminAudit`.
- Produces: `{ jobs: [{ id, jobType, status, nodeId, vpnAccountId, createdAt, claimedAt, completedAt, result }] }` (list, newest first, optional `?status=` filter); retry returns `{ ok: true, jobId: <new id> }`.

- [x] **Step 1: Write the failing test for the list route**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
let jobsQuery;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "provisioning_jobs") return jobsQuery();
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../jobs.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(query = "") {
  return new Request(`https://example.test/api/admin/jobs${query}`, { headers: { Authorization: "Bearer good" } });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  jobsQuery = () => ({
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    then: (resolve) =>
      resolve({
        data: [{ id: 5, job_type: "CREATE_USER", status: "failed", node_id: "node-1", vpn_account_id: 1, created_at: "t1", claimed_at: "t2", completed_at: null, result: { subscription_url: "secret" } }],
        error: null,
      }),
  });
});

describe("GET /api/admin/jobs", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
  });

  it("redacts subscription_url in every job's result", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.jobs[0].result.subscription_url).toBe("[redacted]");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [x] **Step 3: Write `jobs.js`**

```js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";
import { sanitizeJobResult } from "../../lib/admin-sanitize.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");

    let query = supabaseAdmin
      .from("provisioning_jobs")
      .select("id, job_type, status, node_id, vpn_account_id, created_at, claimed_at, completed_at, result")
      .order("created_at", { ascending: false })
      .limit(200);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw new Error(`provisioning_jobs query failed: ${error.message}`);

    const jobs = data.map((j) => ({
      id: j.id,
      jobType: j.job_type,
      status: j.status,
      nodeId: j.node_id,
      vpnAccountId: j.vpn_account_id,
      createdAt: j.created_at,
      claimedAt: j.claimed_at,
      completedAt: j.completed_at,
      result: sanitizeJobResult(j.result),
    }));

    return jsonResponse({ jobs });
  } catch (err) {
    console.error("admin/jobs: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Expected: PASS.

- [x] **Step 5: Write the failing test for retry**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
const jobMaybeSingle = vi.fn();
const jobInsert = vi.fn();
const auditInsert = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "provisioning_jobs") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: jobMaybeSingle, insert: jobInsert };
      if (table === "admin_audit_log") return { insert: auditInsert };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestPost } = await import("../retry.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/jobs/5/retry", { method: "POST", headers: { Authorization: "Bearer good" } });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  jobMaybeSingle.mockReset().mockResolvedValue({
    data: { id: 5, job_type: "CREATE_USER", status: "failed", node_id: "node-1", vpn_account_id: 1, payload: { user_id: "user-1" } },
    error: null,
  });
  jobInsert.mockReset().mockResolvedValue({ error: null });
  auditInsert.mockReset().mockResolvedValue({ error: null });
});

describe("POST /api/admin/jobs/:id/retry", () => {
  it("returns 400 when the job is not failed", async () => {
    jobMaybeSingle.mockResolvedValue({ data: { id: 5, status: "done" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "5" } });
    expect(res.status).toBe(400);
  });

  it("inserts a new job copying the failed job's payload, and an audit row", async () => {
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "5" } });
    expect(res.status).toBe(200);
    expect(jobInsert).toHaveBeenCalledWith(
      expect.objectContaining({ job_type: "CREATE_USER", node_id: "node-1", vpn_account_id: 1, payload: { user_id: "user-1" } })
    );
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.retry_job" })
    );
  });
});
```

- [x] **Step 6: Run test to verify it fails**

Expected: FAIL.

- [x] **Step 7: Write `jobs/[id]/retry.js`**

```js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../lib/admin-audit.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// v1 retry: inserts a brand-new job copying the failed job's shape.
// Deliberately does NOT flip the original row back to "pending" (that
// would lose history and could incorrectly replay a job whose side
// effect already partially happened) and does NOT add a parent_job_id
// column yet (see docs/superpowers/plans/2026-09-22-admin-dashboard.md
// Open Items) — the admin_audit_log row's metadata.original_job_id is
// enough lineage for v1.
export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  const jobId = params.id;

  try {
    const { data: job, error: jobError } = await supabaseAdmin
      .from("provisioning_jobs")
      .select("id, job_type, status, node_id, vpn_account_id, payload")
      .eq("id", jobId)
      .maybeSingle();
    if (jobError) throw new Error(`provisioning_jobs lookup failed: ${jobError.message}`);
    if (!job) return jsonResponse({ error: "Job not found" }, 404);
    if (job.status !== "failed") return jsonResponse({ error: "Only failed jobs can be retried" }, 400);

    const { data: newJob, error: insertError } = await supabaseAdmin
      .from("provisioning_jobs")
      .insert({
        idempotency_key: `admin-retry:${job.id}:${Date.now()}`,
        node_id: job.node_id,
        job_type: job.job_type,
        vpn_account_id: job.vpn_account_id,
        payload: job.payload,
      })
      .select("id")
      .single();
    if (insertError) throw new Error(`provisioning_jobs insert failed: ${insertError.message}`);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.retry_job",
      targetType: "provisioning_job",
      targetId: newJob.id,
      metadata: { original_job_id: job.id },
    });

    return jsonResponse({ ok: true, jobId: newJob.id });
  } catch (err) {
    console.error("admin/jobs/:id/retry: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
```

- [x] **Step 8: Run test to verify it passes**

Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add functions/api/admin/jobs.js "functions/api/admin/jobs/[id]/retry.js" functions/api/admin/__tests__/jobs.test.js "functions/api/admin/jobs/[id]/__tests__/retry.test.js"
git commit -m "feat(admin): add jobs list and retry routes"
```

---

### Task 13: `GET /api/admin/nodes`

**Files:**
- Create: `functions/api/admin/nodes.js`
- Test: `functions/api/admin/__tests__/nodes.test.js`

**Interfaces:**
- Consumes: `requireAdmin`.
- Produces: `{ nodes: [{ nodeId, status: "online"|"degraded"|"offline", lastSeenAt, revokedAt }] }`. `status` is derived, never stored, using the same 45s/120s thresholds documented in the proposal this plan is based on.

- [x] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
let nodesSelect;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "nodes") return { select: nodesSelect };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../nodes.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/nodes", { headers: { Authorization: "Bearer good" } });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
});

describe("GET /api/admin/nodes", () => {
  it("classifies a node seen 10s ago as online", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: recent, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("online");
  });

  it("classifies a node seen 90s ago as degraded", async () => {
    const stale = new Date(Date.now() - 90_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: stale, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("degraded");
  });

  it("classifies a node seen 200s ago as offline", async () => {
    const old = new Date(Date.now() - 200_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: old, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("offline");
  });

  it("classifies a node with no last_seen_at as offline", async () => {
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: null, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("offline");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [x] **Step 3: Write the implementation**

```js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function classify(lastSeenAt) {
  if (!lastSeenAt) return "offline";
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  if (ageMs < 45_000) return "online";
  if (ageMs < 120_000) return "degraded";
  return "offline";
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const { data, error } = await supabaseAdmin.from("nodes").select("node_id, last_seen_at, revoked_at");
    if (error) throw new Error(`nodes query failed: ${error.message}`);

    const nodes = data.map((n) => ({
      nodeId: n.node_id,
      status: n.revoked_at ? "revoked" : classify(n.last_seen_at),
      lastSeenAt: n.last_seen_at,
      revokedAt: n.revoked_at,
    }));

    return jsonResponse({ nodes });
  } catch (err) {
    console.error("admin/nodes: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add functions/api/admin/nodes.js functions/api/admin/__tests__/nodes.test.js
git commit -m "feat(admin): add GET /api/admin/nodes with derived online/degraded/offline status"
```

---

### Task 14: `GET /api/admin/audit`

**Files:**
- Create: `functions/api/admin/audit.js`
- Test: `functions/api/admin/__tests__/audit.test.js`

**Interfaces:**
- Consumes: `requireAdmin`.
- Produces: `{ entries: [{ id, adminUserId, action, targetType, targetId, metadata, createdAt }] }`, newest first, optional `?action=`/`?targetType=` filters.

- [x] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
let auditQuery;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "admin_audit_log") return auditQuery();
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../audit.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/audit", { headers: { Authorization: "Bearer good" } });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  auditQuery = () => ({
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({
      data: [{ id: 1, admin_user_id: "admin-1", action: "admin.disable_user", target_type: "vpn_account", target_id: "1", metadata: {}, created_at: "t1" }],
      error: null,
    }),
  });
});

describe("GET /api/admin/audit", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
  });

  it("returns audit entries in camelCase", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.entries[0]).toEqual({
      id: 1,
      adminUserId: "admin-1",
      action: "admin.disable_user",
      targetType: "vpn_account",
      targetId: "1",
      metadata: {},
      createdAt: "t1",
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [x] **Step 3: Write the implementation**

```js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const { data, error } = await supabaseAdmin
      .from("admin_audit_log")
      .select("id, admin_user_id, action, target_type, target_id, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`admin_audit_log query failed: ${error.message}`);

    const entries = data.map((e) => ({
      id: e.id,
      adminUserId: e.admin_user_id,
      action: e.action,
      targetType: e.target_type,
      targetId: e.target_id,
      metadata: e.metadata,
      createdAt: e.created_at,
    }));

    return jsonResponse({ entries });
  } catch (err) {
    console.error("admin/audit: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add functions/api/admin/audit.js functions/api/admin/__tests__/audit.test.js
git commit -m "feat(admin): add GET /api/admin/audit"
```

---

### Task 15: Shared admin frontend scaffolding

**Files:**
- Create: `src/hooks/useAdminSession.ts`
- Create: `src/components/admin/AdminShell.tsx`
- Create: `src/components/admin/AdminNav.tsx`
- Create: `src/components/admin/StatusBadge.tsx`
- Create: `src/components/admin/MetricCard.tsx`
- Create: `src/components/admin/ConfirmButton.tsx`

**Interfaces:**
- Produces: `useAdminSession(): { session: Session | null, isAdmin: boolean | null, loading: boolean }` (`isAdmin === null` while loading, then `true`/`false`); `<AdminShell>` wraps every `/admin/*` page and redirects to `/login` if `!session` or renders a "not authorized" message if `session && isAdmin === false`. Tasks 16-19's pages all import `AdminShell`.

- [x] **Step 1: `src/hooks/useAdminSession.ts`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/hooks/useSession";

/**
 * Extends useSession with an admin-role check. There is no dedicated
 * "am I admin" endpoint — GET /api/admin/overview doubles as the check,
 * since every admin page needs its data anyway and a 401 there means
 * "not an admin" just as reliably as a separate endpoint would.
 */
export function useAdminSession() {
  const { session, loading: sessionLoading } = useSession();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (sessionLoading) return;
    if (!session) {
      setIsAdmin(false);
      return;
    }
    fetch("/api/admin/overview", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((res) => setIsAdmin(res.status === 200))
      .catch(() => setIsAdmin(false));
  }, [session, sessionLoading]);

  return { session, isAdmin, loading: sessionLoading || isAdmin === null };
}
```

- [x] **Step 2: `src/components/admin/AdminShell.tsx`**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAdminSession } from "@/hooks/useAdminSession";
import { AdminNav } from "./AdminNav";

export function AdminShell({ children }: { children: React.ReactNode }) {
  const { session, isAdmin, loading } = useAdminSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !session) router.replace("/login");
  }, [loading, session, router]);

  if (loading) return <div className="p-8">Loading…</div>;
  if (!session) return null;
  if (isAdmin === false) {
    return <div className="p-8 text-red-600">You do not have admin access.</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <AdminNav />
      <main className="mx-auto max-w-6xl p-6">{children}</main>
    </div>
  );
}
```

- [x] **Step 3: `src/components/admin/AdminNav.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/jobs", label: "Jobs" },
  { href: "/admin/nodes", label: "Nodes" },
  { href: "/admin/audit", label: "Audit" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="border-b bg-white px-6 py-3">
      <div className="mx-auto flex max-w-6xl gap-6">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={pathname === link.href ? "font-semibold text-black" : "text-gray-500"}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
```

- [x] **Step 4: `src/components/admin/StatusBadge.tsx`**

```tsx
const COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  online: "bg-green-100 text-green-800",
  done: "bg-green-100 text-green-800",
  past_due: "bg-yellow-100 text-yellow-800",
  degraded: "bg-yellow-100 text-yellow-800",
  pending: "bg-yellow-100 text-yellow-800",
  claimed: "bg-blue-100 text-blue-800",
  canceled: "bg-gray-100 text-gray-600",
  offline: "bg-red-100 text-red-800",
  failed: "bg-red-100 text-red-800",
  revoked: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: string }) {
  const color = COLORS[status] ?? "bg-gray-100 text-gray-600";
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>{status}</span>;
}
```

- [x] **Step 5: `src/components/admin/MetricCard.tsx`**

```tsx
export function MetricCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border bg-white p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-gray-500">{label}</div>
    </div>
  );
}
```

- [x] **Step 6: `src/components/admin/ConfirmButton.tsx`**

```tsx
"use client";

import { useState } from "react";

/**
 * A button that requires a second click within 4s to actually fire
 * onConfirm — the minimum-friction confirm pattern for disable/enable/
 * rotate/retry, which are all real mutations against real customer VPN
 * access. Not a modal, to keep this component tiny; upgrade to a real
 * dialog if a future admin reports a misclick.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <button
      className={className}
      onClick={() => {
        if (confirming) {
          setConfirming(false);
          onConfirm();
        } else {
          setConfirming(true);
          setTimeout(() => setConfirming(false), 4000);
        }
      }}
    >
      {confirming ? confirmLabel : label}
    </button>
  );
}
```

- [x] **Step 7: Manual verification**

There is no automated test for this task (pure presentational scaffolding, no logic beyond what Task 16-19's pages exercise end to end). Run `npm run dev`, sign in as an account with no `admin_users` row, and confirm `/admin` shows "You do not have admin access." — this is the one behavior worth checking by hand before later tasks build on it.

- [x] **Step 8: Commit**

```bash
git add src/hooks/useAdminSession.ts src/components/admin/
git commit -m "feat(admin): add admin shell, nav, and shared UI components"
```

---

### Task 16: `/admin` overview page

**Files:**
- Create: `src/app/admin/page.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/overview` (Task 7), `AdminShell`, `MetricCard`.

- [x] **Step 1: Write the page**

```tsx
"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { MetricCard } from "@/components/admin/MetricCard";
import { useAdminSession } from "@/hooks/useAdminSession";

type Overview = {
  customers: { total: number; active: number; past_due: number; canceled: number };
  vpn: { accounts: number };
  jobs: { pending: number; claimed: number; failed: number };
  nodes: { online: number; offline: number };
};

export default function AdminOverviewPage() {
  const { session } = useAdminSession();
  const [overview, setOverview] = useState<Overview | null>(null);

  useEffect(() => {
    if (!session) return;
    fetch("/api/admin/overview", { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((res) => res.json())
      .then(setOverview);
  }, [session]);

  return (
    <AdminShell>
      <h1 className="mb-6 text-xl font-semibold">Overview</h1>
      {!overview ? (
        <p>Loading…</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <MetricCard label="Active customers" value={overview.customers.active} />
          <MetricCard label="Past due" value={overview.customers.past_due} />
          <MetricCard label="Canceled" value={overview.customers.canceled} />
          <MetricCard label="VPN accounts" value={overview.vpn.accounts} />
          <MetricCard label="Nodes online" value={overview.nodes.online} />
          <MetricCard label="Nodes offline" value={overview.nodes.offline} />
          <MetricCard label="Jobs pending" value={overview.jobs.pending} />
          <MetricCard label="Jobs failed" value={overview.jobs.failed} />
        </div>
      )}
    </AdminShell>
  );
}
```

- [x] **Step 2: Manual verification**

Run `npm run dev`, sign in as an `owner` admin, open `/admin`. Expected: eight metric cards render with real numbers matching what a direct `select count(*)` against the local dev database shows for each.

- [x] **Step 3: Commit**

```bash
git add src/app/admin/page.tsx
git commit -m "feat(admin): add /admin overview page"
```

---

### Task 17: `/admin/customers` list and detail pages

**Files:**
- Create: `src/app/admin/customers/page.tsx`
- Create: `src/app/admin/customers/[id]/page.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/customers` (Task 8), `GET /api/admin/customers/:id` (Task 9), `POST .../disable`, `.../enable`, `.../rotate` (Tasks 10-11), `StatusBadge`, `ConfirmButton`.

- [x] **Step 1: Write the list page**

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";

type Customer = {
  userId: string;
  email: string | null;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  vpnAccountId: number | null;
  nodeId: string | null;
  enabled: boolean | null;
};

export default function AdminCustomersPage() {
  const { session } = useAdminSession();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!session) return;
    const url = q ? `/api/admin/customers?q=${encodeURIComponent(q)}` : "/api/admin/customers";
    fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((res) => res.json())
      .then((body) => setCustomers(body.customers));
  }, [session, q]);

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Customers</h1>
      <input
        className="mb-4 w-full max-w-sm rounded border px-3 py-2"
        placeholder="Search by email, user id, or VPN user id"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {!customers ? (
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">Customer</th>
              <th>Subscription</th>
              <th>VPN</th>
              <th>Node</th>
              <th>Period ends</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.userId} className="border-b">
                <td className="py-2">
                  <Link href={`/admin/customers/${c.userId}`} className="text-blue-600 hover:underline">
                    {c.email ?? c.userId}
                  </Link>
                </td>
                <td><StatusBadge status={c.subscriptionStatus} /></td>
                <td>{c.vpnAccountId ? <StatusBadge status={c.enabled ? "active" : "canceled"} /> : "—"}</td>
                <td>{c.nodeId ?? "—"}</td>
                <td>{c.currentPeriodEnd ? new Date(c.currentPeriodEnd).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
```

- [x] **Step 2: Write the detail page**

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { useAdminSession } from "@/hooks/useAdminSession";

type CustomerDetail = {
  userId: string;
  email: string | null;
  subscription: { status: string; currentPeriodEnd: string | null; stripeCustomerId: string | null } | null;
  vpnAccount: { id: number; vpnUserId: string; nodeId: string; enabled: boolean } | null;
  jobs: { id: number; jobType: string; status: string; createdAt: string }[];
};

export default function AdminCustomerDetailPage() {
  const { session } = useAdminSession();
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!session) return;
    fetch(`/api/admin/customers/${params.id}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((res) => res.json())
      .then(setDetail);
  }, [session, params.id]);

  useEffect(load, [load]);

  async function callAction(path: string, label: string) {
    if (!session) return;
    const res = await fetch(`/api/admin/customers/${params.id}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    setActionMessage(res.ok ? `${label} job created.` : "Action failed.");
    load();
  }

  if (!detail) {
    return (
      <AdminShell>
        <p>Loading…</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">{detail.email ?? detail.userId}</h1>
      {actionMessage && <p className="mb-4 text-sm text-gray-600">{actionMessage}</p>}

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Billing</h2>
        {detail.subscription ? (
          <>
            <p>Status: <StatusBadge status={detail.subscription.status} /></p>
            <p>Period ends: {detail.subscription.currentPeriodEnd ? new Date(detail.subscription.currentPeriodEnd).toLocaleDateString() : "—"}</p>
          </>
        ) : (
          <p>No subscription.</p>
        )}
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">VPN</h2>
        {detail.vpnAccount ? (
          <>
            <p>Node: {detail.vpnAccount.nodeId}</p>
            <p>Status: <StatusBadge status={detail.vpnAccount.enabled ? "active" : "canceled"} /></p>
            <div className="mt-3 flex gap-2">
              <ConfirmButton
                label="Disable"
                confirmLabel="Click again to confirm disable"
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white"
                onConfirm={() => callAction("disable", "Disable")}
              />
              <ConfirmButton
                label="Enable"
                confirmLabel="Click again to confirm enable"
                className="rounded bg-green-600 px-3 py-1.5 text-sm text-white"
                onConfirm={() => callAction("enable", "Enable")}
              />
              <ConfirmButton
                label="Rotate config"
                confirmLabel="Click again to confirm rotate"
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white"
                onConfirm={() => callAction("rotate", "Rotate")}
              />
            </div>
          </>
        ) : (
          <p>No VPN account provisioned yet.</p>
        )}
      </section>

      <section className="rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Provisioning history</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-1">Job</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {detail.jobs.map((j) => (
              <tr key={j.id} className="border-b">
                <td className="py-1">#{j.id} {j.jobType}</td>
                <td><StatusBadge status={j.status} /></td>
                <td>{new Date(j.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AdminShell>
  );
}
```

- [x] **Step 3: Manual verification**

Run `npm run dev`. From `/admin/customers`, search for a known local test customer, open their detail page, click Disable (confirm), verify a new `provisioning_jobs` row with `job_type = 'DISABLE_USER'` appears (check via `npx supabase db` psql or the `/admin/jobs` page once Task 19 lands), and that `admin_audit_log` gained one row.

- [x] **Step 4: Commit**

```bash
git add src/app/admin/customers/
git commit -m "feat(admin): add /admin/customers list and detail pages"
```

---

### Task 18: `/admin/jobs` page

**Files:**
- Create: `src/app/admin/jobs/page.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/jobs` (Task 12), `POST /api/admin/jobs/:id/retry` (Task 12), `StatusBadge`, `ConfirmButton`.

- [x] **Step 1: Write the page**

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { useAdminSession } from "@/hooks/useAdminSession";

type Job = {
  id: number;
  jobType: string;
  status: string;
  nodeId: string;
  createdAt: string;
  completedAt: string | null;
};

export default function AdminJobsPage() {
  const { session } = useAdminSession();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(() => {
    if (!session) return;
    const url = statusFilter ? `/api/admin/jobs?status=${statusFilter}` : "/api/admin/jobs";
    fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((res) => res.json())
      .then((body) => setJobs(body.jobs));
  }, [session, statusFilter]);

  useEffect(load, [load]);

  async function retry(jobId: number) {
    if (!session) return;
    await fetch(`/api/admin/jobs/${jobId}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    load();
  }

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Jobs</h1>
      <select className="mb-4 rounded border px-3 py-2" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
        <option value="">All statuses</option>
        <option value="pending">Pending</option>
        <option value="claimed">Claimed</option>
        <option value="done">Done</option>
        <option value="failed">Failed</option>
      </select>
      {!jobs ? (
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">ID</th>
              <th>Type</th>
              <th>Node</th>
              <th>Status</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-b">
                <td className="py-2">#{j.id}</td>
                <td>{j.jobType}</td>
                <td>{j.nodeId}</td>
                <td><StatusBadge status={j.status} /></td>
                <td>{new Date(j.createdAt).toLocaleString()}</td>
                <td>
                  {j.status === "failed" && (
                    <ConfirmButton
                      label="Retry"
                      confirmLabel="Confirm retry"
                      className="rounded bg-blue-600 px-2 py-1 text-xs text-white"
                      onConfirm={() => retry(j.id)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
```

- [x] **Step 2: Manual verification**

Run `npm run dev`. Filter to `failed`, click Retry on a failed job, confirm a new job with a higher id appears and the audit log records `admin.retry_job` with `metadata.original_job_id` set.

- [x] **Step 3: Commit**

```bash
git add src/app/admin/jobs/
git commit -m "feat(admin): add /admin/jobs page with retry"
```

---

### Task 19: `/admin/nodes` and `/admin/audit` pages

**Files:**
- Create: `src/app/admin/nodes/page.tsx`
- Create: `src/app/admin/audit/page.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/nodes` (Task 13), `GET /api/admin/audit` (Task 14), `StatusBadge`.

- [x] **Step 1: Write `/admin/nodes/page.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";

type Node = { nodeId: string; status: string; lastSeenAt: string | null };

export default function AdminNodesPage() {
  const { session } = useAdminSession();
  const [nodes, setNodes] = useState<Node[] | null>(null);

  useEffect(() => {
    if (!session) return;
    fetch("/api/admin/nodes", { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((res) => res.json())
      .then((body) => setNodes(body.nodes));
  }, [session]);

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Nodes</h1>
      {!nodes ? (
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">Node</th>
              <th>Status</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.nodeId} className="border-b">
                <td className="py-2">{n.nodeId}</td>
                <td><StatusBadge status={n.status} /></td>
                <td>{n.lastSeenAt ? new Date(n.lastSeenAt).toLocaleString() : "never"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
```

- [x] **Step 2: Write `/admin/audit/page.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { useAdminSession } from "@/hooks/useAdminSession";

type AuditEntry = {
  id: number;
  adminUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
};

export default function AdminAuditPage() {
  const { session } = useAdminSession();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    if (!session) return;
    fetch("/api/admin/audit", { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((res) => res.json())
      .then((body) => setEntries(body.entries));
  }, [session]);

  return (
    <AdminShell>
      <h1 className="mb-4 text-xl font-semibold">Audit log</h1>
      {!entries ? (
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">When</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b">
                <td className="py-2">{new Date(e.createdAt).toLocaleString()}</td>
                <td>{e.adminUserId}</td>
                <td>{e.action}</td>
                <td>{e.targetType} {e.targetId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
```

- [x] **Step 3: Manual verification**

Run `npm run dev`, open `/admin/nodes` and confirm the local dev node shows `online` (assuming the local provisioning agent or a manual `curl` to `/api/agent/claim` has run recently); open `/admin/audit` and confirm every mutation performed during this plan's manual verification steps appears, newest first.

- [x] **Step 4: Commit**

```bash
git add src/app/admin/nodes/ src/app/admin/audit/
git commit -m "feat(admin): add /admin/nodes and /admin/audit pages"
```

---

## Self-Review Notes

- **Spec coverage:** every phase from the proposal this plan is based on that was judged worth including in v1 has a task: admin auth (Task 2), audit log (Task 3), node heartbeat (Task 5), the six read APIs (Tasks 7-9, 12-14), the three mutations (Tasks 10-11), safe retry (Task 12), the resolveNodeForUser refactor (Task 4), and every corresponding frontend page (Tasks 15-19).
- **Placeholder scan:** the one intentionally-incomplete test scaffold is Task 7 Step 1's `countQueries` comment, which Step 3-4 explicitly requires the implementer to complete before the test can pass — not a silently-skipped requirement.
- **Type/interface consistency:** `requireAdmin`'s `{ admin, response }` shape (Task 2) is used identically in every one of Tasks 7-14's routes. `sanitizeJobResult` (Task 3) is applied in both Task 9 (customer detail) and Task 12 (jobs list) — the two places `provisioning_jobs.result` ever reaches an admin response. Field naming is consistently camelCase in every JSON response and every frontend `type`/`interface` that consumes it.
- **Deviate from standard TDD template:** Tasks 6 (bootstrap script) and 15-19 (frontend) have manual verification instead of automated tests — flagged explicitly in each task rather than silently skipped. Task 6 is a one-time operator script with no reachable code path from the application; Tasks 15-19 are presentational and are exercised end-to-end by the manual verification steps in Tasks 16-19, which is judged sufficient for a v1 internal tool with a single admin user. If this dashboard gains a second admin or moves to a wider audience, add component/E2E tests before then (see Open Items below).

## Open Items / Deferred (not part of this plan)

Called out explicitly, per this project's evidence/scope discipline — not silently dropped:

1. **MFA for admin accounts.** Required before granting `admin_users` access to anyone beyond the current single owner. Its own plan (TOTP enrollment, recovery codes, `admin-auth.js` gaining an MFA-verified check) — do not add a second `admin_users` row without it.
2. **`parent_job_id` retry lineage.** Task 12's retry creates a new job and records `original_job_id` only in `admin_audit_log.metadata`. A `provisioning_jobs.parent_job_id` column (making retry chains queryable directly) is worth adding once a real incident needs it, not speculatively now.
3. **Richer node heartbeat** (`agent_version`, `vpn_version`, `singbox_version`, `uptime_seconds`, `user_count` via a dedicated `POST /api/agent/heartbeat`). Only useful once there is a second node or a real version-skew incident to debug — `last_seen_at` alone (Task 5) is enough to answer "is the node alive" today.
4. **Multi-node assignment logic** inside `resolveNodeForUser()` (Task 4). The function exists and is the only call site to change, but its body stays `return "node-1"` until a second node is actually provisioned.
5. **A subscription-URL "reveal" flow.** None of this plan's three mutations (disable/enable/rotate) need to ever display a plaintext subscription URL to an admin. If a future support workflow needs it, it must ship as its own reviewed feature: explicit click → re-authentication → its own `admin_audit_log` action → a short-lived, single-use reveal — never a plain field in an existing response.
6. **Automated tests for Tasks 15-19's frontend.** Deferred per the Self-Review note above; revisit if this dashboard gains a second admin.
