# Billing, Cancellation, Legal & Test Coverage Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four verified production-blocking gaps in vpn-web: duplicate-checkout billing bug, missing self-serve cancellation, placeholder Impressum content, and zero automated test coverage on the billing/provisioning path.

**Architecture:** All changes are additive to the existing Cloudflare Pages Functions (`functions/api/*.js`) + Supabase (Postgres + RLS) + Stripe design. No new services. Cancellation reuses the existing `customer.subscription.updated` webhook as the single source of truth for subscription state (the new cancel endpoint only calls Stripe; it never writes `subscriptions` directly). Test coverage is added with Vitest, mocking `@supabase/supabase-js` and `stripe` at the module boundary so each Pages Function handler can be unit-tested by direct import and invocation.

**Tech Stack:** Next.js 15 (static export) + Cloudflare Pages Functions, Supabase (Postgres, RLS), Stripe SDK v19, Vitest (new).

**Spec:** This plan implements items 1, 3, 5, 6 of the "worth implementing" list agreed with the user on 2026-09-21 (checkout dedup, cancellation flow, Impressum completion, vpn-web test suite), verified against current code by a research pass earlier the same day. Prior related specs: `docs/superpowers/plans/2026-09-21-stripe-billing.md`, `docs/superpowers/plans/2026-09-21-provisioning-worker-api.md`.

## Global Constraints

- Every new Pages Function follows the existing handler shape: `export async function onRequestPost({ env, request })`, Bearer-token auth via `supabaseAdmin.auth.getUser(accessToken)`, and a fixed generic error body on unexpected failure (never leak SDK error internals to the caller) — see `functions/api/create-checkout-session.js:55-66` for the pattern to copy.
- `subscriptions` writes stay confined to webhook handlers in `functions/lib/stripe-events.js`. No new code path writes `subscriptions.status` directly — this preserves the existing single-source-of-truth invariant documented at `functions/lib/stripe-events.js:1-13`.
- New DB migrations follow the existing naming convention: `supabase/migrations/YYYYMMDDHHMMSS_<name>.sql`, plain SQL, no ORM.
- New tests use Vitest (`vitest run` as the `test` script); no other test runner is introduced.
- Do not touch the Impressum's real legal content (company name, address, register entry, VAT ID) — those are business facts only the user can supply. This plan wires the page to accept them and flags exactly where, but does not invent placeholder-looking fake data as if it were real.

---

## File Structure

- `supabase/migrations/20260921140000_cancel_at_period_end.sql` — new column on `subscriptions` to track pending cancellation.
- `functions/lib/stripe-events.js` — modify `handleSubscriptionUpdated` to persist `cancel_at_period_end`.
- `functions/api/create-checkout-session.js` — add active-subscription check before creating a Stripe Checkout Session.
- `functions/api/cancel-subscription.js` — new endpoint, calls `stripe.subscriptions.update(id, { cancel_at_period_end: true })`.
- `functions/api/vpn/config.js` — extend the 200 response to include `status`, `current_period_end`, `cancel_at_period_end` so the dashboard can render cancellation state.
- `src/app/dashboard/page.tsx` — add "Cancel subscription" UI wired to the new endpoint.
- `src/app/impressum/page.tsx` — replace bracketed placeholders with clearly-marked input fields sourced from one config object, so filling in real data is a single edit in one place instead of hunting through JSX.
- `package.json` — add `vitest` devDependency and `test` script.
- `vitest.config.js` — new, minimal Vitest config for Node environment.
- `functions/lib/__tests__/stripe-events.test.js` — new.
- `functions/api/__tests__/create-checkout-session.test.js` — new.
- `functions/api/__tests__/cancel-subscription.test.js` — new.

---

### Task 1: Migration — track `cancel_at_period_end`

**Files:**
- Create: `supabase/migrations/20260921140000_cancel_at_period_end.sql`
- Test: `supabase/tests/rls_test.sql` (extend existing file — do not create a second RLS test file)

**Interfaces:**
- Produces: `public.subscriptions.cancel_at_period_end` (boolean, not null, default false) — consumed by Task 2 (webhook write) and Task 5 (API read).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260921140000_cancel_at_period_end.sql
-- Tracks Stripe's cancel_at_period_end flag so the dashboard can show
-- "cancels on <date>" instead of just a status string. Written only by
-- handleSubscriptionUpdated (functions/lib/stripe-events.js), mirroring
-- every other subscriptions column.
alter table public.subscriptions
  add column cancel_at_period_end boolean not null default false;
