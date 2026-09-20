# Arcana Stripe billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stripe-driven billing for Arcana's one monthly plan: a webhook handler that is the sole source of truth for subscription state and enqueues provisioning work (never a client-trusted "I paid" signal), and a Checkout-session-creation endpoint the dashboard's "Subscribe" button calls.

**Architecture:** Cloudflare Pages Functions (`functions/api/*.js`), the same pattern already proven in the sibling reference project `ml-consulting-website` — plain JS, `context.env` for secrets/config, no Next.js server runtime involved (this site is `output: 'export'`). Two endpoints: `POST /api/stripe-webhook` (Stripe → us, signature-verified, `stripe_events`-deduplicated, updates `subscriptions`, enqueues `provisioning_jobs` rows) and `POST /api/create-checkout-session` (browser → us, requires a valid Supabase access token, returns a Stripe Checkout URL to redirect to). **Task 1 (the webhook handler) needs no live Stripe account to build or test** — Stripe's own signature-verification helper (`stripe.webhooks.generateTestHeaderStringAsync`) can sign synthetic event payloads locally, and Cloudflare's edge-compatible client (`Stripe.createFetchHttpClient()`/`createSubtleCryptoProvider()`) never has to make a real network call to verify a signature. **Task 2 (Checkout session creation) does need a real Stripe test-mode account** — `stripe.checkout.sessions.create()` is a real API call with no offline equivalent. Task 1 is executable now; Task 2 is written but execution pauses until real Stripe test credentials exist (tracked in Global Constraints below).

**Revision note:** this version replaces an earlier draft (implemented and reviewed on a now-abandoned branch, never merged) that was found to have 4 Critical financial-integrity bugs. The earlier draft drove provisioning off `checkout.session.completed`/`customer.subscription.updated`, diverging from spec §6's explicit `invoice.paid`-driven design with no stated reason. A whole-branch security review (live adversarial testing against a real local Postgres + synthetic-signed events) found this let renewals silently drop (a real Stripe API field the old code depended on, `Subscription.current_period_end`, was removed from the top level in API version `2025-03-31.basil`+ and moved under `items.data[0]` — confirmed via Context7 docs query, not assumed), let unpaid Checkout Sessions (e.g. SEPA Direct Debit, common for an EU product) get provisioned as if paid, and let a user who cancels and later re-subscribes never get re-provisioned (a per-user rather than per-subscription idempotency key). **This revision fixes all of that by moving to `invoice.paid` as the sole provisioning trigger, exactly as the spec specifies**, with `checkout.session.completed` reduced to only recording the Supabase-user ↔ Stripe-customer/subscription mapping (never provisioning anything itself, which structurally eliminates the unpaid-session bug). Every Stripe object field this plan reads was re-verified against Context7's live Stripe Node SDK docs, not written from memory — the exact bug class that broke the first draft.

