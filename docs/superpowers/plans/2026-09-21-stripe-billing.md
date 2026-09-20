# Arcana Stripe billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stripe-driven billing for Arcana's one monthly plan: a webhook handler that is the sole source of truth for subscription state and enqueues provisioning work (never a client-trusted "I paid" signal), and a Checkout-session-creation endpoint the dashboard's "Subscribe" button calls.

**Architecture:** Cloudflare Pages Functions (`functions/api/*.js`), the same pattern already proven in the sibling reference project `ml-consulting-website` — plain JS, `context.env` for secrets/config, no Next.js server runtime involved (this site is `output: 'export'`). Two endpoints: `POST /api/stripe-webhook` (Stripe → us, signature-verified, `stripe_events`-deduplicated, updates `subscriptions`, enqueues `provisioning_jobs` rows) and `POST /api/create-checkout-session` (browser → us, requires a valid Supabase access token, returns a Stripe Checkout URL to redirect to). **Task 1 (the webhook handler) needs no live Stripe account to build or test** — Stripe's own signature-verification helper (`stripe.webhooks.generateTestHeaderStringAsync`) can sign synthetic event payloads locally, and Cloudflare's edge-compatible client (`Stripe.createFetchHttpClient()`/`createSubtleCryptoProvider()`) never has to make a real network call to verify a signature. **Task 2 (Checkout session creation) does need a real Stripe test-mode account** — `stripe.checkout.sessions.create()` is a real API call with no offline equivalent. Task 1 is executable now; Task 2 is written but execution pauses until real Stripe test credentials exist (tracked in Global Constraints below).

**Tech Stack:** `stripe` (Node SDK, used in its Cloudflare-Workers-compatible mode — verified against the SDK's own official Cloudflare Pages Functions example, not guessed), `@supabase/supabase-js` (service-role client, same as the reference project's functions), `wrangler` (Cloudflare's CLI, for local Functions dev via `wrangler pages dev`).

**Spec:** `docs/superpowers/specs/2026-09-20-vpn-website-mvp-design.md` in the sibling repo `singbox-vpn` (absolute path: `D:\ISDA\singbox-vpn\docs\superpowers\specs\2026-09-20-vpn-website-mvp-design.md`) — §6 (payment → provisioning flow), §5 item 4 (`stripe_events` idempotency), §9 item 2 (Stripe account prerequisite).

## Global Constraints

- **The webhook is the only writer of subscription/access state.** The Checkout-session-creation endpoint never writes to `subscriptions` or `provisioning_jobs` — it only starts a Checkout Session. This is a spec requirement (§6), not a style choice: a client-trusted "I paid" signal is exactly the vulnerability a real payment integration cannot have.
- **Idempotency is mandatory, not best-effort.** Stripe redelivers webhooks until it gets a 2xx; the handler must be safe to receive the same event twice (checked via `stripe_events.stripe_event_id`, unique-constrained) and every `provisioning_jobs` insert must use a deterministic `idempotency_key` so a retried webhook can never double-provision or double-enqueue.
- **Raw request body, not parsed JSON, is what gets signature-verified.** Stripe's HMAC covers the exact bytes sent; parsing to JSON first and re-serializing would produce a different byte string and fail verification. `request.text()`, never `request.json()`, feeds `constructEventAsync`.
- **`constructEventAsync` + `createSubtleCryptoProvider`, never the sync `constructEvent`.** Cloudflare Workers has no synchronous Node crypto; this is not a style preference, the sync path throws `CryptoProviderOnlySupportsAsyncError` at runtime under Workers. Verified against Stripe's own official Cloudflare Pages Functions example (not assumed from general Node docs).
- **`STRIPE_API_KEY`/`STRIPE_SIGNING_SECRET`/`STRIPE_PRICE_ID` are real Stripe test-mode credentials that don't exist in this session** — tracked explicitly as a blocker for Task 2 only. Task 1 needs none of them to be real (a syntactically-valid placeholder string is enough, since Task 1 never calls Stripe's network API — only its offline signing/verification helpers).
- Every Cloudflare Pages Function follows the reference project's existing shape: `export async function onRequestPost({ env, request })`, JSON responses, errors logged via `console.error` (visible in `wrangler pages dev`'s terminal output and, in production, Cloudflare's function logs) and never leaking internal detail to the caller.