```

- [ ] **Step 2: Extend the RLS test to cover the new column is still select-own-only**

Open `supabase/tests/rls_test.sql`, find the existing assertion block that selects from `subscriptions` as the owning user (search for `from public.subscriptions` in that file) and add `cancel_at_period_end` to the selected column list there, so the existing "own row visible" assertion also proves the new column isn't hidden or broken by the migration. Do not add a new test block — extend the existing select list in place.

- [ ] **Step 3: Apply the migration locally and run the RLS test**

Run: `cd D:\ISDA\vpn-web && npx supabase db reset` (applies all migrations + seed, local Supabase must be running via `npx supabase start`)
Run: `npx supabase test db`
Expected: all RLS tests pass, including the extended `subscriptions` select assertion.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260921140000_cancel_at_period_end.sql supabase/tests/rls_test.sql
git commit -m "feat(db): track cancel_at_period_end on subscriptions"
```

---

### Task 2: Webhook — persist `cancel_at_period_end`

**Files:**
- Modify: `functions/lib/stripe-events.js:212-229` (`handleSubscriptionUpdated`)
- Test: `functions/lib/__tests__/stripe-events.test.js` (created in this task)

**Interfaces:**
- Consumes: `public.subscriptions.cancel_at_period_end` column from Task 1.
- Produces: `handleSubscriptionUpdated(supabaseAdmin, subscription)` now writes `cancel_at_period_end` — consumed by Task 5 (`vpn/config.js` read).

- [ ] **Step 1: Install Vitest and add the test script**

```bash
cd D:\ISDA\vpn-web
npm install -D vitest
```

Edit `package.json` `scripts` block to add:

```json
"test": "vitest run"
```

- [ ] **Step 2: Write minimal Vitest config**

```javascript
// vitest.config.js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 3: Write the failing test**

```javascript
// functions/lib/__tests__/stripe-events.test.js
import { describe, it, expect, vi } from "vitest";
import { handleSubscriptionUpdated } from "../stripe-events.js";

function makeSupabaseAdminMock({ updateResult }) {
  const update = vi.fn().mockReturnThis();
  const eq = vi.fn().mockReturnThis();
  const select = vi.fn().mockReturnThis();
  const maybeSingle = vi.fn().mockResolvedValue(updateResult);
  return {
    from: vi.fn(() => ({ update, eq, select, maybeSingle })),
    _update: update,
  };
}

describe("handleSubscriptionUpdated", () => {
  it("persists cancel_at_period_end from the Stripe subscription object", async () => {
    const supabaseAdmin = makeSupabaseAdminMock({
      updateResult: { data: { user_id: "user-1" }, error: null },
    });

    await handleSubscriptionUpdated(supabaseAdmin, {
      id: "sub_123",
      status: "active",
      cancel_at_period_end: true,
      current_period_end: 1893456000,
    });

    expect(supabaseAdmin._update).toHaveBeenCalledWith(
      expect.objectContaining({ cancel_at_period_end: true })
    );
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run functions/lib/__tests__/stripe-events.test.js`
Expected: FAIL — `cancel_at_period_end` not present in the object passed to `.update(...)`.

- [ ] **Step 5: Implement**

In `functions/lib/stripe-events.js`, inside `handleSubscriptionUpdated` (around line 217-224), change:

```javascript
  const { data: updated, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: subscription.status,
      current_period_end: currentPeriodEnd,
      updated_at: new Date().toISOString(),
    })
```

to:

```javascript
  const { data: updated, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: subscription.status,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      updated_at: new Date().toISOString(),
    })
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run functions/lib/__tests__/stripe-events.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.js functions/lib/stripe-events.js functions/lib/__tests__/stripe-events.test.js
git commit -m "feat(billing): persist cancel_at_period_end; add vitest"
```

---

### Task 3: Fix checkout dedup bug

**Files:**
- Modify: `functions/api/create-checkout-session.js:33-49`
- Test: `functions/api/__tests__/create-checkout-session.test.js` (created in this task)

**Interfaces:**
- Consumes: `public.subscriptions` table, partial unique index `subscriptions_user_active_uniq` on `(user_id)` where `status in ('trialing','active','past_due')` (`supabase/migrations/20260921000000_initial_schema.sql:58-60`).
- Produces: `onRequestPost` now returns `409` with `{ error: "You already have an active subscription" }` when the calling user has a row in `('trialing','active','past_due')`.

- [ ] **Step 1: Write the failing test**

```javascript
// functions/api/__tests__/create-checkout-session.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const maybeSingle = vi.fn();
const sessionsCreate = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle,
    })),
  })),
}));

