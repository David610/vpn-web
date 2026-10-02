-- Make-before-break acknowledgement state for compatibility authorization.
-- Route targets express intent; this table records whether the exact opaque
-- credential has actually been observed live by the destination node.
create table public.compatibility_authorization_deployments (
  node_id text not null,
  credential_id text not null,
  desired_revision bigint not null default 1 check (desired_revision > 0),
  applied_revision bigint not null default 0 check (applied_revision >= 0),
  state text not null default 'pending' check (state in ('pending','applied','failed','retired')),
  requested_at timestamptz not null default now(),
  applied_at timestamptz,
  failure_code text check (failure_code is null or char_length(failure_code) <= 80),
  failure_detail text check (failure_detail is null or char_length(failure_detail) <= 500),
  primary key (node_id, credential_id),
  foreign key (node_id, credential_id)
    references public.compatibility_authorizations(node_id, credential_id) on delete cascade
);

alter table public.compatibility_authorization_deployments enable row level security;
revoke all on public.compatibility_authorization_deployments from anon, authenticated;

-- Existing projected authorizations deliberately begin pending. A route is
-- not published merely because this migration observed a projection row.
insert into public.compatibility_authorization_deployments(node_id, credential_id)
select node_id, credential_id from public.compatibility_authorizations;

create function public.project_compatibility_deployment()
returns trigger language plpgsql set search_path = '' as $$
begin
  insert into public.compatibility_authorization_deployments(node_id,credential_id)
    values(new.node_id,new.credential_id)
    on conflict (node_id,credential_id) do update set
      desired_revision=public.compatibility_authorization_deployments.desired_revision+1,
      state='pending',requested_at=now(),applied_at=null,failure_code=null,failure_detail=null;
  return new;
end $$;
create trigger compatibility_authorization_deployment_projection
after insert or update of credential_ciphertext,credential_nonce,valid_until,revoked
on public.compatibility_authorizations for each row
execute function public.project_compatibility_deployment();

create function public.ack_compatibility_authorizations(p_node_id text, p_credential_ids text[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.compatibility_authorization_deployments d set
    applied_revision=d.desired_revision,state='applied',applied_at=now(),
    failure_code=null,failure_detail=null
  where d.node_id=p_node_id and d.credential_id=any(p_credential_ids)
    and exists (select 1 from public.compatibility_authorizations a
      where a.node_id=d.node_id and a.credential_id=d.credential_id
        and not a.revoked and a.valid_until>now());
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.ack_compatibility_authorizations(text,text[]) from public,anon,authenticated;

comment on table public.compatibility_authorization_deployments is
  'Opaque desired/applied authorization state; contains no customer identity or bearer token.';
