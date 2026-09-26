-- route_directory_state holds the signed route directory's monotonic
-- version counter. 20260928000000 created it without RLS, so the public
-- anon/authenticated roles could read and UPDATE/DELETE it through
-- PostgREST. Resetting or inflating the counter lets anyone break every
-- installed client's rollback protection (clients reject any directory
-- whose version is not newer than the highest one they have seen).
-- Only the service role (which bypasses RLS) may touch it.
alter table public.route_directory_state enable row level security;
revoke all on table public.route_directory_state from anon, authenticated;
