#!/usr/bin/env node
/**
 * Installs (or updates) the data-retention heartbeat's daily pg_cron
 * trigger in a Supabase project: pg_cron fires, pg_net POSTs to
 * <SITE_URL>/api/internal/retention-tick with the shared
 * RETENTION_TICK_SECRET (functions/api/internal/retention-tick.js, which
 * calls functions/lib/retention.js's runRetention()).
 *
 * This exists because a prior audit (Phase 11 / F-18 / H-02) flagged that
 * retention pruning code existing is NOT the same as retention pruning
 * actually running: without a cron job wired up the same way
 * scripts/setup-fleet-cron.mjs wires up fleet-tick, retention-tick.js was
 * reachable but never called by anything, and every table it prunes would
 * grow forever exactly as before.
 *
 * Deliberately its own cron job (not folded into fleet-tick's once-a-minute
 * schedule): retention is not time-critical, and a slow retention pass must
 * never delay fleet operation leasing. Runs once a day, which is generous
 * headroom against every table's retention window (the shortest configured
 * default is telegram_link_codes at 1 day -- see functions/lib/retention.js).
 *
 * The URL and secret live in Supabase Vault, not in the cron command text
 * (which is readable in cron.job), so neither is exposed by listing jobs.
 * Idempotent: re-running updates the secrets and the schedule in place.
 *
 * Usage (Supabase Management API; nothing is printed except status):
 *   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... \
 *   SITE_URL=https://example.com RETENTION_TICK_SECRET=... \
 *   node scripts/setup-retention-cron.mjs
 */
const { SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SITE_URL, RETENTION_TICK_SECRET } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SITE_URL, RETENTION_TICK_SECRET })) {
  if (!v) {
    console.error(`${k} is required`);
    process.exit(1);
  }
}
if (!/^[0-9a-f]{32,}$/i.test(RETENTION_TICK_SECRET)) {
  console.error("RETENTION_TICK_SECRET must be a long hex string (openssl rand -hex 32)");
  process.exit(1);
}
const tickUrl = `${new URL(SITE_URL).origin}/api/internal/retention-tick`;

// Dollar-quoted literals with a tag that cannot occur in hex/URL values.
const lit = (v) => {
  if (v.includes("$arcana$")) throw new Error("value contains the quoting tag");
  return `$arcana$${v}$arcana$`;
};

const sql = `
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $do$
begin
  if exists (select 1 from vault.secrets where name = 'retention_tick_url') then
    perform vault.update_secret((select id from vault.secrets where name = 'retention_tick_url'), ${lit(tickUrl)});
  else
    perform vault.create_secret(${lit(tickUrl)}, 'retention_tick_url');
  end if;
  if exists (select 1 from vault.secrets where name = 'retention_tick_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'retention_tick_secret'), ${lit(RETENTION_TICK_SECRET)});
  else
    perform vault.create_secret(${lit(RETENTION_TICK_SECRET)}, 'retention_tick_secret');
  end if;
end
$do$;

select cron.schedule(
  'arcana-retention-tick',
  '17 3 * * *',
  $cmd$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'retention_tick_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Retention-Tick-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'retention_tick_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $cmd$
);
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
if (!res.ok) {
  const body = await res.json().catch(() => ({}));
  console.error(`setup failed: HTTP ${res.status}: ${String(body.message ?? "").slice(0, 300)}`);
  process.exit(1);
}
console.log(`retention heartbeat scheduled daily (03:17 UTC) -> ${tickUrl}`);
