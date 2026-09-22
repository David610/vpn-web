-- Atomic seat transitions.
--
-- Accepting an invite is not one write: it validates the invite, counts the
-- seats already taken, detaches the user from the account they are in, joins
-- them to the new one, and marks the invite used. Done as separate PostgREST
-- calls, two people accepting the last seat at the same moment both pass the
-- count and both join, over-committing the plan. Postgres is where that race
-- can actually be closed, so the whole transition lives in one function that
-- locks the target account first.
--
-- SECURITY DEFINER because these tables are revoked from anon/authenticated
-- entirely; only the service-role API routes may call in, and EXECUTE is
-- granted accordingly at the bottom.

-- Seats included in the base price. Mirrored by INCLUDED_SEATS in
-- functions/lib/accounts.js — change both together.
create function public.included_seats()
returns integer
language sql
immutable
set search_path = ''
as $$ select 3 $$;

/**
 * Moves p_user_id onto the account named by a live invite.
 *
 * Raises a named exception rather than returning a status code so any
 * failure aborts the whole transition — a partially applied seat move is
 * worse than a rejected one. The API route maps these onto HTTP responses.
 */
create function public.accept_member_invite(p_token_hash text, p_user_id uuid)
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
  v_extra_seats integer;
begin
  select * into v_invite
  from public.member_invites
  where token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'invite_not_found';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invite_already_accepted';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'invite_revoked';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite_expired';
  end if;

  -- Serialises concurrent acceptances against the same plan: whoever gets
  -- the lock second sees the first one's membership row in the count below.
  perform 1 from public.customer_accounts where id = v_invite.account_id for update;

  select coalesce(max(extra_seats), 0) into v_extra_seats
  from public.subscriptions
  where account_id = v_invite.account_id
    and status in ('trialing', 'active', 'past_due');

  v_seat_limit := public.included_seats() + v_extra_seats;

  select count(*) into v_seats_used
  from public.account_members
  where account_id = v_invite.account_id;

  if v_seats_used >= v_seat_limit then
    raise exception 'seats_full';
  end if;

  select account_id into v_old_account_id
  from public.account_members
  where user_id = p_user_id;

  if v_old_account_id = v_invite.account_id then
    raise exception 'already_member';
  end if;

  if v_old_account_id is not null then
    -- Joining someone else's plan must never silently throw away a plan of
    -- your own, nor strand members who depend on you.
    if exists (
      select 1 from public.subscriptions
      where account_id = v_old_account_id
        and status in ('trialing', 'active', 'past_due')
    ) then
      raise exception 'has_own_subscription';
    end if;

    if (select count(*) from public.account_members where account_id = v_old_account_id) > 1 then
      raise exception 'owns_shared_account';
    end if;

    delete from public.account_members where user_id = p_user_id;

    -- Only tear down an account that never billed anything. One that carries
    -- canceled subscriptions keeps its history; it simply ends up with no
    -- members, which is harmless.
    if not exists (select 1 from public.subscriptions where account_id = v_old_account_id) then
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

/**
 * Detaches a member from an account and gives them a fresh empty account of
 * their own, so "every user has exactly one account" continues to hold.
 *
 * Owners cannot be removed: an account without an owner has nobody to bill,
 * and account_members_owner_uniq would let it stay that way.
 */
create function public.remove_account_member(p_account_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_new_account_id uuid;
begin
  select role into v_role
  from public.account_members
  where account_id = p_account_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'not_a_member';
  end if;
  if v_role = 'owner' then
    raise exception 'cannot_remove_owner';
  end if;

  delete from public.account_members
  where account_id = p_account_id and user_id = p_user_id;

  insert into public.customer_accounts default values
    returning id into v_new_account_id;

  insert into public.account_members (account_id, user_id, role)
  values (v_new_account_id, p_user_id, 'owner');

  return v_new_account_id;
end;
$$;

-- These run as the definer and bypass RLS, so nothing client-facing may
-- reach them; the API routes call in with the service role.
revoke execute on function public.accept_member_invite(text, uuid) from public, anon, authenticated;
revoke execute on function public.remove_account_member(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.included_seats() from public, anon, authenticated;
