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
  getExtraSeatCount,
  getBaseSubscriptionPriceId,
  isAllowedBasePrice,
} from "./stripe-fields.js";
import {
  getAccountForUser,
  getAccountMembers,
  getEffectiveEntitlement,
} from "./accounts.js";
import { syncAccountProvisioningToEntitlement } from "./provision-entitlement.js";
import { raiseAlert } from "./alerts.js";

function subscriptionNameFrom(session) {
  const raw = session.metadata?.subscription_name;
  const name = typeof raw === "string" ? raw.trim() : "";
  return name.length >= 1 && name.length <= 80 ? name : "Personal";
}

/**
 * F-02/C-02/C-14: Stripe does not guarantee webhook delivery order. Every
 * handler that writes subscriptions.status/current_period_end/etc must go
 * through this guard rather than writing unconditionally, so that a
 * late-arriving but chronologically-stale event can never clobber a row a
 * newer event already advanced.
 *
 * Two independent protections:
 *  - Sticky canceled: once a row reads "canceled", Stripe never reactivates
 *    that same subscription id (a resubscribe creates a new id), so no
 *    non-canceled write may ever land on top of it again, regardless of
 *    timestamps.
 *  - Timestamp ordering: when both the incoming event's creation time and
 *    the row's last-synced-at are known, an event no newer than the row's
 *    last sync is stale and must be skipped even if its status looks more
 *    "current" superficially (e.g. a delayed invoice.paid behind a
 *    subsequent subscription.updated).
 *
 * eventCreatedAt/current.stripe_synced_at absence (legacy rows, or a caller
 * that doesn't pass a timestamp) degrades to sticky-canceled-only, which is
 * intentional: this must never regress existing behavior for callers that
 * predate this guard.
 */
function isStaleSubscriptionWrite(current, eventCreatedAt, nextStatus) {
  if (!current) return false;
  if (current.status === "canceled" && nextStatus !== "canceled") return true;
  if (!eventCreatedAt || !current.stripe_synced_at) return false;
  return new Date(eventCreatedAt).getTime() <= new Date(current.stripe_synced_at).getTime();
}

async function readSubscriptionSyncState(supabaseAdmin, subscriptionId) {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("status, stripe_synced_at, account_id, current_period_end")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  if (error) {
    throw new Error(`subscriptions sync-state read failed: ${error.message}`);
  }
  return data;
}

/**
 * F-31/C-04: the default checkout.session.completed payload carries no
 * line-item price data, so this is the one live Stripe call this codebase
 * makes from a webhook handler (round 2 explicitly declined to thread a
 * retrieve through every handler for F-02 — this is narrower: one call, in
 * the one handler that runs exactly once per checkout, not on every event).
 *
 * @returns {Promise<string | null>} the base (non-pack) item's price id, or
 *   null if it can't be determined from the line items Stripe returns
 */
async function resolveCheckoutBasePriceId(stripe, session, seatPriceId) {
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    expand: ["data.price"],
  });
  return getBaseSubscriptionPriceId({ items: { data: lineItems?.data ?? [] } }, seatPriceId);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object} session - a Stripe Checkout Session object
 * @param {import('stripe').Stripe | null} stripe - a live Stripe client, used
 *   only to verify the checkout's base price (F-31). Optional so existing
 *   unit tests that don't exercise price validation keep working unchanged;
 *   the real webhook handler always passes one.
 * @param {object} env
 */
