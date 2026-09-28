-- F-33: node_probe_credentials/node_probe_results carry RLS with no
-- policies (service-role only), but scripts/sql/supabase-bootstrap.sql's
-- `alter default privileges ... grant all on tables/sequences to anon,
-- authenticated` still handed anon/authenticated SELECT/INSERT/UPDATE/
-- DELETE/TRUNCATE/REFERENCES/TRIGGER on both tables (and their identity
-- sequence). RLS blocks row-level DML, but TRUNCATE bypasses RLS entirely
-- (Postgres has no TRUNCATE policy), so an authenticated/anon-signed
-- request could still truncate either table. Revoke explicitly rather
-- than rely on "no policies" to make service-role-only access airtight.
revoke all on table public.node_probe_credentials from anon, authenticated;
revoke all on table public.node_probe_results from anon, authenticated;
revoke all on sequence public.node_probe_results_id_seq from anon, authenticated;

-- Defence in depth: also fix default privileges going forward is out of
-- scope here (bootstrap script mirrors Supabase's own default grants and
-- every other table in this schema relies on that same default + its own
-- RLS policies), but re-assert service_role can still do everything.
grant all on table public.node_probe_credentials to service_role;
grant all on table public.node_probe_results to service_role;
grant all on sequence public.node_probe_results_id_seq to service_role;

-- F-33: harden the 4 SECURITY DEFINER functions that used
-- `set search_path = public`. An empty search_path forces every object
-- reference to be schema-qualified, which closes the classic SECURITY
-- DEFINER search_path hijack (a caller creating a same-named object in a
-- schema earlier in their search_path). lease_fleet_operations,
-- register_node_create_operation and register_node_replace_operation
-- already schema-qualify every reference in their bodies, so a plain
-- ALTER FUNCTION is enough. prune_node_probe_results referenced
-- node_probe_results unqualified, so it is recreated here with
-- schema-qualified references before its search_path is locked down.

alter function public.lease_fleet_operations(integer, integer)
  set search_path = '';

alter function public.register_node_create_operation(
  text, text, uuid, text, text, jsonb, text[], timestamptz)
  set search_path = '';

alter function public.register_node_replace_operation(
  text, text, uuid, text, text, jsonb, text, integer, text[], timestamptz)
  set search_path = '';

create or replace function public.prune_node_probe_results(
  p_target_node_id text, p_keep_hours integer, p_max_rows integer)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.node_probe_results
   where observed_at < now() - make_interval(hours => greatest(p_keep_hours, 1));
  delete from public.node_probe_results
   where target_node_id = p_target_node_id
     and id < coalesce((
       select id from public.node_probe_results
        where target_node_id = p_target_node_id
        order by id desc offset greatest(p_max_rows, 1) - 1 limit 1), 0);
$$;
revoke all on function public.prune_node_probe_results(text, integer, integer) from public, anon, authenticated;
grant execute on function public.prune_node_probe_results(text, integer, integer) to service_role;
