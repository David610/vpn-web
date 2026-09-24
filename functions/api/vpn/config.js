import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../../lib/crypto.js";
import { requireUser } from "../../lib/user-auth.js";
import { loadCustomerDashboardState } from "../../lib/dashboard-state.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function newestEnabledIdentity(supabaseAdmin, column, value) {
  const { data, error } = await supabaseAdmin
    .from("vpn_accounts")
    .select("id, enabled, vpn_user_id, node_id")
    .eq(column, value)
    .eq("enabled", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`vpn_accounts lookup failed: ${error.message}`);
  return data ? { id: data.id, enabled: data.enabled, vpnUserId: data.vpn_user_id, nodeId: data.node_id } : null;
}

export async function onRequestGet({ env, request }) {
  const noStoreJson = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const state = await loadCustomerDashboardState(supabaseAdmin, user);
    if (!state) return noStoreJson({ error: "No active subscription" }, 403);

    if (!state.entitlement) {
      const reservationFresh =
        state.trial.reservedAt &&
        Date.now() - new Date(state.trial.reservedAt).getTime() < 24 * 60 * 60 * 1000;
      return noStoreJson(
        {
          error: "No active subscription",
          code: "no_subscription",
          trial_available:
            !state.trial.usedAt &&
            (!reservationFresh || Boolean(state.trial.checkoutSessionId)),
        },
        403
      );
    }

    // Per-device config: each device has its own identity (and credential)
    // on the node it is placed on. Without ?deviceId= this stays backward
    // compatible and returns the caller's newest ENABLED identity -- never a
    // disabled one left behind on a node the device moved away from.
    const deviceId = new URL(request.url).searchParams.get("deviceId");
    let vpnAccount;
    if (deviceId) {
      if (!UUID.test(deviceId)) return noStoreJson({ error: "Invalid deviceId" }, 400);
      const { data: device, error: deviceError } = await supabaseAdmin
        .from("devices")
        .select("id, account_id, user_id, status, placement_status, placement_error")
        .eq("id", deviceId)
        .maybeSingle();
      if (deviceError) throw new Error(`devices lookup failed: ${deviceError.message}`);
      if (!device || device.account_id !== state.account.accountId) {
        return noStoreJson({ error: "Device not found" }, 404);
      }
      if (device.user_id !== user.id && state.account.role !== "owner") {
        return noStoreJson({ error: "Device not found" }, 404);
      }
      if (device.status === "REVOKED") return noStoreJson({ error: "This device has been revoked" }, 403);
      if (device.placement_status === "UNSCHEDULABLE") {
        return noStoreJson(
          { error: "No available route for this device", code: "unschedulable", reason: device.placement_error },
          409
        );
      }
      vpnAccount = await newestEnabledIdentity(supabaseAdmin, "device_id", deviceId);
    } else {
      vpnAccount =
        (await newestEnabledIdentity(supabaseAdmin, "user_id", user.id)) ?? state.vpnAccount;
    }
    if (!vpnAccount) return noStoreJson({ error: "Provisioning still in progress" }, 404);
    if (!vpnAccount.enabled) return noStoreJson({ error: "VPN access is disabled" }, 403);

    const { data: secret, error: secretError } = await supabaseAdmin
      .from("vpn_secrets")
      .select("ciphertext, nonce, provisioning_ciphertext, provisioning_nonce")
      .eq("vpn_account_id", vpnAccount.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (secretError) throw new Error(`vpn_secrets lookup failed: ${secretError.message}`);
    if (!secret) return noStoreJson({ error: "Provisioning still in progress" }, 404);

    const subscriptionUrl = await decryptSecret(
      secret.ciphertext,
      secret.nonce,
      env.VPN_SECRETS_ENCRYPTION_KEY
    );

    let provisioningUrl = null;
    if (secret.provisioning_ciphertext && secret.provisioning_nonce) {
      provisioningUrl = await decryptSecret(
        secret.provisioning_ciphertext,
        secret.provisioning_nonce,
        env.VPN_SECRETS_ENCRYPTION_KEY
      );
    }

    return noStoreJson(
      {
        subscription_url: subscriptionUrl,
        provisioning_url: provisioningUrl,
        preferred_setup_url: provisioningUrl ?? subscriptionUrl,
        entitlement_source: state.entitlement.source,
        status: state.entitlement.status,
        current_period_end: state.entitlement.currentPeriodEnd,
        cancel_at_period_end: state.entitlement.cancelAtPeriodEnd,
        account: state.overview,
      },
      200
    );
  } catch (err) {
    console.error("vpn/config: failed:", err.message);
    return noStoreJson({ error: "Internal error" }, 500);
  }
}
