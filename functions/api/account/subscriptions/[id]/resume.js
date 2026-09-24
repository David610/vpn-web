import { runAccountAction } from "../../../../lib/account-http.js";
import { resumeSubscription } from "../../../../lib/account-service.js";

export const onRequestPost = (context) =>
  runAccountAction(context, "account/subscriptions/:id/resume", (db, user) =>
    resumeSubscription(db, context.env, user, context.params.id)
  );
