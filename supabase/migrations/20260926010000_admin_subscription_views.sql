-- Admin views for the subscription/device billing model.

create or replace function public.admin_subscription_directory(
  p_query text default null,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  subscription_id bigint,
  account_id uuid,
  owner_user_id uuid,
  owner_email text,
  name text,
  status text,
  cancel_at_period_end boolean,
  current_period_end timestamptz,
  extra_seats integer,
  device_capacity integer,
  active_devices bigint,
  stripe_subscription_id text,
  created_at timestamptz,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select
      s.id,
      s.account_id,
      owner.user_id as owner_user_id,
      p.email as owner_email,
      s.name,
      s.status,
      coalesce(s.cancel_at_period_end, false) as cancel_at_period_end,
      s.current_period_end,
      coalesce(s.extra_seats, 0) as extra_seats,
      3 + coalesce(s.extra_seats, 0) as device_capacity,
      (select count(*) from public.devices d
        where d.subscription_id = s.id and d.status = 'ACTIVE') as active_devices,
      s.stripe_subscription_id,
      s.created_at
    from public.subscriptions s
    left join lateral (
      select m.user_id from public.account_members m
       where m.account_id = s.account_id
       order by (m.role = 'owner') desc
       limit 1
    ) owner on true
    left join public.profiles p on p.id = owner.user_id
    where (p_status is null or s.status = p_status)
      and (
        p_query is null
        or lower(coalesce(p.email, '')) like '%' || lower(p_query) || '%'
        or lower(s.name) like '%' || lower(p_query) || '%'
        or s.stripe_subscription_id = p_query
      )
  )
  select b.*, count(*) over () as total_count
    from base b
   order by b.created_at desc
   limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset);
$$;

revoke all on function public.admin_subscription_directory(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_subscription_directory(text, text, integer, integer)
  to service_role;

-- Device-model counters for the admin overview. Real counts only.
create or replace function public.admin_device_model_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with live as (
    select * from public.subscriptions
     where status in ('trialing', 'active', 'past_due')
  ),
  per_sub as (
    select l.id, 3 + coalesce(l.extra_seats, 0) as capacity,
           (select count(*) from public.devices d
             where d.subscription_id = l.id and d.status = 'ACTIVE') as used
      from live l
  )
  select jsonb_build_object(
    'subscriptions', jsonb_build_object(
      'live', (select count(*) from live),
      'cancelling', (select count(*) from live where cancel_at_period_end),
      'extra_packs', (select coalesce(sum(coalesce(extra_seats, 0) / 3), 0) from live),
      'accounts_with_several', (
        select count(*) from (
          select account_id from live group by account_id having count(*) > 1
        ) x
      )
    ),
    'devices', jsonb_build_object(
      'active', (select count(*) from public.devices where status = 'ACTIVE'),
      'capacity', (select coalesce(sum(capacity), 0) from per_sub),
      'over_capacity', (select coalesce(sum(greatest(used - capacity, 0)), 0) from per_sub),
      'without_subscription', (
        select count(*) from public.devices d
         where d.status = 'ACTIVE'
           and (d.subscription_id is null
                or d.subscription_id not in (select id from live))
      ),
      'unschedulable', (
        select count(*) from public.devices
         where status = 'ACTIVE' and placement_status = 'UNSCHEDULABLE'
      )
    ),
    'deletions_pending', (
      select count(*) from public.customer_accounts
       where deletion_requested_at is not null
    )
  );
$$;

revoke all on function public.admin_device_model_snapshot() from public, anon, authenticated;
grant execute on function public.admin_device_model_snapshot() to service_role;
