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
} from "./stripe-fields.js";
import { resolveNodeForUser } from "./resolve-node.js";
import {
  getAccountForUser,
  getAccountMembers,
  getMemberVpnAccounts,
} from "./accounts.js";

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
  // lapsed, which no subscriptions row can supply.
  const { error: customerError } = await supabaseAdmin
    .from("customer_accounts")
    .update({ stripe_customer_id: session.customer })
    .eq("id", account.accountId);
  if (customerError) {
    throw new Error(`customer_accounts update failed: ${customerError.message}`);
  }

  // Only the FIRST delivery for a given subscription id sets status. Once
  // the row exists, invoice.paid / customer.subscription.updated are the
  // sole authoritative writers of status — a redelivered or manually
  // resent checkout.session.completed must never regress an already-
  // advanced subscription (e.g. "active") back to "incomplete".
  const { error: insertError } = await supabaseAdmin.from("subscriptions").insert({
    account_id: account.accountId,
    stripe_subscription_id: session.subscription,
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
  const { data: currentSub, error: currentSubError } = await supabaseAdmin
    .from("subscriptions")
    .select("status")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  if (currentSubError) {
    throw new Error(`subscriptions status read failed: ${currentSubError.message}`);
  }
  const isStaleAfterCancellation = currentSub?.status === "canceled";
  const isFirstInvoiceForUnpaidSubscription =
    currentSub?.status === "unpaid" && invoice.billing_reason === "subscription_create";
  if (isStaleAfterCancellation || isFirstInvoiceForUnpaidSubscription) {
    console.warn(
      `invoice.paid ${invoice.id} for stripe_subscription_id=${subscriptionId} arrived after a newer cancellation (status=${currentSub.status}) — skipping provisioning`
    );
    return;
  }

  const { data: sub, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: "active",
      current_period_end: currentPeriodEnd,
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

  const nodeId = resolveNodeForUser();

  // billing_reason distinguishes a subscription's first invoice from every
  // later renewal — the correct, Stripe-documented signal for this (not
  // "does a provisioning_jobs row already exist", which would need an
  // extra query and race against this same handler's own writes).
  const isFirstInvoice = invoice.billing_reason === "subscription_create";

  if (isFirstInvoice) {
    // At the first invoice the account usually has exactly one member — the
    // owner who just completed Checkout — because seats can only be invited
    // from a billed account. Members who join later are provisioned by the
    // invite-acceptance path, not from here.
    //
    // For a subscription that began as a trial this is a no-op: the trial
    // handler already enqueued these under the same idempotency keys.
    await enqueueCreateForMembers(
      supabaseAdmin,
      sub.account_id,
      subscriptionId,
      currentPeriodEnd
    );
    return;
  }

  // A renewal extends every seat on the account, so it targets each member's
  // existing vpn_accounts row. Resolving them here means the agent's job
  // payload carries vpn_user_id directly rather than needing its own
  // Supabase lookup (it has no Supabase credential at all, by design).
  const vpnAccounts = await getMemberVpnAccounts(supabaseAdmin, sub.account_id, nodeId);
  if (vpnAccounts.length === 0) {
    // The account's CREATE_USER jobs haven't been processed by the agent
    // yet — a real race (Stripe can fire a renewal before the first job is
    // claimed). Unlike the disable handlers' missing-vpn_accounts case,
    // this one has no permanent variant to disambiguate: a renewal invoice
    // only fires for a subscription that already had a successful first
    // invoice (billing_reason=subscription_create), so its CREATE_USER jobs
    // are always enqueued — the rows will eventually exist once the agent
    // processes them. Throw unconditionally so this retries, rather than
    // silently extending nobody's expiry.
    throw new Error(`no vpn_accounts rows for account_id=${sub.account_id} yet`);
  }

  for (const vpnAccount of vpnAccounts) {
    const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: `set-expiry:${subscriptionId}:${currentPeriodEnd}:${vpnAccount.id}`,
      node_id: nodeId,
      job_type: "SET_EXPIRY",
      vpn_account_id: vpnAccount.id,
      payload: { vpn_user_id: vpnAccount.vpnUserId, expires_at: currentPeriodEnd },
    });
    if (jobError && jobError.code !== "23505") {
      throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
    }
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
async function enqueueCreateForMembers(supabaseAdmin, accountId, subscriptionId, expiresAt) {
  const members = await getAccountMembers(supabaseAdmin, accountId);
  if (members.length === 0) {
    throw new Error(`account ${accountId} has no members — cannot provision`);
  }
  const nodeId = resolveNodeForUser();
  for (const member of members) {
    const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
      // Keyed per member, not per subscription: an account provisions one
      // VPN user per seat, so the subscription id alone is not unique enough
      // to make a redelivery a no-op.
      idempotency_key: `create-user:${subscriptionId}:${member.userId}`,
      node_id: nodeId,
      job_type: "CREATE_USER",
      vpn_account_id: null,
      payload: { user_id: member.userId, expires_at: expiresAt },
    });
    if (jobError && jobError.code !== "23505") {
      throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
    }
  }
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
export async function handleSubscriptionTrialing(supabaseAdmin, subscription) {
  const trialEndUnix = subscription.trial_end;
  if (typeof trialEndUnix !== "number") {
    throw new Error(
      `subscription ${subscription.id} is trialing but carries no trial_end`
    );
  }
  const trialEnd = new Date(trialEndUnix * 1000).toISOString();

  const { data: sub, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: "trialing",
      current_period_end: trialEnd,
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

  // Access expires when the trial does. If the customer converts, the
  // invoice for the first real period extends it via SET_EXPIRY; if they do
  // not, it simply lapses, with no separate revocation needed.
  await enqueueCreateForMembers(supabaseAdmin, sub.account_id, subscription.id, trialEnd);
}

/**
 * Enqueues a DISABLE_USER job for every provisioned seat on an account.
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
async function enqueueDisableForAccount(supabaseAdmin, accountId, subscriptionId, eventLabel) {
  const nodeId = resolveNodeForUser();
  const vpnAccounts = await getMemberVpnAccounts(supabaseAdmin, accountId, nodeId);

  if (vpnAccounts.length === 0) {
    // A missing vpn_accounts row is ambiguous on its own: either the
    // account's CREATE_USER job hasn't been processed by the agent yet
    // (transient — retry) or this subscription was never provisioned at all
    // (permanent — retrying will never find a row). Disambiguate via the
    // CREATE_USER job's deterministic idempotency_key prefix, the same shape
    // handleInvoicePaid uses to insert it.
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
        `${eventLabel} for stripe_subscription_id=${subscriptionId} with no vpn_accounts rows and no CREATE_USER job ever enqueued — nothing to disable`
      );
      return;
    }
    throw new Error(`no vpn_accounts rows for account_id=${accountId} yet`);
  }

  for (const vpnAccount of vpnAccounts) {
    const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: `disable-user:${subscriptionId}:${vpnAccount.id}`,
      node_id: nodeId,
      job_type: "DISABLE_USER",
      vpn_account_id: vpnAccount.id,
      payload: {
        vpn_user_id: vpnAccount.vpnUserId,
        user_id: vpnAccount.userId,
        stripe_subscription_id: subscriptionId,
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
export async function handleSubscriptionUpdated(supabaseAdmin, subscription, seatPriceId) {
  const periodEndUnix = getSubscriptionPeriodEnd(subscription);
  const currentPeriodEnd =
    typeof periodEndUnix === "number" ? new Date(periodEndUnix * 1000).toISOString() : null;

  const { data: updated, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: subscription.status,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      // Stripe is the source of truth for how many seats are paid for; this
      // column is only ever a mirror of the per-seat item's quantity. Every
      // seat change — bought here, or refunded/adjusted in the Stripe
      // dashboard — arrives as this event, so syncing here covers both.
      extra_seats: getExtraSeatCount(subscription, seatPriceId),
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
  // §6 requires revoking on either.
  if (subscription.status === "canceled" || subscription.status === "unpaid") {
    await enqueueDisableForAccount(
      supabaseAdmin,
      updated.account_id,
      subscription.id,
      `customer.subscription.updated (${subscription.status})`
    );
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
    "customer.subscription.deleted"
  );
}
