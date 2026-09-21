import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../../../lib/node-auth.js";
import { encryptSecret } from "../../../../lib/crypto.js";

// Cross-repo idempotency contract (for the provisioning agent in the
// sibling singbox-vpn repo): on a 5xx response from this endpoint, the
// agent MUST retry POST /complete again — never fall back to POST
// /fail. A 5xx can happen after the DB writes below already succeeded
// but before the response was sent, so calling /fail instead would
// regress an already-`done` job back to `failed` (see the terminal-
// status guard in fail.js, which exists specifically to make a retried
// /complete-then-/fail sequence a safe no-op, not to make it correct
// to call /fail here in the first place).
export async function onRequestPost({ env, request, params }) {
  const jobId = params.id;
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const result = body?.result ?? {};

  try {
    const { data: job, error: jobError } = await supabaseAdmin
      .from("provisioning_jobs")
      .select("id, job_type, payload, vpn_account_id, node_id, status")
      .eq("id", jobId)
      .maybeSingle();
    if (jobError) {
      console.error("agent/complete: job lookup failed:", jobError.message);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!job || job.node_id !== nodeId) {
      return new Response(JSON.stringify({ error: "Job not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (job.status === "done") {
      // Duplicate report (agent retried a request whose response it
      // never saw) — idempotent no-op, not an error.
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let vpnAccountId = job.vpn_account_id;

    if (job.job_type === "CREATE_USER") {
      const { vpn_user_id, subscription_url } = result;
      if (!vpn_user_id || !subscription_url) {
        throw new Error("CREATE_USER complete missing vpn_user_id/subscription_url");
      }
      // upsert, not insert: a retried completion (same job, same
      // user_id+node_id) must not fail on the unique index.
      const { data: account, error: acctError } = await supabaseAdmin
        .from("vpn_accounts")
        .upsert(
          { user_id: job.payload.user_id, vpn_user_id, node_id: job.node_id },
          { onConflict: "user_id,node_id" }
        )
        .select("id")
        .single();
      if (acctError) throw new Error(`vpn_accounts upsert failed: ${acctError.message}`);
      vpnAccountId = account.id;

      const { ciphertext, nonce } = await encryptSecret(subscription_url, env.VPN_SECRETS_ENCRYPTION_KEY);
      const { error: secretError } = await supabaseAdmin
        .from("vpn_secrets")
        .insert({ vpn_account_id: vpnAccountId, ciphertext, nonce });
      if (secretError) throw new Error(`vpn_secrets insert failed: ${secretError.message}`);
    } else if (job.job_type === "ROTATE_SUBSCRIPTION_TOKEN") {
      const { subscription_url } = result;
      if (!subscription_url) {
        throw new Error("ROTATE_SUBSCRIPTION_TOKEN complete missing subscription_url");
      }
      if (!vpnAccountId) {
        throw new Error(`ROTATE_SUBSCRIPTION_TOKEN job ${jobId} has no vpn_account_id`);
      }
      // Append-only: old ciphertext rows are left in place on purpose
      // (an append-only secret history costs nothing and means a bug
      // here can't silently destroy the only working config).
      const { ciphertext, nonce } = await encryptSecret(subscription_url, env.VPN_SECRETS_ENCRYPTION_KEY);
      const { error: secretError } = await supabaseAdmin
        .from("vpn_secrets")
        .insert({ vpn_account_id: vpnAccountId, ciphertext, nonce });
      if (secretError) throw new Error(`vpn_secrets insert failed: ${secretError.message}`);
    }
    // SET_EXPIRY / ENABLE_USER / DISABLE_USER: no additional writes here.

    const { error: updateError } = await supabaseAdmin
      .from("provisioning_jobs")
      .update({
        status: "done",
        completed_at: new Date().toISOString(),
        result,
        vpn_account_id: vpnAccountId,
      })
      .eq("id", jobId);
    if (updateError) throw new Error(`provisioning_jobs update failed: ${updateError.message}`);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`agent/complete: failed for job ${jobId}:`, err.message);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
