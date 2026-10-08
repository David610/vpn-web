# Telegram Mini App

The Mini App lives at `/telegram/` (static page `src/app/telegram/page.tsx`)
and talks only to `/api/telegram/*`, authenticating every request with the
signed `initData` in the `X-Telegram-Init-Data` header.

- Reads accept `initData` up to 24 hours old.
- Changes (create/move/replace/revoke a link, unlink) **and showing an access
  link** require `initData` signed within the last hour; otherwise the API
  answers `401 { code: "reopen_required" }` and the app asks the user to
  reopen it.
- An unlinked Telegram user gets `403 { code: "not_linked" }` and is shown
  the linking-code form. Codes are created on the website
  (Account → Telegram).
- The Mini App is a **link manager**. It lists every VPN link on the account
  and lets the user copy, create, edit and revoke them. An access link is a
  bearer credential: it is returned only by the create, replace and
  access-link routes, never cached (`no-store`), rate limited per user, and
  never logged. Billing and plan changes happen on the website.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/telegram/links` | every active link, choosable locations, plan card |
| POST | `/api/telegram/links` | `{ name, locationMode: "auto"\|"manual", routeId? }`; returns `configurationUrl` |
| GET/DELETE | `/api/telegram/links/:id` | detail / revoke |
| GET | `/api/telegram/links/:id/access-link` | the link's access URL again |
| POST | `/api/telegram/links/:id/replace` | new access URL; the old one stops working |
| POST | `/api/telegram/links/:id/move` | `{ locationMode, routeId? }`; creates the replacement first, then revokes the old link |
| POST | `/api/telegram/link` | `{ code }` |
| POST | `/api/telegram/unlink` | removes the caller's link |

All handlers go through `runMiniAppAction` (`functions/lib/telegram-mini-app-http.js`)
and reuse the website's link logic (`links-service.js`), so the website and
Telegram behave identically.

The older device and connection-profile routes (`/api/telegram/overview`,
`/profiles`, `/devices`) are no longer used by the Mini App. They are kept
until a cleanup release.

Routing labels: **1 server** (`fast`). **2 servers** (`privacy_plus`) is not
offered to third-party clients yet (see `client-capabilities.js`).
**Automatic** picks a random available location when the link is created.

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
