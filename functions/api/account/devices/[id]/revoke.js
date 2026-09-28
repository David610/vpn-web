import { createClient } from "@supabase/supabase-js";
import { requireRecentUser, jsonResponse } from "../../../../lib/user-auth.js";
import { getAccountForUser } from "../../../../lib/accounts.js";
import { revokeDevice, listDeviceIdentities } from "../../../../lib/device-provisioning.js";
import { checkNodeMutationBudget } from "../../../../lib/node-mutation-budget.js";
import { rateLimitedResponse } from "../../../../lib/rate-limit.js";

/**
 * Revokes a device: sets status = 'REVOKED' (+ revoked_at) and enqueues
 * DISABLE_USER for every VPN identity the device has, on the node each one
 * lives on -- the device genuinely loses network access, not just a UI
 * state. Devices are never deleted: the row is the record that this
 * device's access was cut off and when. The account owner may revoke any
 * device on the plan; a member only their own.
 */
export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireRecentUser(request, supabaseAdmin);
  if (!user) return response;

  const deviceId = params.id;

  try {
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`account/devices/:id/revoke: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    const { data: device, error: lookupError } = await supabaseAdmin
      .from("devices")
      .select("id, account_id, user_id, status")
      .eq("id", deviceId)
      .maybeSingle();
    if (lookupError) throw new Error(`devices lookup failed: ${lookupError.message}`);
    if (!device || device.account_id !== account.accountId) {
      return jsonResponse({ error: "Device not found" }, 404);
    }
    // Owners manage every device on the plan; a member only their own.
    if (device.user_id !== user.id && account.role !== "owner") {
      return jsonResponse({ error: "Only the account owner can revoke another member's device." }, 403);
    }

    if (device.status === "REVOKED") {
      return jsonResponse({ error: "This device has already been revoked." }, 409);
    }

    // F-10 (P1): revoking disables every enabled identity on the node it
    // lives on, which restarts sing-box there and drops every open
    // connection on that node -- not just this account's. Budget it per
    // account/node before enqueueing DISABLE_USER
    // (functions/lib/node-mutation-budget.js), same pattern as
    // rotate-credentials.js.
    const identities = await listDeviceIdentities(supabaseAdmin, deviceId);
    const affectedNodeIds = [...new Set(identities.filter((i) => i.enabled).map((i) => i.node_id))];
    for (const nodeId of affectedNodeIds) {
      const withinBudget = await checkNodeMutationBudget(supabaseAdmin, account.accountId, nodeId);
      if (!withinBudget) {
        return rateLimitedResponse("Too many device changes for this account recently. Please try again later.");
      }
    }

    // Real revocation: every VPN identity of this device is disabled on the
    // node it lives on, which removes the credential from sing-box's config.
    const { revoked, disabled } = await revokeDevice(supabaseAdmin, env, device, `device-revoked:${device.id}`, {
      // An owner revoking another member's device is an admin action: rotate now.
      urgent: device.user_id !== user.id,
    });
    if (!revoked) {
      return jsonResponse(
        { error: "Device status changed concurrently — reload and retry" },
        409
      );
    }

    return jsonResponse({ ok: true, disablingIdentities: disabled });
  } catch (err) {
    console.error("account/devices/:id/revoke: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
