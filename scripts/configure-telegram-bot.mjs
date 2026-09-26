#!/usr/bin/env node
// Configures the Arcana Telegram bot for the Mini App:
//   1. getMe            — confirms the token works (prints the bot username)
//   2. setMyCommands    — /start, /app, /help
//   3. setChatMenuButton — the chat's menu button opens the Mini App
//
// Usage:  TELEGRAM_BOT_TOKEN=... node scripts/configure-telegram-bot.mjs
// Optional: MINI_APP_URL (default https://arcana-web-epw.pages.dev/telegram/)
//
// The token is read only from the environment and is never printed.

const token = process.env.TELEGRAM_BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || "https://arcana-web-epw.pages.dev/telegram/";

if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN in the environment.");
  process.exit(1);
}
if (!/^https:\/\//.test(MINI_APP_URL)) {
  console.error("MINI_APP_URL must be an https:// URL.");
  process.exit(1);
}

async function bot(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method} failed: ${data.description ?? res.status}`);
  return data.result;
}

try {
  const me = await bot("getMe");
  console.log(`Bot: @${me.username}`);

  await bot("setMyCommands", {
    commands: [
      { command: "start", description: "Open Arcana" },
      { command: "app", description: "Manage devices and connections" },
      { command: "help", description: "How to set up and link your account" },
    ],
  });
  console.log("Commands set.");

  await bot("setChatMenuButton", {
    menu_button: { type: "web_app", text: "Arcana", web_app: { url: MINI_APP_URL } },
  });
  console.log(`Menu button opens ${MINI_APP_URL}`);
} catch (err) {
  // Error text comes from Telegram and never contains the token.
  console.error(err.message);
  process.exit(1);
}