---

## Task 1: Stripe webhook handler (buildable and testable now, no live Stripe account needed)

**Files:**
- Create: `wrangler.toml`
- Create: `.dev.vars.example`
- Modify: `package.json` (add `stripe` dependency, `wrangler` devDependency)
- Create: `functions/lib/stripe-events.js`
- Create: `functions/api/stripe-webhook.js`

**Interfaces:**
- Consumes: the Supabase schema from the merged schema plan (`subscriptions`, `provisioning_jobs`, `stripe_events` tables — exact column names/types already fixed there).
- Produces: `POST /api/stripe-webhook`, and the three exported handler functions in `functions/lib/stripe-events.js` (`handleCheckoutSessionCompleted`, `handleSubscriptionUpdated`, `handleSubscriptionDeleted`) — Task 2's Checkout-session-creation endpoint doesn't call these directly, but any future admin/debug tooling that needs to replay a specific event type would.

- [ ] **Step 1: Write `wrangler.toml`**

```toml
# Cloudflare Pages configuration — no Workers-only settings here.
name = "arcana-web"
pages_build_output_dir = "out"
compatibility_date = "2026-09-21"
# Both @supabase/supabase-js and stripe assume some Node built-ins
# (e.g. Buffer, process.env-shaped access patterns internally) that the
# Workers runtime only provides under this flag.
compatibility_flags = ["nodejs_compat"]

[functions]
directory = "functions"
```

- [ ] **Step 2: Write `.dev.vars.example`**

```
# Copy to .dev.vars for local `wrangler pages dev` runs (gitignored — never
# commit real values). Task 1 (the webhook handler) never makes a real
# network call to Stripe, so STRIPE_API_KEY here can be any syntactically
# plausible placeholder for local testing. STRIPE_SIGNING_SECRET, however,
# MUST match whatever secret your local test script signs synthetic events
# with (see Task 1 Step 6) — they are the same shared secret on both sides
# of a real integration, just simulated locally here.
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<paste the SERVICE_ROLE_KEY your local `npx supabase start` prints>
STRIPE_API_KEY=sk_test_placeholder_not_a_real_key
STRIPE_SIGNING_SECRET=whsec_test_local_secret_for_synthetic_events_only
STRIPE_PRICE_ID=price_placeholder_not_real
SITE_URL=http://127.0.0.1:8788
```

- [ ] **Step 3: Add dependencies to `package.json`**

Add to `"dependencies"`:
```json
    "stripe": "^19.1.0",
```
Add to `"devDependencies"`:
```json
    "wrangler": "^4.87.0",
```

Run: `npm install`. Expected: succeeds.

- [ ] **Step 4: Write `functions/lib/stripe-events.js`**