**Tech Stack:** `stripe` (Node SDK, used in its Cloudflare-Workers-compatible mode — verified against the SDK's own official Cloudflare Pages Functions example, not guessed), `@supabase/supabase-js` (service-role client, same as the reference project's functions), `wrangler` (Cloudflare's CLI, for local Functions dev via `wrangler pages dev`).

**Spec:** `docs/superpowers/specs/2026-09-20-vpn-website-mvp-design.md` in the sibling repo `singbox-vpn` (absolute path: `D:\ISDA\singbox-vpn\docs\superpowers\specs\2026-09-20-vpn-website-mvp-design.md`) — §6 (payment → provisioning flow), §5 item 4 (`stripe_events` idempotency), §9 item 2 (Stripe account prerequisite).

## Global Constraints

- **`invoice.paid` is the sole provisioning trigger (spec §6), not `checkout.session.completed`.** `checkout.session.completed` only records the Supabase-user ↔ Stripe-customer/subscription mapping (`subscriptions` row, `status: "incomplete"`) — it must never insert a `provisioning_jobs` row. This is what structurally prevents provisioning an unpaid session (delayed-notification payment methods like SEPA Direct Debit complete `checkout.session.completed` before payment clears).
- **The webhook is the only writer of subscription/access state.** The Checkout-session-creation endpoint (Task 2) never writes to `subscriptions` or `provisioning_jobs` — it only starts a Checkout Session. This is a spec requirement (§6), not a style choice: a client-trusted "I paid" signal is exactly the vulnerability a real payment integration cannot have.
- **Idempotency is mandatory, not best-effort, and keyed on the right identity.** Stripe redelivers webhooks until it gets a 2xx; the handler must be safe to receive the same event twice (checked via `stripe_events.stripe_event_id`, unique-constrained) and every `provisioning_jobs` insert must use a deterministic `idempotency_key`. `CREATE_USER`'s key is scoped to the **subscription id**, not the user id — a user who cancels and later starts a brand-new subscription must be re-provisioned, which a per-user key would silently prevent forever (this exact bug shipped in the earlier draft).
- **Every Stripe object field this code reads must be verified against current Stripe API docs (Context7), not written from memory or copied from an older tutorial.** Stripe's object shapes genuinely change between API versions (`Subscription.current_period_end` moved to `items.data[0].current_period_end`; `Invoice.subscription` moved to `Invoice.parent.subscription_details.subscription`, both as of `2025-03-31.basil`+) — every field access on a Stripe object in this plan reads from the new location with a defensive fallback to the old one, via small named helper functions, not inline optional-chaining scattered through handler bodies.
- **Raw request body, not parsed JSON, is what gets signature-verified.** Stripe's HMAC covers the exact bytes sent; parsing to JSON first and re-serializing would produce a different byte string and fail verification. `request.text()`, never `request.json()`, feeds `constructEventAsync`.
- **`constructEventAsync` + `createSubtleCryptoProvider`, never the sync `constructEvent`.** Cloudflare Workers has no synchronous Node crypto; this is not a style preference, the sync path throws `CryptoProviderOnlySupportsAsyncError` at runtime under Workers. Verified against Stripe's own official Cloudflare Pages Functions example (not assumed from general Node docs).
- **A zero-row result from an `UPDATE` on `subscriptions` is never silently treated as success**, and the correct response differs by event: `customer.subscription.updated`/`invoice.paid` arriving before the row exists (Stripe doesn't guarantee delivery order) is genuinely transient — throw, so the caller gets a 500 and Stripe retries. `customer.subscription.deleted` for a subscription this app never recorded (it was never paid, so there is nothing to disable) is not transient — log and return cleanly, no retry needed.
- **Error responses never echo Stripe SDK internals to the caller.** Log the real error via `console.error`; the HTTP response body is a fixed, generic string.
- **`STRIPE_API_KEY`/`STRIPE_SIGNING_SECRET`/`STRIPE_PRICE_ID` are real Stripe test-mode credentials that don't exist in this session** — tracked explicitly as a blocker for Task 2 only. Task 1 needs none of them to be real (a syntactically-valid placeholder string is enough, since Task 1 never calls Stripe's network API — only its offline signing/verification helpers).
- Every Cloudflare Pages Function follows the reference project's existing shape: `export async function onRequestPost({ env, request })`, JSON responses, errors logged via `console.error` (visible in `wrangler pages dev`'s terminal output and, in production, Cloudflare's function logs).
- **Known, accepted residual limitation (not fixed in this plan):** nothing yet prevents a user from starting a second Checkout Session while already subscribed, which would make a second `invoice.paid` collide with the schema's `subscriptions_user_active_uniq` partial index and fail closed (500, Stripe retries, no data corruption — just a stuck event). Preventing the second checkout attempt belongs in Task 2 (check for an existing active subscription before creating a session) once real Stripe credentials exist to build and test it against.

---


## Task 1: Stripe webhook handler, `invoice.paid`-driven provisioning (buildable and testable now, no live Stripe account needed)

**Files:**
- Create: `wrangler.toml`
- Create: `.dev.vars.example`
- Modify: `package.json` (add `stripe` dependency, `wrangler` devDependency)
- Create: `supabase/migrations/20260921120000_widen_subscription_status.sql` (adds the two Stripe subscription statuses the original schema migration's CHECK constraint was missing: `incomplete_expired`, `paused` — both routine, not edge cases; `incomplete_expired` fires whenever an initial payment isn't completed within Stripe's 23-hour window)
- Create: `functions/lib/stripe-fields.js` (defensive field accessors for the Stripe object shapes that have moved between API versions)
- Create: `functions/lib/stripe-events.js`
- Create: `functions/api/stripe-webhook.js`

**Interfaces:**
- Consumes: the Supabase schema from the merged schema plan (`subscriptions`, `provisioning_jobs`, `stripe_events` tables — exact column names/types already fixed there), widened by this task's own migration.
- Produces: `POST /api/stripe-webhook`, the exported handler functions in `functions/lib/stripe-events.js` (`handleCheckoutSessionCompleted`, `handleInvoicePaid`, `handleSubscriptionUpdated`, `handleSubscriptionDeleted`), and the field-accessor helpers in `functions/lib/stripe-fields.js` (`getSubscriptionPeriodEnd`, `getInvoiceSubscriptionId`, `getInvoiceLinePeriodEnd`) — any later plan reading a Stripe Subscription/Invoice object should reuse these rather than re-deriving the same version-drift-prone field access.

- [ ] **Step 1: Write `wrangler.toml`**

```toml
# Cloudflare Pages configuration — no Workers-only settings here.
name = "arcana-web"
pages_build_output_dir = "out"
compatibility_date = "2026-09-20"
# Both @supabase/supabase-js and stripe assume some Node built-ins
# (e.g. Buffer, process.env-shaped access patterns internally) that the
# Workers runtime only provides under this flag.
compatibility_flags = ["nodejs_compat"]
```

(No `[functions]` block — Cloudflare Pages auto-discovers the `functions/` directory by convention; an explicit `directory = "functions"` field under `[functions]` produces an "Unexpected fields found" warning on current `wrangler` versions without changing behavior, so it's simply omitted here.)

- [ ] **Step 2: Write `.dev.vars.example`**

```
# Copy to .dev.vars for local `wrangler pages dev` runs (gitignored — never
# commit real values). Task 1 (the webhook handler) never makes a real
# network call to Stripe, so STRIPE_API_KEY here can be any syntactically
# plausible placeholder for local testing. STRIPE_SIGNING_SECRET, however,
# MUST match whatever secret your local test script signs synthetic events
# with (see Task 1 Step 8) — they are the same shared secret on both sides
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

Run: `npm install`. Expected: succeeds. If `wrangler` needs its native build tooling (`workerd`, `esbuild`, `unrs-resolver`) approved under npm's `install-scripts` allowlist to actually run later in this task, approve exactly those three pinned packages (`npm install-scripts approve workerd esbuild unrs-resolver` or the equivalent your npm version uses) — nothing broader.

- [ ] **Step 4: Write the schema-widening migration**

Create `supabase/migrations/20260921120000_widen_subscription_status.sql`:

```sql
-- The original subscriptions.status CHECK constraint (schema plan,
-- 20260921000000_initial_schema.sql) omitted two routine Stripe Subscription
-- statuses: `incomplete_expired` (fires whenever an initial payment isn't
-- completed within Stripe's 23-hour window — not an edge case, the normal
-- outcome of an abandoned checkout) and `paused` (a Stripe-native pause
-- feature this app doesn't use yet but Stripe can still report). Without
-- this, a webhook delivering either status violates the CHECK constraint
-- and 500-loops until Stripe gives up retrying (~3 days), permanently
-- desyncing that subscription's state.
alter table public.subscriptions drop constraint subscriptions_status_check;
alter table public.subscriptions add constraint subscriptions_status_check check (
  status in (
    'incomplete',
    'incomplete_expired',
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid',
    'paused'
  )
);
```

- [ ] **Step 5: Write `functions/lib/stripe-fields.js`**

```js
// Defensive accessors for Stripe object fields that have moved between API
// versions. Stripe's own SDK types confirm both of these moves as of API
// version 2025-03-31.basil (installed SDK pins a later version, so both
// moves are in effect): Subscription.current_period_end now lives per-item
// under items.data[0]; Invoice.subscription now lives under
// parent.subscription_details.subscription. Both helpers check the new
// location first and fall back to the pre-basil top-level field, so this
// code works whether or not the connected Stripe account's webhook API
// version predates the move. Every place this codebase reads one of these
// fields MUST go through these helpers, not inline field access — that
// inline-access pattern is exactly what broke the previous draft of this
// handler (it silently nulled every renewal's expiry once tested against a
// real, current-API-version payload).

/**
 * @param {object} subscription - a Stripe Subscription object
 * @returns {number | null} unix seconds, or null if genuinely absent
 */
export function getSubscriptionPeriodEnd(subscription) {
  const fromItem = subscription.items?.data?.[0]?.current_period_end;
  if (typeof fromItem === "number") return fromItem;
  if (typeof subscription.current_period_end === "number") {
    return subscription.current_period_end;
  }
  return null;
}

/**
 * @param {object} invoice - a Stripe Invoice object
 * @returns {string | null} the subscription id, or null if this invoice
 *   isn't associated with a subscription (e.g. a one-off invoice)
 */
export function getInvoiceSubscriptionId(invoice) {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (fromParent) {
    return typeof fromParent === "string" ? fromParent : fromParent.id;
  }
  if (invoice.subscription) {
    return typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription.id;
  }
  return null;
}

/**
 * @param {object} invoice - a Stripe Invoice object
 * @returns {number | null} unix seconds of the paid service period's end,
 *   from the most specific source available
 */
export function getInvoiceLinePeriodEnd(invoice) {
  const fromLine = invoice.lines?.data?.[0]?.period?.end;
  if (typeof fromLine === "number") return fromLine;
  if (typeof invoice.period_end === "number") return invoice.period_end;
  return null;
}
```

- [ ] **Step 6: Write `functions/lib/stripe-events.js`**

```js
// Stripe webhook event handlers. Each function is idempotent: safe to run
// twice for the same underlying Stripe object, because every write either
// upserts/updates by a Stripe-assigned unique id or inserts a
// provisioning_jobs row under a deterministic idempotency_key that a
// duplicate call reproduces exactly (the unique constraint on
// provisioning_jobs.idempotency_key turns a duplicate insert into a
// harmless no-op).
//
// invoice.paid is the SOLE provisioning trigger (spec §6) — the only place
// in this file that inserts a CREATE_USER or SET_EXPIRY job.
// checkout.session.completed only records the user-id <-> customer/
// subscription mapping; it never provisions anything, which is what makes
// an unpaid session (e.g. SEPA Direct Debit, which completes Checkout
// before payment clears) harmless — invoice.paid simply never arrives for
// a payment that never clears.

import {
  getSubscriptionPeriodEnd,
  getInvoiceSubscriptionId,
  getInvoiceLinePeriodEnd,
} from "./stripe-fields.js";

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
  if (!session.customer || !session.subscription) {
    throw new Error(
      "checkout.session.completed missing customer/subscription id"
    );
  }

  const { error } = await supabaseAdmin.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      // "incomplete" until invoice.paid confirms payment and flips this to
      // "active" — never "active" here, and no provisioning_jobs write in
      // this function at all (see file header).
      status: "incomplete",
    },
    { onConflict: "stripe_subscription_id" }
  );
  if (error) {
    throw new Error(`subscriptions upsert failed: ${error.message}`);
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object} invoice - a Stripe Invoice object
 */
export async function handleInvoicePaid(supabaseAdmin, invoice) {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    // A one-off (non-subscription) invoice — nothing for this app to do.
    return;
  }

  const periodEndUnix = getInvoiceLinePeriodEnd(invoice);
  if (typeof periodEndUnix !== "number") {
    throw new Error(`invoice.paid ${invoice.id} has no discoverable line-item period end`);
  }
  const currentPeriodEnd = new Date(periodEndUnix * 1000).toISOString();

  const { data: sub, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: "active",
      current_period_end: currentPeriodEnd,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscriptionId)
    .select("user_id")
    .maybeSingle();
  if (subError) {
    throw new Error(`subscriptions update failed: ${subError.message}`);
  }
  if (!sub) {
    // The checkout.session.completed mapping hasn't landed yet — Stripe
    // doesn't guarantee webhook delivery order. Throw (-> 500 -> Stripe
    // retries) rather than silently dropping this invoice's provisioning.
    throw new Error(
      `no subscriptions row for stripe_subscription_id=${subscriptionId} yet`
    );
  }

  // billing_reason distinguishes a subscription's first invoice from every
  // later renewal — the correct, Stripe-documented signal for this (not
  // "does a provisioning_jobs row already exist", which would need an
  // extra query and race against this same handler's own writes).
  const isFirstInvoice = invoice.billing_reason === "subscription_create";
  const jobType = isFirstInvoice ? "CREATE_USER" : "SET_EXPIRY";
  const idempotencyKey = isFirstInvoice
    ? `create-user:${subscriptionId}`
    : `set-expiry:${subscriptionId}:${currentPeriodEnd}`;
  const payload = isFirstInvoice
    ? { user_id: sub.user_id, expires_at: currentPeriodEnd }
    : { stripe_subscription_id: subscriptionId, expires_at: currentPeriodEnd };

  const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
    idempotency_key: idempotencyKey,
    node_id: "node-1",
    job_type: jobType,
    payload,
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
  const periodEndUnix = getSubscriptionPeriodEnd(subscription);
  const currentPeriodEnd =
    typeof periodEndUnix === "number" ? new Date(periodEndUnix * 1000).toISOString() : null;

  const { data: updated, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: subscription.status,
      current_period_end: currentPeriodEnd,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscription.id)
    .select("user_id")
    .maybeSingle();
  if (subError) {
    throw new Error(`subscriptions update failed: ${subError.message}`);
  }
  if (!updated) {
    // Same transient-vs-permanent reasoning as handleInvoicePaid: this
    // event can genuinely arrive before checkout.session.completed's
    // mapping write. Retry rather than silently losing the status change.
    throw new Error(
      `no subscriptions row for stripe_subscription_id=${subscription.id} yet`
    );
  }

  // unpaid/canceled here (as opposed to the customer.subscription.deleted
  // event) is Stripe's normal dunning outcome for a subscription that
  // simply stops being paid, without ever being explicitly deleted — spec
  // §6 requires revoking on either. Same idempotency_key shape as
  // handleSubscriptionDeleted's, so if both events fire for the same
  // cancellation, the second insert is a harmless no-op (23505), not a
  // second job.
  if (subscription.status === "canceled" || subscription.status === "unpaid") {
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
    .maybeSingle();
  if (subError) {
    throw new Error(`subscriptions update failed: ${subError.message}`);
  }
  if (!updated) {
    // Unlike handleSubscriptionUpdated/handleInvoicePaid, a missing row
    // here is NOT transient: this subscription was never recorded (e.g.
    // its checkout session was never paid, so invoice.paid never fired),
    // meaning there is genuinely nothing to disable. Log for visibility,
    // return cleanly — no retry needed, retrying would never find a row.
    console.warn(
      `customer.subscription.deleted for unknown stripe_subscription_id=${subscription.id}`
    );
    return;
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

- [ ] **Step 7: Write `functions/api/stripe-webhook.js`**

```js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import {
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
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
    // Log the real reason; the response body is fixed and generic — never
    // echo Stripe SDK internals (timestamp/signature detail) to an
    // unauthenticated caller.
    console.error("stripe-webhook: signature verification failed:", err.message);
    return new Response("Bad Request", { status: 400 });
  }

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Idempotency: look up this event id first. A row with processed_at set
  // means this exact event already succeeded — return 200 without
  // reprocessing. A row that exists but has processed_at = null means a
  // prior attempt was recorded but never finished — fall through and retry
  // the handler rather than silently treating it as done.
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
      if (insertError.code === "23505") {
        // A truly concurrent delivery of the same event id won this race —
        // that request is (or will shortly be) doing the real work. Return
        // 200 rather than 500, so Stripe doesn't schedule an unnecessary
        // retry for an event that's already being handled.
        return new Response(JSON.stringify({ received: true, duplicate: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      console.error("stripe-webhook: failed to record event:", insertError.message);
      return new Response("Internal error", { status: 500 });
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(supabaseAdmin, event.data.object);
        break;
      case "invoice.paid":
        await handleInvoicePaid(supabaseAdmin, event.data.object);
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

- [ ] **Step 8: Write a throwaway local verification script (not committed) that signs synthetic events shaped like the REAL current Stripe API — not the old field locations — and drives the real endpoint**

Requires: local Supabase running (`npx supabase start`, applies both the schema plan's migration+seed and this task's own widening migration) and the built site served with Functions (`npm run build && npx wrangler pages dev out --port 8788`, in a separate terminal, with `.dev.vars` copied from `.dev.vars.example` — set `SUPABASE_SERVICE_ROLE_KEY` to the real value your local `supabase start` printed, and leave `STRIPE_SIGNING_SECRET` as the placeholder value since this script signs with that same shared value). Use a **fresh, non-seeded** synthetic user id (not the schema plan's seeded `USER_A`/`USER_B`) so this test never needs to mutate seed data to avoid the `subscriptions_user_active_uniq` partial-index collision the earlier draft's verification hit.

```js
// scratch-verify-webhook.mjs (throwaway, not committed)
import Stripe from "stripe";
import { randomUUID } from "node:crypto";

const SIGNING_SECRET = "whsec_test_local_secret_for_synthetic_events_only"; // must match .dev.vars
const ENDPOINT = "http://127.0.0.1:8788/api/stripe-webhook";
const TEST_USER_ID = randomUUID(); // fresh every run — never collides with seed data

const webCrypto = Stripe.createSubtleCryptoProvider();

async function post(event) {
  const payload = JSON.stringify(event);
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: SIGNING_SECRET,
    cryptoProvider: webCrypto,
  });
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
        client_reference_id: TEST_USER_ID,
        customer: "cus_synthetic_test",
        subscription: subscriptionId,
      },
    },
  };
}

