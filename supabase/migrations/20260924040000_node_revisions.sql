-- Fleet platform Phase 6: declarative node revisions (spec 54 Phase 6).
--
-- nodes.desired_revision/observed_revision (Phase 1) have existed since the
-- foundations migration but nothing has ever written to them or stored what
-- a given revision number actually means. This table is that: each row is
-- one immutable, ordered snapshot of a node's full desired config. Kept as
-- its own append-only table (not a single jsonb column on nodes) so history
-- survives for rollback/audit -- the same "separate table for async/staged
-- state" house style as fleet_operations/operation_steps (Phase 1), not a
-- new pattern.
create table public.node_revisions (
  id uuid primary key default extensions.gen_random_uuid(),
  node_id text not null references public.nodes (node_id) on delete cascade,
  revision bigint not null,
  config jsonb not null,
  reason text,
  created_by uuid references public.admin_users (user_id),
  created_at timestamptz not null default now()
);

create unique index node_revisions_node_id_revision_uniq
  on public.node_revisions (node_id, revision);

alter table public.node_revisions enable row level security;
revoke all on public.node_revisions from anon, authenticated;

-- APPLY_NODE_REVISION: the 8th provisioning_jobs job type (spec 54 Phase 6).
-- Payload is `{"revision": N}`, deliberately small and stable -- the agent
-- fetches the actual config content via GET /api/agent/revision/:revision,
-- the same "job says what to do, a separate authenticated fetch supplies
-- the content" split claim.js already uses for everything else.
alter table public.provisioning_jobs
  drop constraint provisioning_jobs_job_type_check;

alter table public.provisioning_jobs
  add constraint provisioning_jobs_job_type_check
  check (
    job_type in (
      'CREATE_USER',
      'SET_EXPIRY',
      'CLEAR_EXPIRY',
      'ENABLE_USER',
      'DISABLE_USER',
      'ROTATE_SUBSCRIPTION_TOKEN',
      'ROTATE_CREDENTIALS',
      'APPLY_NODE_REVISION'
    )
  );

-- observed_revision (Phase 1 column, never written before) is reported by
-- the agent's own heartbeat once it has actually applied a revision --
-- see functions/api/agent/heartbeat.js.

-- Enforces the "never more than one pending APPLY_NODE_REVISION job per
-- node" invariant at the database level: functions/lib/node-revisions.js's
-- delete-then-insert coalescing is not itself atomic across two concurrent
-- createNodeRevision() calls for the same node, so without this a race
-- between them could leave two pending rows. The insert then relies on a
-- 23505 from this index as "someone else's concurrent call already has a
-- pending job in flight for this node" and treats that as success, not
-- failure -- one pending job either way satisfies the invariant.
create unique index provisioning_jobs_one_pending_apply_revision_per_node
  on public.provisioning_jobs (node_id)
  where job_type = 'APPLY_NODE_REVISION' and status = 'pending';
