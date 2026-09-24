import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../../../lib/user-auth.js";
import { getAccountForUser } from "../../../../lib/accounts.js";

/**
 * Reassigns a device's connection profile — "free" in the billing sense
 * (spec §10): a routing-policy change only, never touches Stripe or seats.
 *
 * device_profile_assignments.device_id is the primary key, so this is an
 * upsert: a device may have at most one active profile. The DB trigger
 * enforce_device_profile_assignment_account (fleet_foundations migration)
 * is the structural guarantee that device and profile share an account,
 * but a raw 23514/trigger exception is not a fit response for an API
 * client, so both sides are checked here first for a clean 400/403.
 */
export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  const deviceId = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const profileId = body?.profileId;
  if (typeof profileId !== "string" || profileId.length === 0) {
    return jsonResponse({ error: "profileId is required" }, 400);
  }

  try {
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`account/devices/:id/assignment: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    const { data: device, error: deviceError } = await supabaseAdmin
      .from("devices")
      .select("id, account_id, status")
      .eq("id", deviceId)
      .maybeSingle();
    if (deviceError) throw new Error(`devices lookup failed: ${deviceError.message}`);
    if (!device || device.account_id !== account.accountId) {
      return jsonResponse({ error: "Device not found" }, 404);
    }
    if (device.status === "REVOKED") {
      return jsonResponse({ error: "Cannot assign a profile to a revoked device." }, 409);
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("connection_profiles")
      .select("id, account_id, enabled")
      .eq("id", profileId)
      .maybeSingle();
    if (profileError) throw new Error(`connection_profiles lookup failed: ${profileError.message}`);
    if (!profile) {
      return jsonResponse({ error: "Connection profile not found" }, 404);
    }
    if (profile.account_id !== account.accountId) {
      // Same cross-account invariant the DB trigger enforces; caught here
      // first for a clean 403 rather than a raised trigger exception.
      return jsonResponse({ error: "That profile does not belong to your account." }, 403);
    }
    if (!profile.enabled) {
      return jsonResponse({ error: "That connection profile is disabled." }, 400);
    }

    const { error: upsertError } = await supabaseAdmin
      .from("device_profile_assignments")
      .upsert(
        { device_id: deviceId, profile_id: profileId, assigned_at: new Date().toISOString() },
        { onConflict: "device_id" }
      );
    if (upsertError) {
      // Defense in depth: if some future code path lets device/profile
      // account ids drift out of sync before this write, the trigger still
      // rejects it — surface that as a 400, not a 500.
      if (upsertError.message.includes("device_profile_account_mismatch")) {
        return jsonResponse({ error: "That profile does not belong to your account." }, 400);
      }
      throw new Error(`device_profile_assignments upsert failed: ${upsertError.message}`);
    }

    return jsonResponse({ ok: true, deviceId, profileId });
  } catch (err) {
    console.error("account/devices/:id/assignment: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
