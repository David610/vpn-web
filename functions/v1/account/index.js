import { getOverview } from "../../lib/account-service.js";
import { withV1User, v1Json } from "../../lib/v1-http.js";

/** GET /v1/account — subscriptions and devices, in the contract's shape. */
export const onRequestGet = (context) =>
  withV1User(context, "v1/account", async (db, user, sessionId) => {
    const { body } = await getOverview(db, user, { sessionId });
    return v1Json({
      subscriptions: body.subscriptions.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        extra_packs: s.extraPacks,
        renews_at: s.cancelAtPeriodEnd ? null : s.currentPeriodEnd,
        ends_at: s.cancelAtPeriodEnd ? s.currentPeriodEnd : null,
      })),
      devices: body.devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        subscription_id: d.subscriptionId,
        last_seen_at: d.lastSeenAt,
        current: d.current,
      })),
    });
  });
