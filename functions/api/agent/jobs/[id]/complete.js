import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../../../lib/node-auth.js";
import { encryptSecret } from "../../../../lib/crypto.js";
import { finalizeCreatedIdentity, resolveLegacyDeviceForJob } from "../../../../lib/identity-lifecycle.js";

// provisioning_jobs.result is stored in plaintext and is readable by
// service_role/admins (see functions/lib/admin-sanitize.js's redaction,
// which is defense-in-depth, not the primary control). The agent's
// `result` payload can carry the plaintext subscription_url/
// provisioning_url -- those are the secrets vpn_secrets exists to encrypt
// (functions/lib/crypto.js, AES-GCM) and are the ONLY copies customers
// ever read (functions/api/vpn/config.js decrypts vpn_secrets; nothing
// reads provisioning_jobs.result for that purpose). Writing the agent's
// result object verbatim here would put a second, unencrypted copy of the
// same secret next to the encrypted one, defeating the point of encrypting
// it. So only a small, non-secret allowlist is ever persisted -- anything
// else the agent sends in `result` (including any URL/token-shaped field)
// is dropped before this row is written.
const RESULT_ALLOWLIST = ["vpn_user_id"];

function sanitizeStoredResult(result) {
  if (!result || typeof result !== "object") return {};
  const clean = {};
  for (const key of RESULT_ALLOWLIST) {
    if (key in result) clean[key] = result[key];
  }
  // Record only that a credential was reported, never its value.
  if (typeof result.subscription_url === "string") clean.subscription_url_reported = true;
  if (typeof result.provisioning_url === "string") clean.provisioning_url_reported = true;
  return clean;
}

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
    let createdIdentity = null;

    if (job.job_type === "CREATE_USER") {
      const { vpn_user_id, subscription_url } = result;
      if (!vpn_user_id || !subscription_url) {
        throw new Error("CREATE_USER complete missing vpn_user_id/subscription_url");
      }
      // upsert, not insert: a retried completion (same job, same
      // user_id+node_id) must not fail on the unique index.
      // Identities are per (device, node). Jobs enqueued before devices were
      // canonical carry no device_id: attach those to the user's oldest
      // device that has no identity on this node yet.
      const deviceId =
        job.payload.device_id ??
        (await resolveLegacyDeviceForJob(supabaseAdmin, job.payload.user_id, job.node_id));
      const { data: account, error: acctError } = await supabaseAdmin
        .from("vpn_accounts")
        .upsert(
          { user_id: job.payload.user_id, device_id: deviceId, vpn_user_id, node_id: job.node_id },
          { onConflict: "device_id,node_id" }
        )
        .select("id")
        .single();
      if (acctError) throw new Error(`vpn_accounts upsert failed: ${acctError.message}`);
      vpnAccountId = account.id;
      createdIdentity = { id: account.id, deviceId, vpnUserId: vpn_user_id };

      const { ciphertext, nonce } = await encryptSecret(
        subscription_url,
        env.VPN_SECRETS_ENCRYPTION_KEY
      );
      let provisioningSecret = {};
      if (result.provisioning_url) {
        const encrypted = await encryptSecret(
          result.provisioning_url,
          env.VPN_SECRETS_ENCRYPTION_KEY
        );
        provisioningSecret = {
          provisioning_ciphertext: encrypted.ciphertext,
          provisioning_nonce: encrypted.nonce,
        };
      }
      const { error: secretError } = await supabaseAdmin
        .from("vpn_secrets")
        .insert({
          vpn_account_id: vpnAccountId,
          ciphertext,
          nonce,
          ...provisioningSecret,
        });
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
      const { ciphertext, nonce } = await encryptSecret(
        subscription_url,
        env.VPN_SECRETS_ENCRYPTION_KEY
      );
      let provisioningSecret = {};
      if (result.provisioning_url) {
        const encrypted = await encryptSecret(
          result.provisioning_url,
          env.VPN_SECRETS_ENCRYPTION_KEY
        );
        provisioningSecret = {
          provisioning_ciphertext: encrypted.ciphertext,
          provisioning_nonce: encrypted.nonce,
        };
      }
      const { error: secretError } = await supabaseAdmin
        .from("vpn_secrets")
        .insert({
          vpn_account_id: vpnAccountId,
          ciphertext,
          nonce,
          ...provisioningSecret,
        });
      if (secretError) throw new Error(`vpn_secrets insert failed: ${secretError.message}`);
    } else if (job.job_type === "DISABLE_USER" || job.job_type === "ENABLE_USER") {
      if (!vpnAccountId) {
        throw new Error(`${job.job_type} job ${jobId} has no vpn_account_id`);
      }
      const { error: enabledError } = await supabaseAdmin
        .from("vpn_accounts")
        .update({ enabled: job.job_type === "ENABLE_USER" })
        .eq("id", vpnAccountId);
      if (enabledError) throw new Error(`vpn_accounts enabled-update failed: ${enabledError.message}`);
    }
    // SET_EXPIRY: no additional writes here.

    // Must run BEFORE the job is marked done: if it fails, the agent's retry
    // has to re-run it, and a done job short-circuits as a duplicate above.
    if (createdIdentity) {
      await finalizeCreatedIdentity(supabaseAdmin, {
        identity: createdIdentity,
        nodeId: job.node_id,
        userId: job.payload.user_id,
      });
    }

    const { error: updateError } = await supabaseAdmin
      .from("provisioning_jobs")
      .update({
        status: "done",
        completed_at: new Date().toISOString(),
        result: sanitizeStoredResult(result),
        vpn_account_id: vpnAccountId,
      })
      .eq("id", jobId);
    if (updateError) throw new Error(`provisioning_jobs update failed: ${updateError.message}`);

    const { error: resolveAlertError } = await supabaseAdmin
      .from("operational_alerts")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("dedup_key", `job-failed:${jobId}`)
      .eq("status", "open");
    if (resolveAlertError) {
      console.error("agent/complete: failed to resolve prior alert:", resolveAlertError.message);
    }

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
