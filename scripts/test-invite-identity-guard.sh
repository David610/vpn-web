#!/usr/bin/env bash
set -euo pipefail

DB="arcana_invite_guard_$RANDOM-$RANDOM"
cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo systemctl start postgresql
sudo -u postgres createdb "$DB"

psql_db() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB" "$@"
}

psql_db <<'SQL'
create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz
);

create table public.member_invites (
  id bigint generated always as identity primary key,
  email text not null,
  accepted_at timestamptz,
  accepted_by uuid
);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $$;
SQL

psql_db -f supabase/migrations/20260923200000_invite_identity_guard.sql

psql_db <<'SQL'
insert into auth.users(id,email,email_confirmed_at) values
  ('10000000-0000-4000-8000-000000000001','invited@example.com',now()),
  ('10000000-0000-4000-8000-000000000002','other@example.com',now()),
  ('10000000-0000-4000-8000-000000000003','invited@example.com',null);

insert into public.member_invites(email) values
  ('Invited@Example.com'),
  ('invited@example.com'),
  ('invited@example.com');

do $$
begin
  begin
    update public.member_invites
    set accepted_at = now(),
        accepted_by = '10000000-0000-4000-8000-000000000002'
    where id = 1;
    raise exception 'wrong-email user was incorrectly allowed to accept invite';
  exception
    when others then
      if sqlerrm not like '%invite_email_mismatch%' then
        raise;
      end if;
  end;

  begin
    update public.member_invites
    set accepted_at = now(),
        accepted_by = '10000000-0000-4000-8000-000000000003'
    where id = 2;
    raise exception 'unverified email was incorrectly allowed to accept invite';
  exception
    when others then
      if sqlerrm not like '%invite_email_unverified%' then
        raise;
      end if;
  end;

  update public.member_invites
  set accepted_at = now(),
      accepted_by = '10000000-0000-4000-8000-000000000001'
  where id = 3;

  if not exists (
    select 1
    from public.member_invites
    where id = 3
      and accepted_at is not null
      and accepted_by = '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'confirmed matching user was not allowed to accept invite';
  end if;
end $$;
SQL

echo "invite identity guard PostgreSQL test passed"
