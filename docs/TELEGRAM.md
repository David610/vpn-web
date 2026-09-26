# Telegram Mini App

The Mini App lives at `/telegram/` (static page `src/app/telegram/page.tsx`)
and talks only to `/api/telegram/*`, authenticating every request with the
signed `initData` in the `X-Telegram-Init-Data` header.

- Reads accept `initData` up to 24 hours old.
- Changes (rename/move/remove device, route choice, connections, unlink)
  require `initData` signed within the last hour; otherwise the API answers
  `401 { code: "reopen_required" }` and the app asks the user to reopen it.
- An unlinked Telegram user gets `403 { code: "not_linked" }` and is shown
  the linking-code form. Codes are created on the website
  (Account → Security → Telegram).
- The Mini App never shows the subscription setup URL; device setup and
  billing happen on the website.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/telegram/overview` | subscriptions, capacity, devices (+ route), connections |
| GET/POST | `/api/telegram/profiles` | list / create connection |
| PATCH/DELETE | `/api/telegram/profiles/:id` | update / delete connection |
| PATCH/DELETE | `/api/telegram/devices/:id` | rename / remove device |
| POST | `/api/telegram/devices/:id/move` | `{ subscriptionId }` |
| POST | `/api/telegram/devices/:id/assignment` | `{ profileId }` |
| POST | `/api/telegram/link` | `{ code }` |
| POST | `/api/telegram/unlink` | removes the caller's link |

All handlers go through `runMiniAppAction` (`functions/lib/telegram-mini-app-http.js`)
and reuse the website's services (`account-service.js`,
`connection-profiles.js`, `device-assignment.js`).

Route labels: **Automatic** (`AUTO`), **Fast** = 1 server (`DIRECT`),
**Privacy+** = 2 servers (`DOUBLE_HOP`).

## Setup with BotFather only

1. In Telegram, open **@BotFather** and send `/newbot` (or pick your existing
   bot with `/mybots`). Keep the token secret.
2. Store the token as the `TELEGRAM_BOT_TOKEN` secret of the Cloudflare Pages
   project (Settings → Environment variables, encrypted). Redeploy.
3. `/mybots` → your bot → **Bot Settings** → **Menu Button** →
   **Configure menu button**, send the URL
   `https://arcana-web-epw.pages.dev/telegram/`, then the button text
   `Arcana`.
4. `/setcommands` → your bot → send:
   ```
   start - Open Arcana
   app - Manage devices and connections
   help - How to set up and link your account
   ```
5. Optional: `/newapp` → your bot to register a named Mini App with the same
   URL (gives a `t.me/<bot>/<app>` link).
6. Open the bot, tap **Arcana**, and enter a linking code from the website.

Steps 3–4 can instead be done by `scripts/configure-telegram-bot.mjs`
(`TELEGRAM_BOT_TOKEN=... node scripts/configure-telegram-bot.mjs`), which
calls `getMe`, `setMyCommands` and `setChatMenuButton`.
