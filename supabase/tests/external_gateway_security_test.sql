-- Phase-2 external gateway privilege and structural security assertions.
-- These checks intentionally run as part of the clean PostgreSQL migration
-- replay so a later grant or SECURITY DEFINER signature change fails CI.
begin;

do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'external_vpn_devices',
    'compatibility_credentials',
    'compatibility_authorizations'
  ] loop
    assert not has_table_privilege('anon', 'public.' || protected_table, 'select'),
      'anon must not read ' || protected_table;
    assert not has_table_privilege('authenticated', 'public.' || protected_table, 'select'),
      'authenticated must not read ' || protected_table;
    assert not has_table_privilege('anon', 'public.' || protected_table, 'insert,update,delete'),
      'anon must not mutate ' || protected_table;
    assert not has_table_privilege('authenticated', 'public.' || protected_table, 'insert,update,delete'),
      'authenticated must not mutate ' || protected_table;
  end loop;

  assert not has_function_privilege(
    'anon',
    'public.create_external_vpn_device(uuid,uuid,bigint,text,text,text,text,text,text,text,text,timestamptz)',
    'execute'), 'anon must not allocate an external device';
  assert not has_function_privilege(
    'authenticated',
    'public.create_external_vpn_device(uuid,uuid,bigint,text,text,text,text,text,text,text,text,timestamptz)',
    'execute'), 'authenticated must not allocate an external device directly';
  assert not has_function_privilege(
    'authenticated',
    'public.revoke_external_vpn_device(uuid,uuid)',
    'execute'), 'authenticated must not invoke external revocation directly';
  assert not has_function_privilege(
    'authenticated',
    'public.rotate_compatibility_credential(uuid,uuid,text,text,text,timestamptz,integer)',
    'execute'), 'authenticated must not invoke credential rotation directly';
end $$;

-- The data-plane projection must be incapable of acquiring customer identity
-- or subscription bearer material through schema drift.
do $$
declare leaked_columns integer;
begin
  select count(*) into leaked_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'compatibility_authorizations'
    and column_name in (
      'account_id', 'customer_id', 'email', 'stripe_id', 'subscription_id',
      'subscription_token', 'subscription_token_hash', 'device_name'
    );
  assert leaked_columns = 0,
    'compatibility_authorizations must contain only opaque node projection data';
end $$;

rollback;
