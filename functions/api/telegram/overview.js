import { runMiniAppAction } from "../../lib/telegram-mini-app-http.js";
import { getMiniAppOverview } from "../../lib/telegram-mini-app-service.js";

/** Everything the Mini App's single screen shows. */
export const onRequestGet = (context) => runMiniAppAction(context, "telegram/overview", getMiniAppOverview);
