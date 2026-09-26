import { runMiniAppAction } from "../../lib/telegram-mini-app-http.js";
import { unlinkTelegram } from "../../lib/telegram-mini-app-service.js";

export const onRequestPost = (context) =>
  runMiniAppAction(context, "telegram/unlink", unlinkTelegram, { write: true });