// Shaped like the REAL current API: period lives on the line item, under
// lines.data[0].period.end — never a top-level invoice.subscription string,
// use parent.subscription_details.subscription instead, matching what a
// real Stripe account on the SDK's pinned API version actually sends.
function invoicePaid(eventId, subscriptionId, periodEndUnix, billingReason) {
  return {
    id: eventId,
    type: "invoice.paid",
    data: {
      object: {
        id: `in_synthetic_${eventId}`,
        billing_reason: billingReason,
        parent: { subscription_details: { subscription: subscriptionId } },
        lines: { data: [{ period: { start: periodEndUnix - 30 * 24 * 3600, end: periodEndUnix } }] },
      },
    },
  };
}

function subscriptionUpdated(eventId, subscriptionId, status, periodEndUnix) {
  return {
    id: eventId,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: subscriptionId,
        status,
        // Real current shape: per-item, not top-level.
        items: { data: [{ current_period_end: periodEndUnix }] },
      },
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

const subId = `sub_synthetic_${TEST_USER_ID.slice(0, 8)}`;
const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

console.log("=== checkout.session.completed (should NOT provision anything) ===");
console.log(await post(checkoutCompleted("evt_test_checkout_1", subId)));

console.log("=== invoice.paid, billing_reason=subscription_create (first payment -> CREATE_USER) ===");
console.log(await post(invoicePaid("evt_test_invoice_1", subId, periodEnd, "subscription_create")));

console.log("=== duplicate of the SAME invoice.paid event id (must not double-enqueue) ===");
console.log(await post(invoicePaid("evt_test_invoice_1", subId, periodEnd, "subscription_create")));

console.log("=== invoice.paid, billing_reason=subscription_cycle (renewal -> SET_EXPIRY) ===");
const renewalPeriodEnd = periodEnd + 30 * 24 * 3600;
console.log(await post(invoicePaid("evt_test_invoice_2", subId, renewalPeriodEnd, "subscription_cycle")));

console.log("=== customer.subscription.updated, status=unpaid (-> DISABLE_USER) ===");
console.log(await post(subscriptionUpdated("evt_test_updated_1", subId, "unpaid", renewalPeriodEnd)));

console.log("=== customer.subscription.deleted (-> DISABLE_USER again, must no-op not error) ===");
console.log(await post(subscriptionDeleted("evt_test_deleted_1", subId)));

console.log("=== customer.subscription.deleted for a NEVER-PAID subscription (must be clean 200, not 500) ===");
console.log(await post(subscriptionDeleted("evt_test_deleted_unknown", "sub_never_existed")));

console.log("=== customer.subscription.updated arriving BEFORE checkout.session.completed for a brand-new sub (must 500, not silently succeed) ===");
console.log(
  await post(subscriptionUpdated("evt_test_out_of_order", "sub_never_registered", "active", periodEnd))
);

console.log("=== invalid signature (must be 400) ===");
const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Stripe-Signature": "t=1,v1=deadbeef", "Content-Type": "application/json" },
  body: JSON.stringify(checkoutCompleted("evt_test_bad_sig", "sub_x")),
});
console.log({ status: res.status });

