import { runAccountAction } from "../../lib/account-http.js";
import { getOverview } from "../../lib/account-service.js";

/** Subscriptions, device capacity and devices for the account pages. */
export const onRequestGet = (context) =>
  runAccountAction(
    context,
    "account/overview",
    (db, user, claims) => getOverview(db, user, { sessionId: claims?.session_id ?? null }),
    { recent: false }
  );
