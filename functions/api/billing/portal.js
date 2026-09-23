import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { getAccountForUser } from "../../lib/accounts.js";
import { requireUser, jsonResponse } from "../../lib/user-auth.js";

/**
 * Creates a short-lived Stripe Customer Portal session for the account owner.
 * Members cannot mutate the owner's billing account.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) return jsonResponse({ error: "Account not found" }, 404);
    if (account.role !== "owner") {
      return jsonResponse({ error: "Only the account owner can manage billing." }, 403);
    }

    const { data: accountRow, error } = await supabaseAdmin
      .from("customer_accounts")
      .select("stripe_customer_id")
      .eq("id", account.accountId)
      .maybeSingle();
    if (error) throw new Error(`customer_accounts lookup failed: ${error.message}`);
    if (!accountRow?.stripe_customer_id) {
      return jsonResponse({ error: "No billing account exists yet." }, 404);
    }

    const stripe = new Stripe(env.STRIPE_API_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });
    const session = await stripe.billingPortal.sessions.create({
      customer: accountRow.stripe_customer_id,
      return_url: `${env.SITE_URL}/dashboard/`,
    });

    return jsonResponse({ url: session.url });
  } catch (err) {
    console.error("billing/portal: failed:", err.message);
    return jsonResponse({ error: "Could not open billing management." }, 502);
  }
}