console.log("TEST_USER_ID for DB verification:", TEST_USER_ID);
console.log("subscription id for DB verification:", subId);
```

Run it: `node scratch-verify-webhook.mjs`, then verify against the real database that:
- `checkout.session.completed` wrote a `subscriptions` row with `status = 'incomplete'` and produced **zero** `provisioning_jobs` rows (the structural fix for the unpaid-session bug).
- The first `invoice.paid` set `status = 'active'`, `current_period_end` matching `periodEnd`, and produced exactly one `CREATE_USER` job with `idempotency_key = 'create-user:<subId>'`.
- The duplicate `invoice.paid` (same event id) did NOT create a second `CREATE_USER` row and did NOT re-run the handler (check `stripe_events` — only one row for that event id, `processed_at` set once).
- The renewal `invoice.paid` (`subscription_cycle`) produced exactly one `SET_EXPIRY` job, and `subscriptions.current_period_end` now matches `renewalPeriodEnd`.
- `status=unpaid` produced exactly one `DISABLE_USER` job.
- The subsequent `customer.subscription.deleted` for the SAME subscription did NOT produce a second `DISABLE_USER` row (same idempotency key, no-op).
- `customer.subscription.deleted` for an unknown subscription id returned 200 (not 500) and wrote nothing.
- `customer.subscription.updated` for a subscription with no `subscriptions` row yet returned 500 (not a silent 200) and wrote nothing to `subscriptions` (verifying the transient-vs-permanent distinction actually holds).
- The invalid-signature request got a 400 and produced no new rows anywhere.

Report the actual quoted output — script output and the actual SQL query results — not a paraphrase. Delete the scratch script when done (`rm scratch-verify-webhook.mjs`) — it must not be committed. Stop `wrangler pages dev` and `npx supabase stop` when finished.

- [ ] **Step 9: Commit**

```bash
git add wrangler.toml .dev.vars.example package.json package-lock.json supabase/migrations/20260921120000_widen_subscription_status.sql functions/lib/stripe-fields.js functions/lib/stripe-events.js functions/api/stripe-webhook.js
git commit -m "Add Stripe webhook handler: invoice.paid-driven provisioning, signature verification, idempotency

Provisioning is driven solely by invoice.paid (spec §6), not
checkout.session.completed — that event only records the user<->
Stripe customer/subscription mapping, which structurally prevents
provisioning an unpaid Checkout Session (e.g. SEPA Direct Debit).
Every Stripe object field read goes through version-drift-defensive
accessors in functions/lib/stripe-fields.js, verified against current
Stripe API docs rather than assumed. CREATE_USER's idempotency key is
scoped to the subscription id so a cancel-then-resubscribe user is
re-provisioned. Widened subscriptions.status's CHECK constraint for
two routine statuses (incomplete_expired, paused) the original schema
migration omitted. Verified entirely locally with synthetic
Stripe-signed events shaped like the real current API (not the old
field locations), including the full lifecycle (checkout -> first
payment -> renewal -> non-payment -> deletion), out-of-order and
unknown-subscription delivery, and duplicate-event idempotency."
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
