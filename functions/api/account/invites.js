import { jsonResponse } from "../../lib/user-auth.js";

/**
 * Invitations are retired. An Arcana account is one person; someone who
 * needs service for others starts another subscription instead (see
 * supabase/migrations/20260926000000_subscription_devices.sql). Members
 * who joined earlier keep working.
 */
export async function onRequestPost() {
  return jsonResponse(
    {
      error: "Arcana accounts are for one person. Start another subscription for family or other devices.",
      code: "invites_retired",
    },
    410
  );
}
