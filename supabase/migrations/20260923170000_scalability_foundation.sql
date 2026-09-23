-- Scalability foundation for hundreds of concurrent users.
-- Keep auth.users behind Supabase Auth, but denormalize the small amount of
-- directory data the control plane needs into public.profiles so hot paths
-- never need auth.admin.listUsers().

alter table public.profiles
  add column if not exists email text;

update public.profiles p
set email = u.email
from auth.users u
where u.id = p.id
  and p.email is distinct from u.email;

create index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));

create index if not exists subscriptions_account_created_idx
  on public.subscriptions (account_id, created_at desc);

create index if not exists vpn_accounts_user_created_idx
  on public.vpn_accounts (user_id, created_at desc);

create index if not exists provisioning_jobs_node_status_created_idx
  on public.provisioning_jobs (node_id, status, created_at);

-- New users already get both a profile and account. Keep the profile email
-- in the same atomic trigger so account/member reads can join cheaply.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_account_id uuid;
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);

  insert into public.customer_accounts default values
    returning id into new_account_id;

  insert into public.account_members (account_id, user_id, role)
  values (new_account_id, new.id, 'owner');

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set email = new.email
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.sync_profile_email();

revoke execute on function public.sync_profile_email() from public, anon, authenticated;

-- One server-side page replaces four full-table reads plus a GoTrue admin
-- listUsers call. Only service_role may execute it.
create or replace function public.admin_customer_directory(
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  account_id uuid,
  account_role text,
  member_count bigint,
  email text,
  subscription_status text,
  current_period_end timestamptz,
  vpn_account_id bigint,
  vpn_user_id text,
  node_id text,
  enabled boolean,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with member_counts as (
    select m.account_id, count(*)::bigint as member_count
    from public.account_members m
    group by m.account_id
  ),
  directory as (
    select
      m.user_id,
      m.account_id,
      m.role as account_role,
      mc.member_count,
      p.email,
      s.status as subscription_status,
      s.current_period_end,
      v.id as vpn_account_id,
      v.vpn_user_id,
      v.node_id,
      v.enabled
    from public.account_members m
    join member_counts mc on mc.account_id = m.account_id
    left join public.profiles p on p.id = m.user_id
    left join lateral (
      select s1.status, s1.current_period_end
      from public.subscriptions s1
      where s1.account_id = m.account_id
      order by s1.created_at desc
      limit 1
    ) s on true
    left join lateral (
      select v1.id, v1.vpn_user_id, v1.node_id, v1.enabled
      from public.vpn_accounts v1
      where v1.user_id = m.user_id
      order by v1.created_at desc
      limit 1
    ) v on true
    where
      nullif(trim(coalesce(p_query, '')), '') is null
      or lower(coalesce(p.email, '')) like '%' || lower(trim(p_query)) || '%'
      or m.user_id::text ilike '%' || trim(p_query) || '%'
      or lower(coalesce(v.vpn_user_id, '')) like '%' || lower(trim(p_query)) || '%'
  )
  select
    d.user_id,
    d.account_id,
    d.account_role,
    d.member_count,
    d.email,
    d.subscription_status,
    d.current_period_end,
    d.vpn_account_id,
    d.vpn_user_id,
    d.node_id,
    d.enabled,
    count(*) over()::bigint as total_count
  from directory d
  order by lower(coalesce(d.email, '')) asc, d.user_id asc
  limit greatest(1, least(coalesce(p_limit, 50), 100))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.admin_customer_directory(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_customer_directory(text, integer, integer)
  to service_role;

-- Aggregate usage inside Postgres. This avoids shipping up to ~744 hourly
-- rows per user/month to a Worker just to sum two integers.
create or replace function public.vpn_usage_month_total(
  p_vpn_account_id bigint,
  p_month_start timestamptz
)
returns table (
  download_bytes bigint,
  upload_bytes bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum(h.download_bytes), 0)::bigint as download_bytes,
    coalesce(sum(h.upload_bytes), 0)::bigint as upload_bytes
  from public.vpn_usage_hourly h
  where h.vpn_account_id = p_vpn_account_id
    and h.hour >= p_month_start;
$$;

revoke all on function public.vpn_usage_month_total(bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.vpn_usage_month_total(bigint, timestamptz)
  to service_role;
