-- Node-scoped, monotonic desired/applied snapshots for compatibility auth.
-- A revision describes the complete desired authorization set for one node.
create table public.compatibility_authorization_node_state (
  node_id text primary key references public.nodes(node_id) on delete cascade,
  desired_revision bigint not null default 0 check (desired_revision >= 0),
  applied_revision bigint not null default 0 check (applied_revision >= 0 and applied_revision <= desired_revision),
  state text not null default 'pending' check (state in ('pending','applied','failed')),
  requested_at timestamptz not null default now(),
  applied_at timestamptz,
  failure_code text check (failure_code is null or char_length(failure_code) <= 80),
  failure_detail text check (failure_detail is null or char_length(failure_detail) <= 500)
);

-- The revision at which this credential first became required by this node.
-- Unrelated later snapshot changes do not make an already-applied credential
-- look pending: publication compares node.applied_revision to this value.
create table public.compatibility_authorization_deployments (
  node_id text not null,
  credential_id text not null,
  required_revision bigint not null check (required_revision > 0),
  requested_at timestamptz not null default now(),
  primary key (node_id, credential_id),
  foreign key (node_id, credential_id)
    references public.compatibility_authorizations(node_id, credential_id) on delete cascade
);

alter table public.compatibility_authorization_node_state enable row level security;
alter table public.compatibility_authorization_deployments enable row level security;
revoke all on public.compatibility_authorization_node_state,
  public.compatibility_authorization_deployments from anon, authenticated;

-- Existing projections become revision 1, but are NOT assumed applied. The
-- application rollout gate keeps legacy publication behavior until v2 agents
-- are deployed and their acknowledgements have been observed.
insert into public.compatibility_authorization_node_state(node_id,desired_revision)
select distinct node_id,1 from public.compatibility_authorizations;
insert into public.compatibility_authorization_deployments(node_id,credential_id,required_revision)
select node_id,credential_id,1 from public.compatibility_authorizations;

create function public.advance_compatibility_authorization_snapshot()
returns trigger language plpgsql set search_path = '' as $$
declare v_node_id text; v_revision bigint;
begin
  if tg_op = 'DELETE' then v_node_id := old.node_id; else v_node_id := new.node_id; end if;
  insert into public.compatibility_authorization_node_state(node_id,desired_revision,state,requested_at)
    values(v_node_id,1,'pending',now())
    on conflict (node_id) do update set
      desired_revision=public.compatibility_authorization_node_state.desired_revision+1,
      state='pending',requested_at=now(),failure_code=null,failure_detail=null
    returning desired_revision into v_revision;
  if tg_op <> 'DELETE' then
    insert into public.compatibility_authorization_deployments(node_id,credential_id,required_revision,requested_at)
      values(new.node_id,new.credential_id,v_revision,now())
      on conflict (node_id,credential_id) do update set
        required_revision=v_revision,requested_at=now();
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger compatibility_authorization_snapshot_insert
  after insert on public.compatibility_authorizations for each row
  execute function public.advance_compatibility_authorization_snapshot();
create trigger compatibility_authorization_snapshot_update
  after update of credential_ciphertext,credential_nonce,valid_from,valid_until,revoked
  on public.compatibility_authorizations for each row
  when (old.* is distinct from new.*)
  execute function public.advance_compatibility_authorization_snapshot();
create trigger compatibility_authorization_snapshot_delete
  after delete on public.compatibility_authorizations for each row
  execute function public.advance_compatibility_authorization_snapshot();

-- Revision and rows are assembled inside one database statement/snapshot.
-- Ciphertext is returned only to authenticated service-role server code and is
-- decrypted there; this function is never granted to a client role.
create function public.get_compatibility_authorization_snapshot(p_node_id text)
returns table(snapshot_revision bigint, authorizations jsonb)
language sql security definer stable set search_path = '' as $$
  select coalesce(s.desired_revision,0), coalesce((
    select jsonb_agg(jsonb_build_object(
      'principal_id',a.principal_id,'credential_id',a.credential_id,
      'class',a.credential_class,'valid_from',a.valid_from,'valid_until',a.valid_until,
      'revoked',a.revoked,'credential_ciphertext',a.credential_ciphertext,
      'credential_nonce',a.credential_nonce) order by a.credential_id)
    from public.compatibility_authorizations a where a.node_id=p_node_id
  ),'[]'::jsonb)
  from (select 1) seed
  left join public.compatibility_authorization_node_state s on s.node_id=p_node_id;
$$;

-- Records exactly the revision the node says it applied. A stale ACK can
-- advance progress, but can never acknowledge a later desired snapshot.
create function public.ack_compatibility_authorization_snapshot(p_node_id text,p_snapshot_revision bigint)
returns table(desired_revision bigint,applied_revision bigint,state text)
language plpgsql security definer set search_path = '' as $$
declare v_state public.compatibility_authorization_node_state;
begin
  if p_snapshot_revision < 0 then raise exception 'invalid_snapshot_revision'; end if;
  insert into public.compatibility_authorization_node_state(node_id)
    values(p_node_id) on conflict (node_id) do nothing;
  select * into v_state from public.compatibility_authorization_node_state
    where node_id=p_node_id for update;
  if p_snapshot_revision > v_state.desired_revision then
    raise exception 'future_snapshot_revision';
  end if;
  if p_snapshot_revision > v_state.applied_revision then
    update public.compatibility_authorization_node_state s set
      applied_revision=p_snapshot_revision,
      state=case when p_snapshot_revision=s.desired_revision then 'applied' else 'pending' end,
      applied_at=now(),failure_code=null,failure_detail=null
      where s.node_id=p_node_id returning s.* into v_state;
  end if;
  return query select v_state.desired_revision,v_state.applied_revision,v_state.state;
end $$;

-- Atomic publication proof used by the subscription gateway.
create function public.get_publishable_compatibility_deployments(p_credential_ids text[])
returns table(node_id text,credential_id text,required_revision bigint,applied_revision bigint)
language sql security definer stable set search_path = '' as $$
  select d.node_id,d.credential_id,d.required_revision,s.applied_revision
  from public.compatibility_authorization_deployments d
  join public.compatibility_authorization_node_state s using(node_id)
  join public.compatibility_authorizations a using(node_id,credential_id)
  where d.credential_id=any(p_credential_ids)
    and s.applied_revision>=d.required_revision and not a.revoked and a.valid_until>now();
$$;

revoke execute on function public.get_compatibility_authorization_snapshot(text) from public,anon,authenticated;
revoke execute on function public.ack_compatibility_authorization_snapshot(text,bigint) from public,anon,authenticated;
revoke execute on function public.get_publishable_compatibility_deployments(text[]) from public,anon,authenticated;

comment on table public.compatibility_authorization_node_state is
  'Opaque node-scoped desired/applied snapshot state; contains no customer identity or bearer token.';