```js
// Stripe webhook event handlers. Each function is idempotent: safe to run
// twice for the same underlying Stripe object, because every write either
// upserts by a Stripe-assigned unique id or inserts a provisioning_jobs row
// under a deterministic idempotency_key that a duplicate call reproduces
// exactly (the unique constraint on provisioning_jobs.idempotency_key turns
// a duplicate insert into a harmless no-op, not an error the caller must
// avoid triggering).

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object} session - a Stripe Checkout Session object
 */
export async function handleCheckoutSessionCompleted(supabaseAdmin, session) {
  if (session.mode !== "subscription") return;

  const userId = session.client_reference_id;
  if (!userId) {
    throw new Error(
      "checkout.session.completed missing client_reference_id — every Checkout Session this app creates must set it to the Supabase user id"
    );
  }

  const { error: subError } = await supabaseAdmin.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      status: "active",
    },
    { onConflict: "stripe_subscription_id" }
  );
  if (subError) {
    throw new Error(`subscriptions upsert failed: ${subError.message}`);
  }

  // vpn_account_id is null here on purpose — no VPN identity exists yet;
  // the provisioning agent (a separate, later plan) is what creates one and
  // records the resulting vpn_accounts row. user_id travels in the payload
  // instead.
  const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
    idempotency_key: `create-user:${userId}`,
    node_id: "node-1",
    job_type: "CREATE_USER",
    payload: { user_id: userId },
  });
  if (jobError && jobError.code !== "23505") {
    throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object} subscription - a Stripe Subscription object
 */
export async function handleSubscriptionUpdated(supabaseAdmin, subscription) {
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  const { error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: subscription.status,
      current_period_end: currentPeriodEnd,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscription.id);
  if (subError) {
    throw new Error(`subscriptions update failed: ${subError.message}`);
  }

  if (subscription.status === "active" && currentPeriodEnd) {
    // The idempotency key includes the period end, so this fires once per
    // billing period, not once per event delivery — a genuinely new period
    // gets a new key and a new job; a retried/duplicate delivery for the
    // same period reproduces the same key and no-ops.
    const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: `set-expiry:${subscription.id}:${currentPeriodEnd}`,
      node_id: "node-1",
      job_type: "SET_EXPIRY",
      payload: {
        stripe_subscription_id: subscription.id,
        expires_at: currentPeriodEnd,
      },
    });
    if (jobError && jobError.code !== "23505") {
      throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
    }
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object} subscription - a Stripe Subscription object
 */
export async function handleSubscriptionDeleted(supabaseAdmin, subscription) {
  const { data: updated, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("stripe_subscription_id", subscription.id)
    .select("user_id")
    .single();
  if (subError) {
    throw new Error(`subscriptions update failed: ${subError.message}`);
  }

  const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
    idempotency_key: `disable-user:${subscription.id}`,
    node_id: "node-1",
    job_type: "DISABLE_USER",
    payload: { user_id: updated.user_id, stripe_subscription_id: subscription.id },
  });
  if (jobError && jobError.code !== "23505") {
    throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
  }
}
```

- [ ] **Step 5: Write `functions/api/stripe-webhook.js`**

```js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import {
  handleCheckoutSessionCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
} from "../lib/stripe-events.js";

export async function onRequestPost({ env, request }) {
  const sig = request.headers.get("Stripe-Signature");
  // Raw text, not request.json() — Stripe's HMAC covers the exact bytes
  // sent; re-serializing parsed JSON would produce a different byte string
  // and every signature would fail verification.
  const body = await request.text();

  const stripe = new Stripe(env.STRIPE_API_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  // constructEventAsync + createSubtleCryptoProvider, never the sync
  // constructEvent — Cloudflare Workers has no synchronous Node crypto.
  const webCrypto = Stripe.createSubtleCryptoProvider();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_SIGNING_SECRET,
      undefined,
      webCrypto
    );
  } catch (err) {
    console.error("stripe-webhook: signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Idempotency: look up this event id first. A row with processed_at set
  // means this exact event already succeeded — return 200 without
  // reprocessing. A row that exists but has processed_at = null means a
  // prior attempt was recorded but never finished (e.g. the handler threw
  // after this insert but before the update below) — fall through and
  // retry the handler rather than silently treating it as done.
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("stripe_events")
    .select("processed_at")
    .eq("stripe_event_id", event.id)
    .maybeSingle();
  if (lookupError) {
    console.error("stripe-webhook: event lookup failed:", lookupError.message);
    return new Response("Internal error", { status: 500 });
  }
  if (existing?.processed_at) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!existing) {
    const { error: insertError } = await supabaseAdmin
      .from("stripe_events")
      .insert({ stripe_event_id: event.id, event_type: event.type, payload: event });
    if (insertError) {
      console.error("stripe-webhook: failed to record event:", insertError.message);
      return new Response("Internal error", { status: 500 });
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(supabaseAdmin, event.data.object);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(supabaseAdmin, event.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(supabaseAdmin, event.data.object);
        break;
      default:
        // Unhandled event types are not an error — Stripe sends many event
        // types this integration doesn't act on yet.
        break;
    }
  } catch (err) {
    console.error(`stripe-webhook: failed to handle ${event.type}:`, err.message);
    // Leave processed_at unset so Stripe's retry (it retries until 2xx)
    // re-attempts the handler instead of this failure being silently final.
    return new Response("Internal error", { status: 500 });
  }

  const { error: markProcessedError } = await supabaseAdmin
    .from("stripe_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("stripe_event_id", event.id);
  if (markProcessedError) {
    console.error("stripe-webhook: failed to mark event processed:", markProcessedError.message);
    return new Response("Internal error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 6: Write a throwaway local verification script (not committed) that signs synthetic events and drives the real endpoint**

Requires: local Supabase running (`npx supabase start`, applies the merged schema's migration+seed) and the built site served with Functions (`npm run build && npx wrangler pages dev out --port 8788`, in a separate terminal, with `.dev.vars` copied from `.dev.vars.example` — set `SUPABASE_SERVICE_ROLE_KEY` to the real value your local `supabase start` printed, and leave `STRIPE_SIGNING_SECRET` as the placeholder value since this script signs with that same shared value).

```js
// scratch-verify-webhook.mjs (throwaway, not committed)
import Stripe from "stripe";

