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

  // Only the FIRST delivery for a given subscription id sets status. Once
  // the row exists, invoice.paid / customer.subscription.updated are the
  // sole authoritative writers of status — a redelivered or manually
  // resent checkout.session.completed must never regress an already-
  // advanced subscription (e.g. "active") back to "incomplete".
  const { error: insertError } = await supabaseAdmin.from("subscriptions").insert({
    user_id: userId,
    stripe_customer_id: session.customer,
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
        user_id: userId,
        stripe_customer_id: session.customer,
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
  let vpnAccountId = null;
  let payload;
  if (isFirstInvoice) {
    payload = { user_id: sub.user_id, expires_at: currentPeriodEnd };
  } else {
    // A renewal targets an existing vpn_accounts row — resolve it now so
    // the provisioning agent's job payload carries vpn_user_id directly
    // rather than needing its own Supabase lookup (it has no Supabase
    // credential at all, by design).
    const { data: vpnAccount, error: vpnAccountError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id, vpn_user_id")
      .eq("user_id", sub.user_id)
      .eq("node_id", "node-1")
      .maybeSingle();
    if (vpnAccountError) {
      throw new Error(`vpn_accounts lookup failed: ${vpnAccountError.message}`);
    }
    if (!vpnAccount) {
      // The account's CREATE_USER job hasn't been processed by the agent
      // yet — a real race (Stripe can fire a renewal before the first job
      // is claimed). Unlike the disable handlers' missing-vpn_accounts
      // case, this one has no permanent variant to disambiguate: a
      // renewal invoice only fires for a subscription that already had a
      // successful first invoice (billing_reason=subscription_create), so
      // its CREATE_USER job is always enqueued — the row will eventually
      // exist once the agent processes it. Throw unconditionally so this
      // retries, rather than enqueueing a job with no vpn_user_id to act on.
      throw new Error(`no vpn_accounts row for user_id=${sub.user_id} yet`);
    }
    vpnAccountId = vpnAccount.id;
    payload = { vpn_user_id: vpnAccount.vpn_user_id, expires_at: currentPeriodEnd };
  }

  const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
    idempotency_key: idempotencyKey,
    node_id: "node-1",
    job_type: jobType,
    vpn_account_id: vpnAccountId,
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
    const { data: vpnAccount, error: vpnAccountError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id, vpn_user_id")
      .eq("user_id", updated.user_id)
      .eq("node_id", "node-1")
      .maybeSingle();
    if (vpnAccountError) {
      throw new Error(`vpn_accounts lookup failed: ${vpnAccountError.message}`);
    }
    if (!vpnAccount) {
      // A missing vpn_accounts row is ambiguous on its own: either the
      // account's CREATE_USER job hasn't been processed by the agent yet
      // (transient — retry) or this subscription was never provisioned at
      // all (permanent — no CREATE_USER job was ever enqueued, so retrying
      // will never find a row). Disambiguate via the CREATE_USER job's
      // deterministic idempotency_key, same key shape handleInvoicePaid
      // uses to insert it.
      const { data: createJob, error: createJobError } = await supabaseAdmin
        .from("provisioning_jobs")
        .select("id")
        .eq("idempotency_key", `create-user:${subscription.id}`)
        .maybeSingle();
      if (createJobError) {
        throw new Error(`provisioning_jobs lookup failed: ${createJobError.message}`);
      }
      if (!createJob) {
        // Same "genuinely nothing to disable" reasoning as
        // handleSubscriptionDeleted's !updated early-return: no CREATE_USER
        // job means this subscription was never provisioned. Log for
        // visibility, return cleanly — no retry needed.
        console.warn(
          `customer.subscription.updated (${subscription.status}) for stripe_subscription_id=${subscription.id} with no vpn_accounts row and no CREATE_USER job ever enqueued — nothing to disable`
        );
        return;
      }
      // The CREATE_USER job exists but hasn't produced a vpn_accounts row
      // yet — a real race (Stripe can fire a cancellation before the first
      // job is claimed). Throw so this retries.
      throw new Error(`no vpn_accounts row for user_id=${updated.user_id} yet`);
    }

    const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: `disable-user:${subscription.id}`,
      node_id: "node-1",
      job_type: "DISABLE_USER",
      vpn_account_id: vpnAccount.id,
      payload: {
        vpn_user_id: vpnAccount.vpn_user_id,
        user_id: updated.user_id,
        stripe_subscription_id: subscription.id,
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

  const { data: vpnAccount, error: vpnAccountError } = await supabaseAdmin
    .from("vpn_accounts")
    .select("id, vpn_user_id")
    .eq("user_id", updated.user_id)
    .eq("node_id", "node-1")
    .maybeSingle();
  if (vpnAccountError) {
    throw new Error(`vpn_accounts lookup failed: ${vpnAccountError.message}`);
  }
  if (!vpnAccount) {
    // A missing vpn_accounts row is ambiguous on its own: either the
    // account's CREATE_USER job hasn't been processed by the agent yet
    // (transient — retry) or this subscription was never provisioned at
    // all (permanent — no CREATE_USER job was ever enqueued, so retrying
    // will never find a row, same "genuinely nothing to disable" case as
    // the !updated early-return above). Disambiguate via the CREATE_USER
    // job's deterministic idempotency_key, same key shape handleInvoicePaid
    // uses to insert it.
    const { data: createJob, error: createJobError } = await supabaseAdmin
      .from("provisioning_jobs")
      .select("id")
      .eq("idempotency_key", `create-user:${subscription.id}`)
      .maybeSingle();
    if (createJobError) {
      throw new Error(`provisioning_jobs lookup failed: ${createJobError.message}`);
    }
    if (!createJob) {
      console.warn(
        `customer.subscription.deleted for stripe_subscription_id=${subscription.id} with no vpn_accounts row and no CREATE_USER job ever enqueued — nothing to disable`
      );
      return;
    }
    // The CREATE_USER job exists but hasn't produced a vpn_accounts row
    // yet — a real race (Stripe can fire a deletion before the first job
    // is claimed). Throw so this retries.
    throw new Error(`no vpn_accounts row for user_id=${updated.user_id} yet`);
  }

  const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
    idempotency_key: `disable-user:${subscription.id}`,
    node_id: "node-1",
    job_type: "DISABLE_USER",
    vpn_account_id: vpnAccount.id,
    payload: {
      vpn_user_id: vpnAccount.vpn_user_id,
      user_id: updated.user_id,
      stripe_subscription_id: subscription.id,
    },
  });
  if (jobError && jobError.code !== "23505") {
    throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
  }
}
