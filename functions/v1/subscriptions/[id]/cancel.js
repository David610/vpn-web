import { cancelSubscription } from "../../../lib/account-service.js";
import { fromService, withV1User } from "../../../lib/v1-http.js";

/** POST /v1/subscriptions/{id}/cancel — ends at the period end; the account stays. */
export const onRequestPost = (context) =>
  withV1User(context, "v1/subscriptions/:id/cancel", async (db, user) =>
    fromService(await cancelSubscription(db, context.env, user, context.params.id))
  );
