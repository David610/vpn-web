import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { getAccountForUser } from "../lib/accounts.js";
import { requireUser } from "../lib/user-auth.js";

const TRIAL_DAYS = 3;
const TRIAL_RESERVATION_MS = 24 * 60 * 60 * 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function reservationIsFresh(row) {
  if (!row?.trial_reserved_at || row?.trial_used_at) return false;
  const reservedMs = Date.parse(row.trial_reserved_at);
  return Number.isFinite(reservedMs) && Date.now() - reservedMs < TRIAL_RESERVATION_MS;
}

async function clearTrialReservation(
  supabaseAdmin,
  accountId,
  { reservedAt = null, sessionId = null } = {}
) {
  let query = supabaseAdmin
    .from("customer_accounts")
    .update({
      trial_reserved_at: null,
      trial_checkout_session_id: null,
    })
    .eq("id", accountId)
    .is("trial_used_at", null);

  if (reservedAt) query = query.eq("trial_reserved_at", reservedAt);
  if (sessionId) query = query.eq("trial_checkout_session_id", sessionId);

  return query;
}

async function resumeReservedTrial(stripe, supabaseAdmin, accountId, accountRow) {
  if (!reservationIsFresh(accountRow) || !accountRow.trial_checkout_session_id) {
    return { response: null, cleared: false };
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(accountRow.trial_checkout_session_id);
  } catch (err) {
    console.error("create-checkout-session: failed to retrieve reserved Checkout:", err.message);
    return {
      response: json({ error: "Could not resume checkout. Please try again." }, 502),
      cleared: false,
    };
  }

  if (session.status === "open" && session.url) {
    return {
      response: json({ url: session.url, trial: true, resumed: true }),
      cleared: false,
    };
  }

  if (session.status === "complete") {
    return {
      response: json(
        {
          error: "Checkout is already complete. Your subscription is being activated.",
          code: "checkout_complete",
        },
        409
      ),
      cleared: false,
    };
  }

  if (session.status === "expired") {
    const { error } = await clearTrialReservation(supabaseAdmin, accountId, {
      reservedAt: accountRow.trial_reserved_at,
      sessionId: accountRow.trial_checkout_session_id,
    });
    if (error) {
      console.error("create-checkout-session: expired reservation cleanup failed:", error.message);
      return {
        response: json({ error: "Could not restart checkout. Please try again." }, 502),
        cleared: false,
      };
    }
    return { response: null, cleared: true };
  }

  return {
    response: json({ error: "Checkout is not available to resume yet.", code: "trial_starting" }, 409),
    cleared: false,
  };
}

/**
 * Starts either the one-time 3-day trial or an immediately-paid subscription.
 *
 * Body: { trial?: boolean }. Omitted keeps the historical behaviour
 * (trial=true); the dashboard explicitly sends true/false for its two CTAs.
 */