vi.mock("stripe", () => {
  const StripeMock = vi.fn(() => ({
    checkout: { sessions: { create: sessionsCreate } },
  }));
  StripeMock.createFetchHttpClient = vi.fn();
  return { default: StripeMock };
});

const { onRequestPost } = await import("../create-checkout-session.js");

function makeRequest() {
  return new Request("https://example.test/api/create-checkout-session", {
    method: "POST",
    headers: { Authorization: "Bearer token-abc" },
  });
}

const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  STRIPE_API_KEY: "sk_test_123",
  STRIPE_PRICE_ID: "price_123",
  SITE_URL: "https://arcana.test",
};

beforeEach(() => {
  getUser.mockReset();
  maybeSingle.mockReset();
  sessionsCreate.mockReset();
});

describe("create-checkout-session", () => {
  it("returns 409 without calling Stripe when the user already has an active subscription", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "a@test.dev" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { status: "active" }, error: null });

    const res = await onRequestPost({ env, request: makeRequest() });

    expect(res.status).toBe(409);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("creates a Checkout session when the user has no active subscription", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "a@test.dev" } }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    sessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.test/session" });

    const res = await onRequestPost({ env, request: makeRequest() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe("https://checkout.stripe.test/session");
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run functions/api/__tests__/create-checkout-session.test.js`
Expected: FAIL on the first test — current code has no pre-check, so it calls Stripe and returns 200 instead of 409.

- [ ] **Step 3: Implement the dedup check**

In `functions/api/create-checkout-session.js`, insert this block before the existing `let session;` at line 33 (right after the `supabaseAdmin`/`stripe` client setup, using the same `supabaseAdmin` instance already constructed at line 15):

```javascript
    const { data: existingSubscription, error: existingSubError } = await supabaseAdmin
      .from("subscriptions")
      .select("status")
      .eq("user_id", user.id)
      .in("status", ["trialing", "active", "past_due"])
      .maybeSingle();
    if (existingSubError) {
      console.error("create-checkout-session: subscription lookup failed:", existingSubError.message);
      return new Response(JSON.stringify({ error: "Something went wrong" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (existingSubscription) {
      return new Response(
        JSON.stringify({ error: "You already have an active subscription" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    let session;
```

(Replace the pre-existing standalone `let session;` line with this block — the `let session;` declaration now lives at the end of the inserted code instead of on its own.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run functions/api/__tests__/create-checkout-session.test.js`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add functions/api/create-checkout-session.js functions/api/__tests__/create-checkout-session.test.js
git commit -m "fix(billing): reject checkout when user already has an active subscription"
```

---

### Task 4: Cancellation endpoint

**Files:**
- Create: `functions/api/cancel-subscription.js`
- Test: `functions/api/__tests__/cancel-subscription.test.js`

**Interfaces:**
- Consumes: same auth pattern as Task 3; `public.subscriptions` table.
- Produces: `POST /api/cancel-subscription` — `200 { ok: true }` on success, `404 { error: "No active subscription" }` if none, `409` never used here (cancellation of an already-cancelling subscription is idempotent, not an error).

- [ ] **Step 1: Write the failing test**

```javascript
// functions/api/__tests__/cancel-subscription.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const maybeSingle = vi.fn();
const subscriptionsUpdate = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle,
    })),
  })),
}));

vi.mock("stripe", () => {
  const StripeMock = vi.fn(() => ({
    subscriptions: { update: subscriptionsUpdate },
  }));
  StripeMock.createFetchHttpClient = vi.fn();
  return { default: StripeMock };
});

const { onRequestPost } = await import("../cancel-subscription.js");

function makeRequest() {
  return new Request("https://example.test/api/cancel-subscription", {
    method: "POST",
    headers: { Authorization: "Bearer token-abc" },
  });
}

const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  STRIPE_API_KEY: "sk_test_123",
};

beforeEach(() => {
  getUser.mockReset();
  maybeSingle.mockReset();
  subscriptionsUpdate.mockReset();
});