const SIGNING_SECRET = "whsec_test_local_secret_for_synthetic_events_only"; // must match .dev.vars
const ENDPOINT = "http://127.0.0.1:8788/api/stripe-webhook";
const USER_A = "11111111-1111-1111-1111-111111111111"; // seeded by the schema plan

const webCrypto = Stripe.createSubtleCryptoProvider();

async function post(event) {
  const payload = JSON.stringify(event);
  const header = await webCrypto.computeHMACSignatureAsync
    ? await Stripe.webhooks.generateTestHeaderStringAsync({
        payload,
        secret: SIGNING_SECRET,
        cryptoProvider: webCrypto,
      })
    : Stripe.webhooks.generateTestHeaderString({ payload, secret: SIGNING_SECRET });
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
    body: payload,
  });
  return { status: res.status, body: await res.text() };
}

function checkoutCompleted(eventId, subscriptionId) {
  return {
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        client_reference_id: USER_A,
        customer: "cus_synthetic_test",
        subscription: subscriptionId,
      },
    },
  };
}

function subscriptionUpdated(eventId, subscriptionId, status, periodEndUnix) {
  return {
    id: eventId,
    type: "customer.subscription.updated",
    data: {
      object: { id: subscriptionId, status, current_period_end: periodEndUnix },
    },
  };
}

function subscriptionDeleted(eventId, subscriptionId) {
  return {
    id: eventId,
    type: "customer.subscription.deleted",
    data: { object: { id: subscriptionId } },
  };
}

const subId = "sub_synthetic_test_1";
const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

console.log("=== checkout.session.completed ===");
console.log(await post(checkoutCompleted("evt_test_checkout_1", subId)));

console.log("=== duplicate of the SAME event id (must not double-insert) ===");
console.log(await post(checkoutCompleted("evt_test_checkout_1", subId)));

console.log("=== customer.subscription.updated (renewal) ===");
console.log(await post(subscriptionUpdated("evt_test_updated_1", subId, "active", periodEnd)));

console.log("=== customer.subscription.deleted (cancellation) ===");
console.log(await post(subscriptionDeleted("evt_test_deleted_1", subId)));