export async function onRequestPost({ env, request }) {
  let wantsTrial = true;
  try {
    const raw = await request.text();
    if (raw) wantsTrial = JSON.parse(raw)?.trial !== false;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  let reservedAt = null;
  let accountId = null;

  try {
    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { user, response } = await requireUser(request, supabaseAdmin);
    if (!user) return response;

    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`create-checkout-session: user ${user.id} has no account_members row`);
      return json({ error: "Something went wrong" }, 500);
    }
    if (account.role !== "owner") {
      return json({ error: "Only the account owner can start or change a subscription." }, 403);
    }
    accountId = account.accountId;

    const recentCutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existingSubscription, error: existingSubError } = await supabaseAdmin
      .from("subscriptions")
      .select("status")
      .eq("account_id", accountId)
      .or(
        `status.in.(trialing,active,past_due),and(status.eq.incomplete,created_at.gt.${recentCutoffIso})`
      )
      .limit(1)
      .maybeSingle();
    if (existingSubError) {
      console.error("create-checkout-session: subscription lookup failed:", existingSubError.message);
      return json({ error: "Something went wrong" }, 500);
    }
    if (existingSubscription) {
      return json({ error: "You already have an active subscription" }, 409);
    }

    const { data: accountRow, error: accountError } = await supabaseAdmin
      .from("customer_accounts")
      .select(
        "stripe_customer_id, trial_used_at, trial_reserved_at, trial_checkout_session_id"
      )
      .eq("id", accountId)
      .maybeSingle();
    if (accountError) throw new Error(`customer_accounts lookup failed: ${accountError.message}`);

    const stripe = new Stripe(env.STRIPE_API_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    if (wantsTrial) {
      const resumed = await resumeReservedTrial(stripe, supabaseAdmin, accountId, accountRow);
      if (resumed.response) return resumed.response;

      const { data: reservation, error: reservationError } = await supabaseAdmin.rpc(
        "reserve_free_trial",
        { p_account_id: accountId }
      );
      if (reservationError) {
        throw new Error(`trial reservation failed: ${reservationError.message}`);
      }

      if (!reservation) {
        // A concurrent request may have acquired the reservation and already
        // attached a Checkout Session. Re-read once so that request becomes
        // resumable instead of looking like a permanently unavailable trial.
        const { data: latestAccount, error: latestError } = await supabaseAdmin
          .from("customer_accounts")
          .select("trial_used_at, trial_reserved_at, trial_checkout_session_id")
          .eq("id", accountId)
          .maybeSingle();
        if (latestError) {
          throw new Error(`trial reservation recheck failed: ${latestError.message}`);
        }

        const concurrent = await resumeReservedTrial(
          stripe,
          supabaseAdmin,
          accountId,
          latestAccount
        );
        if (concurrent.response) return concurrent.response;

        return json(
          {
            error: latestAccount?.trial_used_at
              ? "The free trial has already been used."
              : "The free trial is already being started. Please try again.",
            code: latestAccount?.trial_used_at ? "trial_unavailable" : "trial_starting",
          },
          409
        );
      }
      reservedAt = reservation;
    }

    const checkoutParams = {
      mode: "subscription",
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: user.id,
      success_url: `${env.SITE_URL}/dashboard/?checkout=success`,
      cancel_url: `${env.SITE_URL}/dashboard/?checkout=cancel`,
      ...(wantsTrial ? { subscription_data: { trial_period_days: TRIAL_DAYS } } : {}),
      ...(accountRow?.stripe_customer_id
        ? { customer: accountRow.stripe_customer_id }
        : { customer_email: user.email }),
    };

    let session;
    try {
      session = await stripe.checkout.sessions.create(checkoutParams);
    } catch (err) {
      if (wantsTrial && reservedAt) {
        const { error: releaseError } = await clearTrialReservation(
          supabaseAdmin,
          accountId,
          { reservedAt }
        );
        if (releaseError) {
          console.error(
            "create-checkout-session: trial reservation release failed:",
            releaseError.message
          );
        }
      }
      console.error("create-checkout-session: Stripe error:", err.message);
      return json({ error: "Could not start checkout" }, 502);
    }

    if (wantsTrial) {
      const { data: tracked, error: trackError } = await supabaseAdmin
        .from("customer_accounts")
        .update({ trial_checkout_session_id: session.id })
        .eq("id", accountId)
        .eq("trial_reserved_at", reservedAt)
        .is("trial_used_at", null)
        .select("id")
        .maybeSingle();

      if (trackError || !tracked) {
        console.error(
          "create-checkout-session: failed to attach Checkout to trial reservation:",
          trackError?.message ?? "reservation changed"
        );

        let expired = false;
        try {
          await stripe.checkout.sessions.expire(session.id);
          expired = true;
        } catch (expireError) {
          console.error(
            "create-checkout-session: failed to expire untracked Checkout:",
            expireError.message
          );
        }

        if (expired) {
          const { error: releaseError } = await clearTrialReservation(
            supabaseAdmin,
            accountId,
            { reservedAt }
          );
          if (releaseError) {
            console.error(
              "create-checkout-session: untracked reservation cleanup failed:",
              releaseError.message
            );
          }
        }

        return json({ error: "Could not start checkout" }, 502);
      }
    }

    return json({ url: session.url, trial: wantsTrial, resumed: false });
  } catch (err) {
    console.error("create-checkout-session: unexpected error:", err.message);
    return json({ error: "Something went wrong" }, 500);
  }
}
