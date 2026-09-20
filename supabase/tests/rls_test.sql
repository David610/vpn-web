-- Real-Postgres RLS verification. Run with:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql
-- Every assertion RAISEs on failure, which makes psql exit non-zero — a
-- failing assertion fails the whole script, not just prints a warning.
-- This proves RLS is actually enforced by a real Postgres instance, not
-- just present in the policy text.

\set user_a '11111111-1111-1111-1111-111111111111'
\set user_b '22222222-2222-2222-2222-222222222222'

-- ── profiles: a user sees only their own row ──────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  visible_count int;
begin
  select count(*) into visible_count from public.profiles;
  if visible_count <> 1 then
    raise exception 'profiles RLS FAILED: user A should see exactly 1 profile row, saw %', visible_count;
  end if;
  if not exists (select 1 from public.profiles where id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'profiles RLS FAILED: user A cannot see their own profile row';
  end if;
end $$;
rollback;

-- ── subscriptions: user A cannot see user B's row ─────────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  own_count int;
  other_count int;
begin
  select count(*) into own_count from public.subscriptions where user_id = '11111111-1111-1111-1111-111111111111';
  select count(*) into other_count from public.subscriptions where user_id = '22222222-2222-2222-2222-222222222222';
  if own_count <> 1 then
    raise exception 'subscriptions RLS FAILED: user A should see their own 1 row, saw %', own_count;
  end if;
  if other_count <> 0 then
    raise exception 'subscriptions RLS FAILED: user A should see 0 of user B''s rows, saw %', other_count;
  end if;
end $$;
rollback;

-- ── vpn_accounts: same cross-user isolation check ─────────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  total int;
begin
  select count(*) into total from public.vpn_accounts;
  if total <> 1 then
    raise exception 'vpn_accounts RLS FAILED: user A should see exactly 1 row, saw %', total;
  end if;
  if exists (select 1 from public.vpn_accounts where vpn_user_id = 'vpn_user_test_b') then
    raise exception 'vpn_accounts RLS FAILED: user A can see user B''s account';
  end if;
end $$;
rollback;

-- ── vpn_secrets: authenticated role gets ZERO rows, not even their own ─
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  total int;
begin
  select count(*) into total from public.vpn_secrets;
  if total <> 0 then
    raise exception 'vpn_secrets RLS FAILED: authenticated role should see 0 rows (no policy grants access), saw %', total;
  end if;
exception when insufficient_privilege then
  -- REVOKE ALL means authenticated may not even have SELECT privilege to
  -- attempt the query at all, which is an equally valid (in fact stronger)
  -- way for this assertion to be satisfied. See the analogous anon-role
  -- block below.
  raise notice 'vpn_secrets: authenticated role correctly has no privilege to query the table at all';
end $$;
rollback;

-- ── vpn_secrets: anon role also gets nothing ───────────────────────────
begin;
set local role anon;
do $$
declare
  total int;
begin
  select count(*) into total from public.vpn_secrets;
  if total <> 0 then
    raise exception 'vpn_secrets RLS FAILED: anon role should see 0 rows, saw %', total;
  end if;
exception when insufficient_privilege then
  -- REVOKE ALL means anon may not even have SELECT privilege to attempt
  -- the query at all, which is an equally valid (in fact stronger) way
  -- for this assertion to be satisfied.
  raise notice 'vpn_secrets: anon role correctly has no privilege to query the table at all';
end $$;
rollback;

-- ── provisioning_jobs / stripe_events / abuse_signals: same "zero rows
--    for authenticated, zero for anon" shape as vpn_secrets. Each table
--    gets its own begin/rollback + exception handler (rather than one
--    combined DO block) so that REVOKE ALL surfacing as insufficient_
--    privilege on the first table's SELECT can't short-circuit the checks
--    for the other two tables. ───────────────────────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  jobs_count int;
begin
  select count(*) into jobs_count from public.provisioning_jobs;
  if jobs_count <> 0 then
    raise exception 'provisioning_jobs RLS FAILED: authenticated should see 0 rows, saw %', jobs_count;
  end if;
exception when insufficient_privilege then
  raise notice 'provisioning_jobs: authenticated role correctly has no privilege to query the table at all';
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  events_count int;
begin
  select count(*) into events_count from public.stripe_events;
  if events_count <> 0 then
    raise exception 'stripe_events RLS FAILED: authenticated should see 0 rows, saw %', events_count;
  end if;
exception when insufficient_privilege then
  raise notice 'stripe_events: authenticated role correctly has no privilege to query the table at all';
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  abuse_count int;
begin
  select count(*) into abuse_count from public.abuse_signals;
  if abuse_count <> 0 then
    raise exception 'abuse_signals RLS FAILED: authenticated should see 0 rows, saw %', abuse_count;
  end if;
exception when insufficient_privilege then
  raise notice 'abuse_signals: authenticated role correctly has no privilege to query the table at all';
end $$;
rollback;

-- ── service_role bypasses RLS entirely on every table (sanity check that
--    the schema doesn't accidentally block the server-side path too) ────
begin;
set local role service_role;
do $$
declare
  secrets_count int;
  jobs_count int;
begin
  select count(*) into secrets_count from public.vpn_secrets;
  select count(*) into jobs_count from public.provisioning_jobs;
  if secrets_count <> 2 then
    raise exception 'service_role FAILED: should see all 2 vpn_secrets rows, saw %', secrets_count;
  end if;
  if jobs_count <> 2 then
    raise exception 'service_role FAILED: should see all 2 provisioning_jobs rows, saw %', jobs_count;
  end if;
end $$;
rollback;

\echo 'All RLS assertions passed.'
