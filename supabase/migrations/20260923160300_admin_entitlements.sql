-- Admin-granted service access is intentionally separate from Stripe billing.
-- It must never appear as paid revenue, but it is a real entitlement that can
-- provision VPN access and define a seat limit.

create table public.admin_entitlements (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.customer_accounts (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'revoked')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  seat_limit integer not null default 3 check (seat_limit >= 1 and seat_limit <= 53),
  reason text not null check (char_length(reason) between 1 and 500),
  created_by_admin uuid not null references auth.users (id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at),
  check ((status = 'revoked') = (revoked_at is not null))
);

create index admin_entitlements_account_idx
  on public.admin_entitlements (account_id, status, expires_at);

alter table public.admin_entitlements enable row level security;
revoke all on public.admin_entitlements from anon, authenticated;

-- One source of truth for the seat cap enforced inside the invite-acceptance
-- transaction. If Stripe and a support grant coexist, keep the larger valid
-- capacity so granting support access can never silently evict a paid seat.
create function public.effective_seat_limit(p_account_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    public.included_seats(),
    coalesce((
      select max(public.included_seats() + s.extra_seats)
      from public.subscriptions s
      where s.account_id = p_account_id
        and s.status in ('trialing', 'active', 'past_due')
    ), 0),
    coalesce((
      select max(e.seat_limit)
      from public.admin_entitlements e
      where e.account_id = p_account_id
        and e.status = 'active'
        and e.starts_at <= now()
        and (e.expires_at is null or e.expires_at > now())
    ), 0)
  )::integer
$$;

revoke execute on function public.effective_seat_limit(uuid)
  from public, anon, authenticated;

-- Replace the invite transition so its under-lock seat check uses the same
-- effective entitlement as the API. The rest of the atomic transition is
-- deliberately identical to the previous migration.
create or replace function public.accept_member_invite(p_token_hash text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.member_invites;
  v_old_account_id uuid;
  v_seats_used integer;
  v_seat_limit integer;
begin
  select * into v_invite
  from public.member_invites
  where token_hash = p_token_hash
  for update;

  if not found then raise exception 'invite_not_found'; end if;
  if v_invite.accepted_at is not null then raise exception 'invite_already_accepted'; end if;
  if v_invite.revoked_at is not null then raise exception 'invite_revoked'; end if;
  if v_invite.expires_at <= now() then raise exception 'invite_expired'; end if;

  perform 1 from public.customer_accounts
  where id = v_invite.account_id
  for update;

  v_seat_limit := public.effective_seat_limit(v_invite.account_id);

  select count(*) into v_seats_used
  from public.account_members
  where account_id = v_invite.account_id;

  if v_seats_used >= v_seat_limit then raise exception 'seats_full'; end if;

  select account_id into v_old_account_id
  from public.account_members
  where user_id = p_user_id;

  if v_old_account_id = v_invite.account_id then raise exception 'already_member'; end if;

  if v_old_account_id is not null then
    if exists (
      select 1 from public.subscriptions
      where account_id = v_old_account_id
        and status in ('trialing', 'active', 'past_due')
    ) or exists (
      select 1 from public.admin_entitlements
      where account_id = v_old_account_id
        and status = 'active'
        and starts_at <= now()
        and (expires_at is null or expires_at > now())
    ) then
      raise exception 'has_own_subscription';
    end if;

    if (select count(*) from public.account_members where account_id = v_old_account_id) > 1 then
      raise exception 'owns_shared_account';
    end if;

    delete from public.account_members where user_id = p_user_id;

    if not exists (select 1 from public.subscriptions where account_id = v_old_account_id)
       and not exists (select 1 from public.admin_entitlements where account_id = v_old_account_id) then
      delete from public.customer_accounts where id = v_old_account_id;
    end if;
  end if;

  insert into public.account_members (account_id, user_id, role)
  values (v_invite.account_id, p_user_id, 'member');

  update public.member_invites
  set accepted_at = now(), accepted_by = p_user_id
  where id = v_invite.id;

  return v_invite.account_id;
end;
$$;

revoke execute on function public.accept_member_invite(text, uuid)
  from public, anon, authenticated;

revoke all on all sequences in schema public from anon, authenticated;
