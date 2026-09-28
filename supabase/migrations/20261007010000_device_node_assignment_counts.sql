-- F-50: functions/api/admin/fleet/{assignments,health}.js both did an
-- unbounded `.select("node_id"[, "hop"])` over device_node_assignments to
-- build a per-node aggregate -- PostgREST's default `max_rows` (1000)
-- silently truncates that once the fleet has more assignments than that,
-- so both the health dashboard's per-node device counts and the
-- assignments page's own aggregate quietly go wrong with no error. A SQL
-- aggregate has no such limit: it returns one row per (node_id, hop), not
-- one row per assignment.
create or replace function public.device_node_assignment_counts()
returns table (node_id text, hop text, count bigint)
language sql
security definer
stable
set search_path = ''
as $$
  select node_id, hop, count(*) as count
  from public.device_node_assignments
  group by node_id, hop;
$$;

revoke all on function public.device_node_assignment_counts() from anon, authenticated, public;