export async function handleCheckoutSessionCompleted(supabaseAdmin, session, stripe = null, env = {}) {
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

  // client_reference_id is the Supabase user who went through Checkout; the
  // subscription belongs to the account they own.
  const account = await getAccountForUser(supabaseAdmin, userId);
  if (!account) {
    throw new Error(
      `checkout.session.completed: user ${userId} has no account_members row — every user gets one from the handle_new_user trigger, so this is a data integrity problem, not a race`
    );
  }

  // The Stripe customer belongs to the account, not to any one subscription:
  // the billing portal needs it even for an account whose subscription has
  // lapsed, which no subscriptions row can supply. This is safe to do
  // regardless of the price check below — portal access is not entitlement.
  const { error: customerError } = await supabaseAdmin
    .from("customer_accounts")
    .update({ stripe_customer_id: session.customer })
    .eq("id", account.accountId);
  if (customerError) {
    throw new Error(`customer_accounts update failed: ${customerError.message}`);
  }

  // F-31/C-04: verify the base item Checkout actually sold is one this
  // deployment recognizes, same allowlist handleSubscriptionUpdated already
  // enforces. If it isn't, never map this subscription id to the account —
  // with no subscriptions row, invoice.paid/customer.subscription.updated
  // can never find one to flip to "active", so device_entitlement() can
  // never grant capacity from it. This is deliberately a hard refusal, not a
  // "sync anyway" fallback: unlike handleSubscriptionUpdated (which tolerates
  // a payload with no item data, since Stripe doesn't always expand items),
  // this handler always has its own live-fetched line items to check.
  if (stripe && env.STRIPE_PRICE_ID) {
    const basePriceId = await resolveCheckoutBasePriceId(stripe, session, env.STRIPE_SEAT_PRICE_ID);
    if (basePriceId && !isAllowedBasePrice(basePriceId, env)) {
      const message = `checkout.session.completed for session ${session.id} (stripe_subscription_id=${session.subscription}) reports base price ${basePriceId}, which is not in the configured allowlist — refusing to map/provision this subscription`;
      console.error(`ALERT: ${message}`);
      await raiseAlert(supabaseAdmin, {
        kind: "checkout_unapproved_base_price",
        severity: "critical",
        dedupKey: `checkout:${session.id}:unapproved_price`,
        message,
      });
      return;
    }
  }

  // Only the FIRST delivery for a given subscription id sets status. Once
  // the row exists, invoice.paid / customer.subscription.updated are the
  // sole authoritative writers of status — a redelivered or manually
  // resent checkout.session.completed must never regress an already-
  // advanced subscription (e.g. "active") back to "incomplete".
  const { error: insertError } = await supabaseAdmin.from("subscriptions").insert({
    account_id: account.accountId,
    stripe_subscription_id: session.subscription,
    name: subscriptionNameFrom(session),
    // "incomplete" until invoice.paid confirms payment and flips this to
    // "active" — never "active" here, and no provisioning_jobs write in
    // this function at all (see file header).
    status: "incomplete",
  });

  if (insertError && insertError.code === "23505") {
    const { error: updateError } = await supabaseAdmin
      .from("subscriptions")
      .update({
        account_id: account.accountId,
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", session.subscription);
    if (updateError) {
      throw new Error(`subscriptions update failed: ${updateError.message}`);
    }
    return;
  }
  if (insertError) {
    throw new Error(`subscriptions insert failed: ${insertError.message}`);
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object} invoice - a Stripe Invoice object
 */
export async function handleInvoicePaid(supabaseAdmin, invoice, env = {}) {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    // A one-off (non-subscription) invoice — nothing for this app to do.
    return;
  }
  const eventCreatedAt =
    typeof invoice.created === "number" ? new Date(invoice.created * 1000).toISOString() : null;

  const periodEndUnix = getInvoiceLinePeriodEnd(invoice);
  if (typeof periodEndUnix !== "number") {
    throw new Error(`invoice.paid ${invoice.id} has no discoverable line-item period end`);
  }
  const currentPeriodEnd = new Date(periodEndUnix * 1000).toISOString();

  // Stripe doesn't guarantee webhook delivery order — a cancellation
  // (customer.subscription.updated/deleted) can beat a delayed invoice.paid
  // for the same subscription to this handler. Those disable handlers
  // durably set subscriptions.status to "canceled"/"unpaid" before their
  // own no-op branches return, so a plain pre-read here is enough to
  // detect that.
  //
  // The two statuses aren't equally terminal, though: "canceled" is
  // terminal in Stripe (never reactivated), so any invoice.paid arriving
  // once we've observed it is stale — always skip. "unpaid" is NOT
  // terminal — it's the end of Stripe's dunning process, and the customer
  // can still pay the outstanding invoice afterward (customer portal,
  // hosted invoice page, etc.), producing a legitimate invoice.paid while
  // this row still reads "unpaid" (the customer.subscription.updated that
  // flips it back to "active" typically arrives after). So "unpaid" only
  // blocks the specific resurrection case this guard targets — a FIRST
  // invoice (billing_reason=subscription_create) for a subscription that
  // was marked unpaid/never fully activated — not a later renewal/
  // recovery invoice, which must be allowed through normally even while
  // status still reads "unpaid" at read time.
  const currentSub = await readSubscriptionSyncState(supabaseAdmin, subscriptionId);
  const isStaleAfterCancellation = currentSub?.status === "canceled";
  const isFirstInvoiceForUnpaidSubscription =
    currentSub?.status === "unpaid" && invoice.billing_reason === "subscription_create";
  const isStaleByTimestamp = isStaleSubscriptionWrite(currentSub, eventCreatedAt, "active");
  if (isStaleAfterCancellation || isFirstInvoiceForUnpaidSubscription || isStaleByTimestamp) {
    console.warn(
      `invoice.paid ${invoice.id} for stripe_subscription_id=${subscriptionId} arrived after a newer/terminal event (status=${currentSub?.status}) — skipping provisioning`
    );
    return;
  }

  const { data: sub, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: "active",
      current_period_end: currentPeriodEnd,
      stripe_synced_at: eventCreatedAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscriptionId)
    .select("account_id")
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

  // A customer who chooses "Subscribe now" has received the product
  // without using a trial, so they must not be able to cancel later and
  // claim a first-time trial. Preserve the original first-use timestamp.
  const { data: trialAccount, error: trialReadError } = await supabaseAdmin
    .from("customer_accounts")
    .select("trial_used_at")
    .eq("id", sub.account_id)
    .maybeSingle();
  if (trialReadError) {
    throw new Error(`customer_accounts trial lookup failed: ${trialReadError.message}`);
  }
  const { error: trialConsumeError } = await supabaseAdmin
    .from("customer_accounts")
    .update({
      trial_used_at: trialAccount?.trial_used_at ?? new Date().toISOString(),
      trial_reserved_at: null,
      trial_checkout_session_id: null,
    })
    .eq("id", sub.account_id);
  if (trialConsumeError) {
    throw new Error(`customer_accounts trial update failed: ${trialConsumeError.message}`);
  }

  const entitlement = await getEffectiveEntitlement(supabaseAdmin, sub.account_id);
  if (!entitlement) {
    throw new Error(`invoice.paid ${invoice.id} produced no effective entitlement`);
  }

  // billing_reason distinguishes a subscription's first invoice from every
  // later renewal — the correct, Stripe-documented signal for this (not
  // "does a provisioning_jobs row already exist", which would need an
  // extra query and race against this same handler's own writes).
  const isFirstInvoice = invoice.billing_reason === "subscription_create";

  if (isFirstInvoice) {
    // At the first invoice the account has its one person — the owner who
    // just completed Checkout (one person per account; legacy multi-member
    // rows, if any, are provisioned by the old invite-acceptance path, not
    // from here).
    //
    // For a subscription that began as a trial this is a no-op: the trial
    // handler already enqueued these under the same idempotency keys.
    await enqueueCreateForMembers(supabaseAdmin, sub.account_id, subscriptionId, entitlement, env);
    return;
  }

  // A renewal extends every device's identity on whichever node it lives.
  const results = await syncAccountProvisioningToEntitlement(
    supabaseAdmin,
    sub.account_id,
    entitlement,
    `invoice-paid:${invoice.id}`,
    env
  );
  // A device whose FIRST identity is still being created (Stripe can fire a
  // renewal before the agent claims the first CREATE_USER) would come up
  // with the old expiry baked into that pending create. Throw so Stripe
  // retries this event once the identity exists; every job enqueued above
  // is idempotent under this event's keys, so the retry repeats nothing.
  const pending = results.filter((r) => r.pendingFirstIdentity);
  if (pending.length > 0) {
    throw new Error(
      `account_id=${sub.account_id} has ${pending.length} device(s) whose first VPN identity is not created yet`
    );
  }
}

/**
 * Enqueues a CREATE_USER job for every member of an account that has none.
 *
 * Shared by the first paid invoice and by trial activation. The idempotency
 * key is per member and per subscription, so whichever of those fires first
 * provisions and the other is a no-op — which is what lets trial handling be
 * added without having to know whether Stripe emits a zero-amount invoice at
 * trial start.
 */
async function enqueueCreateForMembers(supabaseAdmin, accountId, subscriptionId, entitlement, env) {
  const members = await getAccountMembers(supabaseAdmin, accountId);
  if (members.length === 0) {
    throw new Error(`account ${accountId} has no members — cannot provision`);
  }
  if (!entitlement.clearExpiry && !entitlement.serviceExpiresAt) {
    throw new Error("finite effective entitlement is missing serviceExpiresAt");
  }
  // The `create-user:<subscription>:` prefix is load-bearing:
  // enqueueDisableForAccount() uses it to tell "not processed yet" from
  // "never provisioned".
  await syncAccountProvisioningToEntitlement(
    supabaseAdmin,
    accountId,
    entitlement,
    `create-user:${subscriptionId}`,
    env
  );
}

/**
 * Starts service for a subscription that has entered its free trial.
 *
 * The file header says invoice.paid is the sole provisioning trigger. A free
 * trial is the one case that rule cannot express: its whole point is service
 * before payment, so waiting for a paid invoice would mean the trial grants
 * nothing. The rule's actual intent — never provision for a checkout that
 * was never paid for — still holds, because Stripe only reports `trialing`
 * for a subscription it created itself.
 *
 * Stripe's behaviour around a zero-amount invoice at trial start is not
 * something this code should depend on: if that invoice does arrive,
 * handleInvoicePaid provisions under the same idempotency key and this is a
 * no-op; if it never arrives, this is the only thing that starts the trial.
 * Correct either way, and the cost of guessing wrong would be trials that
 * silently deliver no VPN at all.
 */
export async function handleSubscriptionTrialing(supabaseAdmin, subscription, env = {}, eventCreatedAt = null) {
  const trialEndUnix = subscription.trial_end;
  if (typeof trialEndUnix !== "number") {
    throw new Error(
      `subscription ${subscription.id} is trialing but carries no trial_end`
    );
  }
  const trialEnd = new Date(trialEndUnix * 1000).toISOString();

  const current = await readSubscriptionSyncState(supabaseAdmin, subscription.id);
  if (isStaleSubscriptionWrite(current, eventCreatedAt, "trialing")) {
    console.warn(
      `subscription ${subscription.id} trialing event is stale or would un-cancel a canceled row — skipping`
    );
    return;
  }

  const { data: sub, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: "trialing",
      current_period_end: trialEnd,
      stripe_synced_at: eventCreatedAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscription.id)
    .select("account_id")
    .maybeSingle();
  if (subError) {
    throw new Error(`subscriptions update failed: ${subError.message}`);
  }
  if (!sub) {
    // checkout.session.completed's mapping has not landed yet; Stripe does
    // not guarantee delivery order. Retry rather than dropping the trial.
    throw new Error(
      `no subscriptions row for stripe_subscription_id=${subscription.id} yet`
    );
  }

  // Stripe has now confirmed that the subscription really entered its
  // trial, so consume the account's one-time eligibility and clear the
  // short-lived Checkout reservation.
  const { data: trialAccount, error: trialReadError } = await supabaseAdmin
    .from("customer_accounts")
    .select("trial_used_at")
    .eq("id", sub.account_id)
    .maybeSingle();
  if (trialReadError) {
    throw new Error(`customer_accounts trial lookup failed: ${trialReadError.message}`);
  }
  const { error: trialConsumeError } = await supabaseAdmin
    .from("customer_accounts")
    .update({
      trial_used_at: trialAccount?.trial_used_at ?? new Date().toISOString(),
      trial_reserved_at: null,
      trial_checkout_session_id: null,
    })
    .eq("id", sub.account_id);
  if (trialConsumeError) {
    throw new Error(`customer_accounts trial update failed: ${trialConsumeError.message}`);
  }

  // Reconcile against all valid access sources. A longer/no-expiry support
  // grant must not be shortened merely because a Stripe trial started.
  const entitlement = await getEffectiveEntitlement(supabaseAdmin, sub.account_id);
  if (!entitlement) {
    throw new Error(`trialing subscription ${subscription.id} produced no effective entitlement`);
  }
  await enqueueCreateForMembers(supabaseAdmin, sub.account_id, subscription.id, entitlement, env);
}

/**
 * Enqueues a DISABLE_USER job for every provisioned VPN user on an account
 * (normally just the one person; "member" rows are the legacy model).
 *
 * Shared by customer.subscription.updated (dunning reaching canceled/unpaid)
 * and customer.subscription.deleted, which have identical revocation
 * semantics — spec §6 requires revoking on either. The idempotency keys are
 * the same in both paths, so if both events fire for one cancellation the
 * second pass is a no-op (23505) rather than a second round of jobs.
 *
 * Returns without enqueueing anything when the account has no provisioned
 * VPN accounts at all AND no CREATE_USER job was ever enqueued for this
 * subscription — that combination means it was never provisioned, so there
 * is genuinely nothing to disable and retrying would never find a row.
 * Throws when a CREATE_USER job does exist, because then the missing
 * vpn_accounts row is a real race against the agent and must be retried.
 */
async function enqueueDisableForAccount(supabaseAdmin, accountId, subscriptionId, eventLabel, env) {
  // The Stripe subscription that triggered this event is no longer an
  // entitlement, but a support grant (or a newer paid subscription) may
  // still be. Reconcile to that instead of blindly disabling the account.
  const remainingEntitlement = await getEffectiveEntitlement(supabaseAdmin, accountId);
  if (remainingEntitlement) {
    await syncAccountProvisioningToEntitlement(
      supabaseAdmin,
      accountId,
      remainingEntitlement,
      `stripe-ended:${subscriptionId}:${remainingEntitlement.source}`,
      env
    );
    return;
  }

  const results = await syncAccountProvisioningToEntitlement(
    supabaseAdmin,
    accountId,
    null,
    `disable-user:${subscriptionId}`,
    env
  );

  if (!results.some((r) => r.hadIdentity)) {
    // No identity anywhere is ambiguous on its own: either the account's
    // CREATE_USER jobs haven't been processed by the agent yet (transient —
    // retry, or the pending create would bring up a now-unpaid identity) or
    // this subscription was never provisioned at all (permanent — retrying
    // will never find one). Disambiguate via the CREATE_USER jobs'
    // deterministic idempotency_key prefix (enqueueCreateForMembers).
    const { data: createJobs, error: createJobError } = await supabaseAdmin
      .from("provisioning_jobs")
      .select("id")
      .like("idempotency_key", `create-user:${subscriptionId}:%`)
      .limit(1);
    if (createJobError) {
      throw new Error(`provisioning_jobs lookup failed: ${createJobError.message}`);
    }
    if (!createJobs || createJobs.length === 0) {
      console.warn(
        `${eventLabel} for stripe_subscription_id=${subscriptionId} with no VPN identities and no CREATE_USER job ever enqueued — nothing to disable`
      );
      return;
    }
    throw new Error(`no VPN identities for account_id=${accountId} yet`);
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object} subscription - a Stripe Subscription object
 */
export async function handleSubscriptionUpdated(
  supabaseAdmin,
  subscription,
  seatPriceId,
  env = {},
  eventCreatedAt = null
) {
  const periodEndUnix = getSubscriptionPeriodEnd(subscription);
  const currentPeriodEnd =
    typeof periodEndUnix === "number" ? new Date(periodEndUnix * 1000).toISOString() : null;

  const current = await readSubscriptionSyncState(supabaseAdmin, subscription.id);
  if (isStaleSubscriptionWrite(current, eventCreatedAt, subscription.status)) {
    console.warn(
      `customer.subscription.updated for stripe_subscription_id=${subscription.id} is stale or would un-cancel a canceled row — skipping`
    );
    return;
  }
  // Captured now, before the update below — some test doubles (and possibly
  // a real client's row cache) return the same object reference that the
  // update mutates in place, so reading this field lazily after the update
  // would see the NEW value and never detect a renewal.
  const previousPeriodEnd = current?.current_period_end ?? null;

  // F-31/C-04: only trust a base price this deployment actually sells. If
  // the payload names a base item at all AND an allowlist is configured
  // (STRIPE_PRICE_ID), an unrecognized price refuses the whole write rather
  // than silently syncing status/period/seats from an event that could be a
  // dashboard tamper or a stale plan migration — no entitlement is granted
  // or extended off data this deployment cannot vouch for. A payload with no
  // item data (most unit tests, and any event Stripe sends without
  // items expanded) has nothing to validate and is allowed through
  // unchanged — this is a price allowlist, not an "items required" check.
  const basePriceId = getBaseSubscriptionPriceId(subscription, seatPriceId);
  if (basePriceId && env.STRIPE_PRICE_ID && !isAllowedBasePrice(basePriceId, env)) {
    console.error(
      `ALERT: customer.subscription.updated for stripe_subscription_id=${subscription.id} reports base price ${basePriceId}, which is not in the configured allowlist — refusing to sync (no entitlement granted); investigate a possible dashboard price change`
    );
    return;
  }

  const { data: updated, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: subscription.status,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      // Stripe is the source of truth for how many extra devices this
      // subscription pays for (+3 per pack); extra_seats (legacy name) is
      // only a mirror of the pack item's quantity in devices. Every pack
      // change — bought here, or refunded/adjusted in the Stripe dashboard —
      // arrives as this event, so syncing here covers both.
      extra_seats: getExtraSeatCount(subscription, seatPriceId),
      ...(basePriceId ? { stripe_price_id: basePriceId } : {}),
      stripe_synced_at: eventCreatedAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscription.id)
    .select("account_id")
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
  // §6 requires revoking on either. This is the terminal cut (C-04): it
  // enqueues DISABLE_USER unconditionally and immediately, with no grace —
  // grace only ever applies to extending a live subscription's expiry below,
  // never to this branch.
  if (subscription.status === "canceled" || subscription.status === "unpaid") {
    await enqueueDisableForAccount(
      supabaseAdmin,
      updated.account_id,
      subscription.id,
      `customer.subscription.updated (${subscription.status})`,
      env
    );
    return;
  }

  // F-19/C-04: push the new (grace-extended) expiry to devices on this event
  // too, not only on invoice.paid — Stripe finalizes a renewal invoice (and
  // therefore invoice.paid) roughly an hour after the new period already
  // started, and a legacy node enforces `now < expires_at` with no grace of
  // its own. customer.subscription.updated carries the new period end well
  // before that invoice fires.
  //
  // Only push when the period end genuinely moved forward from what this row
  // already had — a same-period event (e.g. a seat-pack quantity change from
  // the dashboard, or cancel_at_period_end being toggled) must not re-push
  // an unchanged expiry as if it were a renewal. If this is the first time
  // the row has ever seen a period end (current?.current_period_end is
  // null — e.g. checkout.session.completed just inserted the row and no
  // invoice.paid has landed yet), invoice.paid remains the authoritative
  // first push; skip here rather than guess.
  const periodAdvanced =
    previousPeriodEnd &&
    currentPeriodEnd &&
    new Date(currentPeriodEnd).getTime() > new Date(previousPeriodEnd).getTime();
  if (periodAdvanced) {
    const entitlement = await getEffectiveEntitlement(supabaseAdmin, updated.account_id);
    if (entitlement) {
      await syncAccountProvisioningToEntitlement(
        supabaseAdmin,
        updated.account_id,
        entitlement,
        `subscription-updated:${subscription.id}`,
        env
      );
    }
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object} subscription - a Stripe Subscription object
 */
export async function handleSubscriptionDeleted(supabaseAdmin, subscription, env = {}, eventCreatedAt = null) {
  const current = await readSubscriptionSyncState(supabaseAdmin, subscription.id);
  // Sticky-canceled never blocks this handler (nextStatus is always
  // "canceled" here), but a timestamp guard still applies: an out-of-order
  // "deleted" that is actually OLDER than a write already recorded (e.g. a
  // very late redelivery arriving after a subsequent event already synced
  // this row) must not stomp current_period_end/extra_seats fields that a
  // newer event may have set — it still only ever needs to ensure status is
  // "canceled", which a prior canceled write has already achieved.
  if (isStaleSubscriptionWrite(current, eventCreatedAt, "canceled")) {
    console.warn(
      `customer.subscription.deleted for stripe_subscription_id=${subscription.id} is stale — skipping write (already synced more recently)`
    );
    if (current?.status === "canceled") return;
  }

  const { data: updated, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: "canceled",
      stripe_synced_at: eventCreatedAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscription.id)
    .select("account_id")
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

  await enqueueDisableForAccount(
    supabaseAdmin,
    updated.account_id,
    subscription.id,
    "customer.subscription.deleted",
    env
  );
}
