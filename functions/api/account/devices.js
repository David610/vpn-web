import { createClient } from "@supabase/supabase-js";
import { requireUser, requireRecentUser, jsonResponse } from "../../lib/user-auth.js";
import { getAccountForUser, getEffectiveEntitlement } from "../../lib/accounts.js";
import {
  MAX_ACTIVE_DEVICES_PER_MEMBER,
  reconcileDeviceProvisioning,
} from "../../lib/device-provisioning.js";

/**
 * Lists the caller's account's devices, each annotated with its current
 * connection profile assignment (if any).
 *
 * Read-only, so this uses requireUser() rather than requireRecentUser() —
 * consistent with GET /api/account and other roster-listing endpoints.
 *
 * Deliberately carries no per-device traffic/usage figures (Phase 11
 * feasibility spike, see docs/PHASE_11_STATS_FEASIBILITY.md and
 * singbox-vpn's docs/TRAFFIC_ACCOUNTING.md): the official sing-box 1.14.1
 * build has no reliable per-user attribution, so `nodes` traffic totals
 * (functions/api/admin/nodes.js) are the only accounting this platform can
 * stand behind, and they are per-node, not per-device. Do not add a
 * `traffic`/`usage`/`bytes*` field to this response by reusing or dividing
 * up node-level totals — that would misattribute one user's bytes to
 * another's device.
 */
export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`account/devices: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    const { data: devices, error: devicesError } = await supabaseAdmin
      .from("devices")
      .select("id, user_id, name, platform, status, created_at, last_seen_at, placement_status, placement_error")
      .eq("account_id", account.accountId)
      .order("created_at", { ascending: true });
    if (devicesError) throw new Error(`devices lookup failed: ${devicesError.message}`);

    const deviceIds = (devices ?? []).map((d) => d.id);
    let assignmentsByDevice = new Map();
    if (deviceIds.length > 0) {
      const { data: assignments, error: assignmentsError } = await supabaseAdmin
        .from("device_profile_assignments")
        .select("device_id, profile_id, assigned_at")
        .in("device_id", deviceIds);
      if (assignmentsError) {
        throw new Error(`device_profile_assignments lookup failed: ${assignmentsError.message}`);
      }

      const profileIds = [...new Set((assignments ?? []).map((a) => a.profile_id))];
      let profilesById = new Map();
      if (profileIds.length > 0) {
        const { data: profiles, error: profilesError } = await supabaseAdmin
          .from("connection_profiles")
          .select("id, name, routing_mode, enabled")
          .in("id", profileIds);
        if (profilesError) throw new Error(`connection_profiles lookup failed: ${profilesError.message}`);
        profilesById = new Map((profiles ?? []).map((p) => [p.id, p]));
      }

      assignmentsByDevice = new Map(
        (assignments ?? []).map((a) => {
          const profile = profilesById.get(a.profile_id) ?? null;
          return [
            a.device_id,
            {
              profileId: a.profile_id,
              assignedAt: a.assigned_at,
              // camelCase to match GET /api/account/connection-profiles's
              // shape — DevicesCard's Profile type expects routingMode, not
              // the raw column name.
              profile: profile
                ? {
                    id: profile.id,
                    name: profile.name,
                    enabled: profile.enabled,
                    routingMode: profile.routing_mode,
                  }
                : null,
            },
          ];
        })
      );
    }

    return jsonResponse({
      devices: (devices ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        status: d.status,
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        // Owners manage every device on the plan; members only their own.
        mine: d.user_id === user.id,
        manageable: d.user_id === user.id || account.role === "owner",
        // Where the scheduler put it -- or, fail-closed, why it could not.
        placement: { status: d.placement_status, error: d.placement_error ?? null },
        assignment: assignmentsByDevice.get(d.id) ?? null,
      })),
    });
  } catch (err) {
    console.error("account/devices: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}

const DEVICE_NAME = /^[\p{L}\p{N} ._'()-]{1,40}$/u;
const PLATFORMS = new Set(["ios", "android", "macos", "windows", "linux", "router", "other"]);

/**
 * Adds a device for the caller: its own VPN identity (never shared with
 * another device), placed by its connection profile -- or AUTO when none is
 * given. Provisioning starts immediately when the account has access.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { user, response } = await requireRecentUser(request, supabaseAdmin);
  if (!user) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!DEVICE_NAME.test(name)) {
    return jsonResponse({ error: "Device name must be 1-40 letters, digits, spaces or ._'()-" }, 400);
  }
  const platform = body?.platform ?? null;
  if (platform !== null && !PLATFORMS.has(platform)) {
    return jsonResponse({ error: "Unknown platform" }, 400);
  }
  const profileId = body?.profileId ?? null;
  if (profileId !== null && typeof profileId !== "string") {
    return jsonResponse({ error: "profileId must be a string" }, 400);
  }

  try {
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`account/devices POST: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    const { data: mine, error: countError } = await supabaseAdmin
      .from("devices")
      .select("id")
      .eq("account_id", account.accountId)
      .eq("user_id", user.id)
      .eq("status", "ACTIVE");
    if (countError) throw new Error(`devices count failed: ${countError.message}`);
    if ((mine ?? []).length >= MAX_ACTIVE_DEVICES_PER_MEMBER) {
      return jsonResponse(
        { error: `You can have at most ${MAX_ACTIVE_DEVICES_PER_MEMBER} active devices. Revoke one first.` },
        409
      );
    }

    if (profileId) {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from("connection_profiles")
        .select("id, account_id, enabled")
        .eq("id", profileId)
        .maybeSingle();
      if (profileError) throw new Error(`connection_profiles lookup failed: ${profileError.message}`);
      if (!profile || profile.account_id !== account.accountId) {
        return jsonResponse({ error: "Connection profile not found" }, 404);
      }
      if (!profile.enabled) return jsonResponse({ error: "That connection profile is disabled." }, 400);
    }

    const { data: device, error: insertError } = await supabaseAdmin
      .from("devices")
      .insert({ account_id: account.accountId, user_id: user.id, name, platform, status: "ACTIVE" })
      .select("id, account_id, user_id, status")
      .single();
    if (insertError) throw new Error(`devices insert failed: ${insertError.message}`);

    if (profileId) {
      const { error: assignError } = await supabaseAdmin
        .from("device_profile_assignments")
        .insert({ device_id: device.id, profile_id: profileId });
      if (assignError) throw new Error(`device_profile_assignments insert failed: ${assignError.message}`);
    }

    let provisioning = null;
    const entitlement = await getEffectiveEntitlement(supabaseAdmin, account.accountId);
    if (entitlement) {
      const result = await reconcileDeviceProvisioning(supabaseAdmin, env, {
        device,
        entitlement,
        idempotencyPrefix: `device-added:${device.id}`,
      });
      provisioning = {
        action: result.action,
        placement: result.placement?.ok
          ? { status: "PLACED" }
          : result.placement
            ? { status: "UNSCHEDULABLE", error: result.placement.reason }
            : null,
      };
    }

    return jsonResponse({ ok: true, deviceId: device.id, provisioning }, 201);
  } catch (err) {
    console.error("account/devices POST: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