console.log("=== invalid signature (must be 400) ===");
const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Stripe-Signature": "t=1,v1=deadbeef", "Content-Type": "application/json" },
  body: JSON.stringify(checkoutCompleted("evt_test_bad_sig", "sub_x")),
});
console.log({ status: res.status });
```

Run it: `node scratch-verify-webhook.mjs`. Then verify against the real database (`psql`/`docker exec ... psql`, same pattern used in the schema plan) that:
- `stripe_events` has exactly 4 rows (the duplicate event id did NOT create a second row), each with `processed_at` set.
- `subscriptions` has exactly 1 row for `USER_A`, with `stripe_subscription_id = 'sub_synthetic_test_1'` and, after the sequence of events above, `status = 'canceled'`.
- `provisioning_jobs` has exactly 3 rows: one `CREATE_USER` (`idempotency_key = 'create-user:11111111-1111-1111-1111-111111111111'`), one `SET_EXPIRY`, one `DISABLE_USER` — the duplicate `checkout.session.completed` delivery must NOT have produced a second `CREATE_USER` row.
- The invalid-signature request got a 400 and produced no new rows anywhere.

Report the actual quoted output — script output and the actual SQL query results — not a paraphrase. Delete the scratch script when done (`rm scratch-verify-webhook.mjs`) — it must not be committed. Stop `wrangler pages dev` and `npx supabase stop` when finished.

- [ ] **Step 7: Commit**

```bash
git add wrangler.toml .dev.vars.example package.json package-lock.json functions/lib/stripe-events.js functions/api/stripe-webhook.js
git commit -m "Add Stripe webhook handler: signature verification, idempotency, subscription sync, provisioning job enqueueing

Verified entirely locally with synthetic Stripe-signed events (no
live Stripe account needed for this task — signature verification is
offline crypto, not a network call). Confirmed: duplicate event
delivery doesn't double-write subscriptions or double-enqueue
provisioning_jobs; checkout.session.completed enqueues CREATE_USER,
subscription.updated enqueues SET_EXPIRY per billing period,
subscription.deleted enqueues DISABLE_USER; an invalid signature is
rejected with 400 and produces no writes."
```

---

## Task 2: Checkout session creation endpoint and the dashboard's Subscribe button

**BLOCKED on real Stripe test-mode credentials — do not dispatch this task's implementation until they exist.** Unlike Task 1, `stripe.checkout.sessions.create()` is a real network call to Stripe's API; there is no offline equivalent. Before this task can be implemented and verified, the following must exist and be provided to whoever implements it:
1. A Stripe account (test mode is sufficient).
2. One Product with one recurring monthly Price created in the Stripe test Dashboard — its Price ID (`price_...`) is `STRIPE_PRICE_ID`.
3. The account's test-mode secret key (`sk_test_...`) is `STRIPE_API_KEY`.
4. A webhook endpoint registered in the Stripe test Dashboard (or, for local testing, `stripe listen --forward-to http://127.0.0.1:8788/api/stripe-webhook` via the Stripe CLI, which requires `stripe login` against the real account) — its signing secret (`whsec_...`) is `STRIPE_SIGNING_SECRET`, replacing Task 1's local placeholder value once this task actually exercises the real Stripe API end to end.

**Files:**
- Create: `functions/api/create-checkout-session.js`
- Modify: `src/app/dashboard/page.tsx` (add a "Subscribe" button and the client-side call to trigger it)

**Interfaces:**
- Consumes: Task 1's `functions/api/stripe-webhook.js` is what actually updates `subscriptions`/`provisioning_jobs` — this task's endpoint never writes to either table, only starts a Checkout Session (Global Constraint: the webhook is the only writer). Consumes `useSession()` from the auth plan (`src/hooks/useSession.ts`) for the access token to send.
- Produces: `POST /api/create-checkout-session`, returning `{ url: string }` — a Stripe-hosted Checkout URL the browser redirects to.

- [ ] **Step 1: Write `functions/api/create-checkout-session.js`**

```js
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

  const stripe = new Stripe(env.STRIPE_API_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: user.id,
      customer_email: user.email,
      success_url: `${env.SITE_URL}/dashboard/?checkout=success`,
      cancel_url: `${env.SITE_URL}/dashboard/?checkout=cancel`,
    });
  } catch (err) {
    console.error("create-checkout-session: Stripe error:", err.message);
    return new Response(JSON.stringify({ error: "Could not start checkout" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ url: session.url }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Add the Subscribe button to `src/app/dashboard/page.tsx`**

Read the current file first (the auth plan already wrote it). Replace the "No active subscription yet..." paragraph's surrounding block with a working button that calls the new endpoint:

```tsx
// Add near the top of the component, alongside existing state:
const [checkoutLoading, setCheckoutLoading] = useState(false);
const [checkoutError, setCheckoutError] = useState<string | null>(null);

