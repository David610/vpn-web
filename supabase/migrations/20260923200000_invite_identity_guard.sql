-- Bind invitation acceptance to the email address the owner actually invited.
-- The invite token remains high-entropy bearer proof, but possession of a
-- forwarded/leaked link is no longer enough for a different signed-in account.
-- Enforce this at the table transition so every service-role code path,
-- including accept_member_invite(), is covered inside the same transaction.

create or replace function public.enforce_member_invite_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_confirmed_at timestamptz;
begin
  if new.accepted_at is not null and old.accepted_at is null then
    if new.accepted_by is null then
      raise exception 'invite_acceptor_missing';
    end if;

    select u.email, u.email_confirmed_at
      into v_email, v_confirmed_at
    from auth.users u
    where u.id = new.accepted_by;

    if not found or v_email is null then
      raise exception 'invite_acceptor_missing';
    end if;

    if v_confirmed_at is null then
      raise exception 'invite_email_unverified';
    end if;

    if lower(v_email) <> lower(new.email) then
      raise exception 'invite_email_mismatch';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_member_invite_identity()
  from public, anon, authenticated;

drop trigger if exists member_invite_identity_guard on public.member_invites;
create trigger member_invite_identity_guard
  before update of accepted_at, accepted_by on public.member_invites
  for each row
  execute function public.enforce_member_invite_identity();
