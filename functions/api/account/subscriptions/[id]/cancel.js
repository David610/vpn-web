import { runAccountAction } from "../../../../lib/account-http.js";
import { cancelSubscription } from "../../../../lib/account-service.js";

/** Cancels at the end of the current period. The account stays. */
export const onRequestPost = (context) =>
  runAccountAction(context, "account/subscriptions/:id/cancel", (db, user) =>
    cancelSubscription(db, context.env, user, context.params.id)
  );
