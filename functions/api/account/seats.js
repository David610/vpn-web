import { jsonResponse } from "../../lib/user-auth.js";

/**
 * Retired: capacity is now bought per subscription, in packs of 3 devices —
 * POST /api/account/subscriptions/:id/packs.
 */
export async function onRequestPost() {
  return jsonResponse(
    {
      error: "Add devices to a specific subscription instead.",
      code: "use_subscription_packs",
    },
    410
  );
}