async function handleSubscribe() {
  if (!session) return;
  setCheckoutLoading(true);
  setCheckoutError(null);
  try {
    const res = await fetch("/api/create-checkout-session", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const data = await res.json();
    if (!res.ok || !data.url) {
      throw new Error(data.error || "Could not start checkout");
    }
    window.location.href = data.url;
  } catch (err) {
    setCheckoutError(err instanceof Error ? err.message : "Something went wrong.");
    setCheckoutLoading(false);
  }
}
```

Replace the subscription card's body with:

```tsx
<p className="section-sub">
  No active subscription yet.
</p>
{checkoutError && <p className="field-error">{checkoutError}</p>}
<button
  type="button"
  className="btn btn-primary"
  onClick={handleSubscribe}
  disabled={checkoutLoading}
  style={{ width: "100%", marginTop: "var(--space-4)" }}
>
  {checkoutLoading ? "Redirecting…" : "Subscribe"}
</button>
```

(`useState` is already imported in this file from the auth plan's work — add `checkoutLoading`/`checkoutError` alongside whatever state already exists; do not remove the existing `loading`/`session` handling from `useSession()`.)

- [ ] **Step 3: Verify the build succeeds**

Run: `npm run build`. Expected: PASSES (this doesn't require live Stripe — it's a static build, the Function itself isn't invoked at build time).

- [ ] **Step 4: Live verification — REQUIRES real Stripe test credentials, do not attempt with placeholders**

With real `STRIPE_API_KEY`/`STRIPE_PRICE_ID` in `.dev.vars` and either a real registered webhook endpoint or `stripe listen --forward-to http://127.0.0.1:8788/api/stripe-webhook` running (updating `STRIPE_SIGNING_SECRET` to match what `stripe listen` prints):

1. `npm run build && npx wrangler pages dev out --port 8788`.
2. Sign up/log in as a real test user (local Supabase, from the auth plan).
3. Click Subscribe on the dashboard; confirm it redirects to a real Stripe-hosted Checkout page.
4. Complete checkout with Stripe's documented test card number (`4242 4242 4242 4242`, any future expiry/CVC).
5. Confirm redirect back to `/dashboard/?checkout=success`.
6. Confirm the real webhook fired (visible in `stripe listen`'s terminal output or the Dashboard's webhook log) and that `subscriptions`/`provisioning_jobs` were actually written — same verification queries as Task 1 Step 6, against real data this time.

Report the actual output. This step cannot be faked or skipped — it's the only thing in this plan that proves the two endpoints actually interoperate with the real Stripe API, which Task 1's synthetic-event testing structurally cannot prove (it never made a real API call).

- [ ] **Step 5: Commit**

```bash
git add functions/api/create-checkout-session.js src/app/dashboard/page.tsx
git commit -m "Add Checkout session creation endpoint and the dashboard Subscribe button

Verified against a real Stripe test-mode account end to end: Subscribe
redirects to a real Checkout page, completing it with Stripe's test
card redirects back to the dashboard, and the real webhook (Task 1)
correctly wrote subscriptions/provisioning_jobs from the real event."
```

---

## Explicitly not in this plan

- The VPS provisioning agent that actually polls `provisioning_jobs` and runs `vpn-admin` commands — separate, later plan (needs a real deployed VPS per the spec's prerequisites).
- Nuanced dunning: `invoice.payment_failed`/`past_due` handling beyond what `customer.subscription.updated` already captures via `status`. The spec calls for "warn rather than immediately revoke on past_due" — that's dashboard UI work (reading `subscriptions.status`) for a later plan, not a new webhook event handler.
- Stripe Customer Portal (payment method changes, invoice history, self-service cancellation) — spec explicitly defers building custom billing-management UI in favor of Stripe's own hosted portal; wiring a "Manage billing" link to it is a small follow-up once a real Stripe account/portal configuration exists.
- The German §312k/§356a cancellation-button legal requirement and whether Stripe's Customer Portal alone satisfies it — spec §9 item 6, needs actual legal input, not app code.
- VAT/OSS registration, business entity/bank account for payouts — spec §9 items 6-7, not code.
