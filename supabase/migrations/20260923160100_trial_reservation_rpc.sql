-- Atomically reserve one free trial per customer account.
-- A plain "check then update" in the Worker would allow two concurrent
-- Checkout requests to both receive a trial. The account row lock closes
-- that race. Reservations expire after 24 hours so an abandoned Checkout
-- cannot consume the trial forever.

create function public.reserve_free_trial(p_account_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.customer_accounts;
  v_now timestamptz := now();
begin
  select * into v_account
  from public.customer_accounts
  where id = p_account_id
  for update;

  if not found then
    raise exception 'account_not_found';
  end if;

  if v_account.trial_used_at is not null then
    return null;
  end if;

  if v_account.trial_reserved_at is not null
     and v_account.trial_reserved_at > v_now - interval '24 hours' then
    return null;
  end if;

  update public.customer_accounts
  set trial_reserved_at = v_now
  where id = p_account_id;

  return v_now;
end;
$$;

revoke execute on function public.reserve_free_trial(uuid)
  from public, anon, authenticated;
