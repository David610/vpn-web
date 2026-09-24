import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../lib/user-auth.js";
import { getAccountForUser } from "../../lib/accounts.js";

/**
 * Lists the caller's account's devices, each annotated with its current
 * connection profile assignment (if any).
 *
 * Read-only, so this uses requireUser() rather than requireRecentUser() —
 * consistent with GET /api/account and other roster-listing endpoints.
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
      .select("id, name, platform, status, created_at, last_seen_at")
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
        (assignments ?? []).map((a) => [
          a.device_id,
          {
            profileId: a.profile_id,
            assignedAt: a.assigned_at,
            profile: profilesById.get(a.profile_id) ?? null,
          },
        ])
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
        assignment: assignmentsByDevice.get(d.id) ?? null,
      })),
    });
  } catch (err) {
    console.error("account/devices: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
