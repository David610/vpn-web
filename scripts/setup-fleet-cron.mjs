#!/usr/bin/env node
/**
 * Installs (or updates) the fleet reconciler's once-a-minute trigger in a
 * Supabase project: pg_cron fires, pg_net POSTs to
 * <SITE_URL>/api/internal/fleet-tick with the shared FLEET_TICK_SECRET.
 *
 * The URL and secret live in Supabase Vault, not in the cron command text
 * (which is readable in cron.job), so neither is exposed by listing jobs.
 * Idempotent: re-running updates the secrets and the schedule in place.
 *
 * Usage (Supabase Management API; nothing is printed except status):
 *   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... \
 *   SITE_URL=https://example.com FLEET_TICK_SECRET=... \
 *   node scripts/setup-fleet-cron.mjs
 */
const { SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SITE_URL, FLEET_TICK_SECRET } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SITE_URL, FLEET_TICK_SECRET })) {
  if (!v) {
    console.error(`${k} is required`);
    process.exit(1);
  }
}
if (!/^[0-9a-f]{32,}$/i.test(FLEET_TICK_SECRET)) {
  console.error("FLEET_TICK_SECRET must be a long hex string (openssl rand -hex 32)");
  process.exit(1);
}
const tickUrl = `${new URL(SITE_URL).origin}/api/internal/fleet-tick`;

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
  if exists (select 1 from vault.secrets where name = 'fleet_tick_url') then
    perform vault.update_secret((select id from vault.secrets where name = 'fleet_tick_url'), ${lit(tickUrl)});
  else
    perform vault.create_secret(${lit(tickUrl)}, 'fleet_tick_url');
  end if;
  if exists (select 1 from vault.secrets where name = 'fleet_tick_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'fleet_tick_secret'), ${lit(FLEET_TICK_SECRET)});
  else
    perform vault.create_secret(${lit(FLEET_TICK_SECRET)}, 'fleet_tick_secret');
  end if;
end
$do$;

select cron.schedule(
  'arcana-fleet-tick',
  '* * * * *',
  $cmd$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'fleet_tick_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Fleet-Tick-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'fleet_tick_secret')
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
console.log(`fleet reconciler scheduled every minute -> ${tickUrl}`);
