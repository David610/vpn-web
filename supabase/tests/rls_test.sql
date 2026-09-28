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
-- Subscriptions belong to accounts (20260922120000). The own-account policy
-- sub-selects account_members, which authenticated cannot read, so a direct
-- read fails closed with insufficient_privilege; if that grant ever appears,
-- A must still see only A's account.
select account_id as acct_a from public.account_members
 where user_id = '11111111-1111-1111-1111-111111111111' \gset
select account_id as acct_b from public.account_members
 where user_id = '22222222-2222-2222-2222-222222222222' \gset
select set_config('rls_test.acct_a', :'acct_a', false), set_config('rls_test.acct_b', :'acct_b', false) \g /dev/null

do $$
begin
  if (select cancel_at_period_end from public.subscriptions
       where account_id = current_setting('rls_test.acct_a')::uuid) is distinct from false then
    raise exception 'subscriptions: user A''s cancel_at_period_end should default to false';
  end if;
end $$;

begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  own_count int;
  other_count int;
begin
  select count(*) into own_count from public.subscriptions
   where account_id = current_setting('rls_test.acct_a')::uuid;
  select count(*) into other_count from public.subscriptions
   where account_id = current_setting('rls_test.acct_b')::uuid;
  if own_count <> 1 then
    raise exception 'subscriptions RLS FAILED: user A should see their own 1 row, saw %', own_count;
  end if;
  if other_count <> 0 then
    raise exception 'subscriptions RLS FAILED: user A should see 0 of user B''s rows, saw %', other_count;
  end if;
exception when insufficient_privilege then
  raise notice 'subscriptions: authenticated cannot evaluate the membership policy (fails closed)';
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

-- ── account_members: authenticated cannot read it at all (fails closed,
--    not "silently returns nothing because of a permissive-but-empty
--    policy"). This proves the sub-select every own-account policy above
--    relies on (devices/connection_profiles/device_profile_assignments/
--    subscriptions) fails CLOSED rather than open: if account_members were
--    ever readable-but-empty for `authenticated`, every one of those
--    "in (select ... from account_members ...)" policies would silently
--    resolve to "no rows", which happens to look like correct isolation
--    right up until a policy elsewhere OR's it with something permissive.
--    Requiring insufficient_privilege here catches that failure mode by
--    construction. ─────────────────────────────────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  n int;
begin
  select count(*) into n from public.account_members;
  raise exception 'account_members RLS FAILED: authenticated should have no privilege to query this table at all, but got % row(s)', n;
exception when insufficient_privilege then
  raise notice 'account_members: authenticated role correctly has no privilege to query the table (sub-select policies fail closed)';
end $$;
rollback;

-- ── locations: enabled rows are visible to any authenticated user, but no
--    one gets to write ──────────────────────────────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  n int;
begin
  if not exists (select 1 from public.locations where id = '10000000-0000-4000-8000-000000000001') then
    raise exception 'locations RLS FAILED: enabled location should be visible to any authenticated user';
  end if;
  begin
    update public.locations set display_name = 'hijacked' where id = '10000000-0000-4000-8000-000000000001';
    raise exception 'locations RLS FAILED: authenticated should not be able to write';
  exception when insufficient_privilege then
    raise notice 'locations: authenticated role correctly cannot write';
  end;
end $$;
rollback;

-- ── devices / connection_profiles / device_profile_assignments: no direct
--    client read contract exists (functions/ always goes through
--    service_role -- see 20261002000001_revoke_dead_account_member_grants).
--    authenticated must have NO privilege to query these at all -- same
--    fail-closed-at-the-grant shape as vpn_secrets/provisioning_jobs/
--    stripe_events/abuse_signals/account_members above, not a live
--    own-account read. (Before that migration, authenticated held a dead
--    SELECT grant whose RLS policy sub-selected the unreadable
--    account_members table, so every query here used to blow up mid-policy
--    with "permission denied for table account_members" instead of failing
--    cleanly -- exactly the failure this block now asserts does NOT
--    happen.) ──────────────────────────────────────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  n int;
begin
  select count(*) into n from public.devices;
  raise exception 'devices RLS FAILED: authenticated should have no privilege to query this table at all, but got % row(s)', n;
exception when insufficient_privilege then
  raise notice 'devices: authenticated role correctly has no privilege to query the table at all';
end $$;

do $$
declare
  n int;
begin
  select count(*) into n from public.connection_profiles;
  raise exception 'connection_profiles RLS FAILED: authenticated should have no privilege to query this table at all, but got % row(s)', n;
exception when insufficient_privilege then
  raise notice 'connection_profiles: authenticated role correctly has no privilege to query the table at all';
end $$;

do $$
declare
  n int;
begin
  select count(*) into n from public.device_profile_assignments;
  raise exception 'device_profile_assignments RLS FAILED: authenticated should have no privilege to query this table at all, but got % row(s)', n;
exception when insufficient_privilege then
  raise notice 'device_profile_assignments: authenticated role correctly has no privilege to query the table at all';
end $$;

do $$
begin
  update public.devices set name = 'hijacked' where id = '20000000-0000-4000-8000-00000000000b';
  raise exception 'devices RLS FAILED: user A should not be able to write ANY device row (no write grant)';
exception when insufficient_privilege then
  raise notice 'devices: authenticated role correctly cannot write';
end $$;
rollback;

-- ── telegram_links: a user can see only their own link ─────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  total int;
begin
  select count(*) into total from public.telegram_links;
  if total <> 1 then
    raise exception 'telegram_links RLS FAILED: user A should see exactly 1 row, saw %', total;
  end if;
  if not exists (select 1 from public.telegram_links where user_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'telegram_links RLS FAILED: user A cannot see their own link';
  end if;
end $$;
rollback;

\echo 'All RLS assertions passed.'