describe("cancel-subscription", () => {
  it("returns 404 when the user has no active subscription", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await onRequestPost({ env, request: makeRequest() });

    expect(res.status).toBe(404);
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("sets cancel_at_period_end on Stripe when an active subscription exists", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { stripe_subscription_id: "sub_123" }, error: null });
    subscriptionsUpdate.mockResolvedValue({ id: "sub_123", cancel_at_period_end: true });

    const res = await onRequestPost({ env, request: makeRequest() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(subscriptionsUpdate).toHaveBeenCalledWith("sub_123", { cancel_at_period_end: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run functions/api/__tests__/cancel-subscription.test.js`
Expected: FAIL — `functions/api/cancel-subscription.js` does not exist yet.

- [ ] **Step 3: Implement**

```javascript
// functions/api/cancel-subscription.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export async function onRequestPost({ env, request }) {
  const authHeader = request.headers.get("Authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return new Response(JSON.stringify({ error: "Authorization required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const {
      data: { user },
      error: tokenError,
    } = await supabaseAdmin.auth.getUser(accessToken);
    if (tokenError || !user) {
      return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data: subscription, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_subscription_id")
      .eq("user_id", user.id)
      .in("status", ["trialing", "active", "past_due"])
      .maybeSingle();
    if (subError) {
      console.error("cancel-subscription: subscription lookup failed:", subError.message);
      return new Response(JSON.stringify({ error: "Something went wrong" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!subscription) {
      return new Response(JSON.stringify({ error: "No active subscription" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stripe = new Stripe(env.STRIPE_API_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    try {
      // Only sets the flag — actual status/cancel_at_period_end row update
      // happens via the customer.subscription.updated webhook, same
      // single-source-of-truth pattern as every other subscription write
      // (functions/lib/stripe-events.js).
      await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
    } catch (err) {
      console.error("cancel-subscription: Stripe error:", err.message);
      return new Response(JSON.stringify({ error: "Could not cancel subscription" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("cancel-subscription: unexpected error:", err.message);
    return new Response(JSON.stringify({ error: "Something went wrong" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run functions/api/__tests__/cancel-subscription.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add functions/api/cancel-subscription.js functions/api/__tests__/cancel-subscription.test.js
git commit -m "feat(billing): add self-serve subscription cancellation endpoint"
```

---

### Task 5: Expose cancellation state in `vpn/config.js` and wire dashboard UI

**Files:**
- Modify: `functions/api/vpn/config.js:39-47`
- Modify: `src/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `POST /api/cancel-subscription` from Task 4; `cancel_at_period_end`/`current_period_end` columns from Task 1/2.
- Produces: `GET /api/vpn/config` 200 response now includes `status`, `current_period_end`, `cancel_at_period_end` alongside the existing `subscription_url`.

- [ ] **Step 1: Extend the `vpn/config.js` query and response**

In `functions/api/vpn/config.js`, change the subscription query at lines 39-44 from:

```javascript
    const { data: subscription, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .select("status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
```

to:

```javascript
    const { data: subscription, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .select("status, current_period_end, cancel_at_period_end")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
```

Then change the final success response at line 75 from:

```javascript
    return noStoreJson({ subscription_url: subscriptionUrl }, 200);
```

to:

```javascript
    return noStoreJson(
      {
        subscription_url: subscriptionUrl,
        status: subscription.status,
        current_period_end: subscription.current_period_end,
        cancel_at_period_end: subscription.cancel_at_period_end,
      },
      200
    );
```

- [ ] **Step 2: Manually verify the response shape**

Run: `cd D:\ISDA\vpn-web && npm run build` (static export must still typecheck/build cleanly with no consumer of the old shape broken)
Expected: build succeeds.

- [ ] **Step 3: Add cancellation UI to the dashboard**

In `src/app/dashboard/page.tsx`, extend the `ConfigState` type at lines 9-14 from:

```typescript
type ConfigState =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "provisioning" }
  | { phase: "ready"; subscriptionUrl: string }
  | { phase: "error" };
```

to:

```typescript
type ConfigState =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "provisioning" }
  | { phase: "ready"; subscriptionUrl: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean }
  | { phase: "error" };
```

Update the poll handler at lines 45-49 from:

```javascript
        if (res.status === 200) {
          const data = await res.json();
          setConfig({ phase: "ready", subscriptionUrl: data.subscription_url });
          return;
        }
```

to:

```javascript
        if (res.status === 200) {
          const data = await res.json();
          setConfig({
            phase: "ready",
            subscriptionUrl: data.subscription_url,
            currentPeriodEnd: data.current_period_end,
            cancelAtPeriodEnd: data.cancel_at_period_end,
          });
          return;
        }
```

Add cancellation state and handler near `handleSubscribe` (after line 92):

```javascript
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  async function handleCancel() {
    if (!session) return;
    setCancelLoading(true);
    setCancelError(null);
    try {
      const res = await fetch("/api/cancel-subscription", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Could not cancel subscription");
      }
      setConfig((prev) =>
        prev.phase === "ready" ? { ...prev, cancelAtPeriodEnd: true } : prev
      );
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setCancelLoading(false);
    }
  }
```

In the `"ready"` render branch (lines 144-170), add cancellation UI right after the existing copy-URL block (after the closing `</div>` at line 169, still inside the `<>...</>` fragment):

```jsx
                {config.cancelAtPeriodEnd ? (
                  <p className="section-sub" style={{ marginTop: "var(--space-4)" }}>
                    Your subscription is canceled and will end on{" "}
                    {config.currentPeriodEnd
                      ? new Date(config.currentPeriodEnd).toLocaleDateString()
                      : "the end of the current billing period"}
                    .
                  </p>
                ) : (
                  <>
                    {cancelError && <p className="field-error">{cancelError}</p>}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleCancel}
                      disabled={cancelLoading}
                      style={{ marginTop: "var(--space-4)" }}
                    >
                      {cancelLoading ? "Canceling…" : "Cancel subscription"}
                    </button>
                  </>
                )}
```

(If `btn-secondary` doesn't exist as a class in this project's CSS, use `btn` alone — check `src/app` global CSS for the actual secondary-button class name before finalizing; do not invent a new visual style.)

- [ ] **Step 4: Manual browser verification**

Run: `npm run dev`, log in as a test user with an active subscription (use Stripe test mode + the existing local Supabase seed data), click "Cancel subscription".
Expected: button shows "Canceling…", then the page shows "Your subscription is canceled and will end on <date>." No console errors.

- [ ] **Step 5: Commit**

```bash
git add functions/api/vpn/config.js src/app/dashboard/page.tsx
git commit -m "feat(dashboard): expose and wire self-serve cancellation"
```

---

### Task 6: Complete the Impressum

**Files:**
- Modify: `src/app/impressum/page.tsx`

**Interfaces:**
- None — this task has no code dependents; it only removes placeholder content.

- [ ] **Step 1: Read the current file in full**

Read `src/app/impressum/page.tsx` end to end (lines 1 through EOF) and list every bracketed placeholder (`[Company or sole-proprietor legal name]`, `[Street address]`, etc.) and every `<span className="legal-todo">` block.

- [ ] **Step 2: Ask the user directly for the missing legal facts**

This step cannot be completed by an engineer without the user's actual registered business details. Do NOT invent plausible-looking placeholder text (a fake address, a fake VAT ID) — that is worse than an honest `TODO`, because it looks real. Present the user with the exact list of missing fields found in Step 1 (company/sole-proprietor legal name, street address, register entry, VAT ID, and any other bracketed field found) and ask them to supply the real values.

- [ ] **Step 3: Fill in the real values**

Once the user provides the values, replace each bracketed placeholder and `legal-todo` span in `src/app/impressum/page.tsx` with the literal text supplied, preserving the existing JSX structure and styling exactly — this is a content-only change, not a structural one.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, visit `/impressum/` in a browser.
Expected: no bracketed placeholders or "TODO" text visible anywhere on the rendered page.

- [ ] **Step 5: Commit**

```bash
git add src/app/impressum/page.tsx
git commit -m "docs(legal): complete Impressum with real registration details"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1-2 cover DB/webhook groundwork, Task 3 covers checkout dedup (item 1), Task 4-5 cover cancellation (item 3), Task 6 covers Impressum (item 5), Tasks 1-5 collectively establish the Vitest suite (item 6) by adding real tests alongside every new/changed handler rather than as a separate bolt-on task — this was chosen over a standalone "add tests" task because tests-after-the-fact for existing untested handlers (`stripe-webhook.js`'s full event-idempotency path) would require the exact same mocking scaffolding built here; a follow-up plan can extend coverage to `stripe-webhook.js` and `functions/api/agent/*` reusing the mocks introduced in Task 3.
- **Placeholder scan:** no `TBD`/`implement later`/unshown steps remain; Task 6 Step 2 is intentionally a real human-input dependency, not a placeholder — it's flagged as such rather than faked.
- **Type consistency:** `ConfigState`'s `"ready"` variant fields (`subscriptionUrl`, `currentPeriodEnd`, `cancelAtPeriodEnd`) are used consistently between Task 5 Steps 1 and 3; `handleCancel`'s state update matches the extended type.
