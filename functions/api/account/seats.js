import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { requireRecentUser, jsonResponse } from "../../lib/user-auth.js";
import {
  getAccountForUser,
  getLiveSubscription,
  INCLUDED_SEATS,
} from "../../lib/accounts.js";
import { getSeatSubscriptionItem, getExtraSeatCount } from "../../lib/stripe-fields.js";

/**
 * Upper bound on purchasable seats. Not a business rule so much as a
 * fat-finger guard: a mistyped quantity here bills real money immediately,
 * since Stripe prorates the change on the spot.
 */
const MAX_EXTRA_SEATS = 50;

/**
 * Sets how many seats beyond the included ones the account pays for.
 *
 * Absolute, not a delta: the client sends the total it wants, so a
 * double-submitted request buys one seat rather than two.
 *
 * Stripe is the source of truth for the count. subscriptions.extra_seats is
 * only ever a mirror, written here from Stripe's own response and again by
 * the customer.subscription.updated webhook that the same change triggers —
 * both from the same authority, so they cannot disagree.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireRecentUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    if (!env.STRIPE_SEAT_PRICE_ID) {
      console.error("seats: STRIPE_SEAT_PRICE_ID not configured");
      return jsonResponse({ error: "Extra seats are not available yet." }, 503);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    const quantity = body?.quantity;
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_EXTRA_SEATS) {
      return jsonResponse(
        { error: `Choose between 0 and ${MAX_EXTRA_SEATS} extra seats.` },
        400
      );
    }

    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`seats: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }
    if (account.role !== "owner") {
      return jsonResponse({ error: "Only the account owner can change seats." }, 403);
    }

    const subscription = await getLiveSubscription(
      supabaseAdmin,
      account.accountId,
      "stripe_subscription_id"
    );
    if (!subscription?.stripe_subscription_id) {
      return jsonResponse(
        { error: "You need an active subscription before adding seats." },
        403
      );
    }

    // Releasing a seat someone is sitting in would leave the plan billing
    // for fewer seats than it has people. Make the caller remove the member
    // or withdraw the invite first, rather than silently evicting anyone.
    const nowIso = new Date().toISOString();
    const [{ count: memberCount, error: memberError }, { data: liveInvites, error: inviteError }] =
      await Promise.all([
        supabaseAdmin
          .from("account_members")
          .select("id", { count: "exact", head: true })
          .eq("account_id", account.accountId),
        supabaseAdmin
          .from("member_invites")
          .select("id")
          .eq("account_id", account.accountId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", nowIso),
      ]);
    if (memberError) throw new Error(`account_members count failed: ${memberError.message}`);
    if (inviteError) throw new Error(`member_invites query failed: ${inviteError.message}`);

    const seatsInUse = memberCount + liveInvites.length;
    const minimumExtra = Math.max(0, seatsInUse - INCLUDED_SEATS);
    if (quantity < minimumExtra) {
      return jsonResponse(
        {
          error: `You have ${seatsInUse} seats in use. Remove a member or withdraw an invitation before dropping below ${minimumExtra} extra seats.`,
          code: "seats_in_use",
          minimum: minimumExtra,
        },
        409
      );
    }

    const stripe = new Stripe(env.STRIPE_API_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscription.stripe_subscription_id
    );
    const seatItem = getSeatSubscriptionItem(stripeSubscription, env.STRIPE_SEAT_PRICE_ID);

    let updated;
    if (quantity === 0 && seatItem) {
      // Drop the line item entirely rather than leaving a zero-quantity one:
      // a zero item still shows on the invoice and reads as a mistake.
      updated = await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        items: [{ id: seatItem.id, deleted: true }],
        proration_behavior: "create_prorations",
      });
    } else if (quantity === 0) {
      updated = stripeSubscription; // nothing to do
    } else if (seatItem) {
      updated = await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        items: [{ id: seatItem.id, quantity }],
        proration_behavior: "create_prorations",
      });
    } else {
      updated = await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        items: [{ price: env.STRIPE_SEAT_PRICE_ID, quantity }],
        proration_behavior: "create_prorations",
      });
    }

    const extraSeats = getExtraSeatCount(updated, env.STRIPE_SEAT_PRICE_ID);

    // Mirror immediately so the dashboard reflects the change without
    // waiting on webhook delivery; the webhook writes the same value.
    const { error: syncError } = await supabaseAdmin
      .from("subscriptions")
      .update({ extra_seats: extraSeats, updated_at: new Date().toISOString() })
      .eq("stripe_subscription_id", subscription.stripe_subscription_id);
    if (syncError) {
      // Stripe already charged for this; the webhook will reconcile.
      console.error(`seats: extra_seats mirror failed: ${syncError.message}`);
    }

    return jsonResponse({
      seats: {
        included: INCLUDED_SEATS,
        extra: extraSeats,
        limit: INCLUDED_SEATS + extraSeats,
        used: seatsInUse,
        available: Math.max(0, INCLUDED_SEATS + extraSeats - seatsInUse),
      },
    });
  } catch (err) {
    console.error("seats: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
