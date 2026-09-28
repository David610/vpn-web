-- F-32: supabase/tests/rls_test.sql fails deterministically with "permission
-- denied for table account_members" on devices/connection_profiles/
-- device_profile_assignments. Root cause (category: excess/dead grant, not
-- a missing one):
--
-- 20260924000000_fleet_foundations.sql grants `authenticated` SELECT on
-- devices, connection_profiles and device_profile_assignments, then defines
-- an own-account RLS policy that sub-selects account_members to find the
-- caller's account. But `authenticated` has never been granted any
-- privilege on account_members (by design -- see its own RLS/grants), so
-- evaluating that policy predicate always raises insufficient_privilege
-- instead of returning "no rows". The SELECT grant on the outer table is
-- therefore live but unusable: any authenticated query against these three
-- tables errors out instead of cleanly returning the caller's own rows or a
-- clean "no privilege" the way vpn_secrets/provisioning_jobs/stripe_events/
-- abuse_signals/account_members itself already do (those have NO grant at
-- all to authenticated, so they fail at the grant, not mid-policy).
--
-- No application code path was ever built on browsers reading these three
-- tables directly (functions/ always goes through service_role -- confirmed
-- in the 2026-09-27 audit, section 6.3, which already called these policies
-- "dead code"). So the correct fix is not to open account_members up (that
-- would let any authenticated user enumerate every account's membership
-- rows, a real information disclosure) -- it is to revoke the outer grant
-- that nothing legitimately uses, so these three tables fail closed at the
-- grant level like every other table with no direct-client-read contract,
-- rather than failing mid-query with a confusing cross-table error.
--
-- RLS policies are left in place (harmless once the grant is gone, and
-- documentation of intent if a real direct-read feature is ever built --
-- at which point account_members would need its own narrow own-row grant
-- too, not just re-adding these).

revoke select on public.devices from authenticated;
revoke select on public.connection_profiles from authenticated;
revoke select on public.device_profile_assignments from authenticated;

comment on policy "devices_select_own_account" on public.devices is
  'No longer reachable via PostgREST/direct client (see 20261002000001): '
  'authenticated has no table-level grant. Kept as defense in depth and as '
  'the documented contract for if a direct-read path is ever added.';

comment on policy "connection_profiles_select_own_account" on public.connection_profiles is
  'No longer reachable via PostgREST/direct client (see 20261002000001): '
  'authenticated has no table-level grant. Kept as defense in depth and as '
  'the documented contract for if a direct-read path is ever added.';

comment on policy "device_profile_assignments_select_own_account" on public.device_profile_assignments is
  'No longer reachable via PostgREST/direct client (see 20261002000001): '
  'authenticated has no table-level grant. Kept as defense in depth and as '
  'the documented contract for if a direct-read path is ever added.';
