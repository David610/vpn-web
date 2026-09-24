-- Fleet platform Phase 5: sticky node assignment (spec 54 Phase 5).
--
-- functions/lib/scheduler.js needs somewhere durable to remember "this
-- device was already placed on this node" so repeated scheduling calls for
-- the same device return the same node (sticky assignment) instead of
-- reshuffling on every call. Nothing in the schema captured a device-to-node
-- mapping before this -- device_profile_assignments (Phase 1) pins a device
-- to a routing *policy*, never to a concrete node.
--
-- Purely additive, new table, touches no existing data.
create table public.device_node_assignments (
  device_id uuid primary key references public.devices (id) on delete cascade,
  node_id text not null references public.nodes (node_id),
  assigned_at timestamptz not null default now()
);

create index device_node_assignments_node_id_idx on public.device_node_assignments (node_id);

alter table public.device_node_assignments enable row level security;
revoke all on public.device_node_assignments from anon, authenticated;
