-- WARNING: creates real (synthetic-data) confirmed user accounts with known
-- test passwords. `supabase db reset` only ever applies this to the LOCAL
-- dev database — never run it against a linked/production project
-- (`supabase db reset --linked` or equivalent). No real credentials appear
-- anywhere in this file, but a confirmed, loginable account on a real
-- project is a real account regardless of how the password was chosen.

-- Two synthetic users with one row in every table, so the RLS test script
-- has real cross-user data to prove isolation against (not empty tables).
-- No real credentials, no real Stripe/VPN identifiers anywhere here.

insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
values
  ('11111111-1111-1111-1111-111111111111', 'user-a@example.test', crypt('test-password-a', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'user-b@example.test', crypt('test-password-b', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', 'authenticated', 'authenticated');
-- public.profiles rows for both are created automatically by the
-- on_auth_user_created trigger from the migration.

insert into public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
values
  ('11111111-1111-1111-1111-111111111111', 'cus_test_a', 'sub_test_a', 'active', now() + interval '30 days'),
  ('22222222-2222-2222-2222-222222222222', 'cus_test_b', 'sub_test_b', 'active', now() + interval '30 days');

insert into public.vpn_accounts (id, user_id, vpn_user_id, node_id)
overriding system value
values
  (1, '11111111-1111-1111-1111-111111111111', 'vpn_user_test_a', 'node-1'),
  (2, '22222222-2222-2222-2222-222222222222', 'vpn_user_test_b', 'node-1');

select setval('public.vpn_accounts_id_seq', (select max(id) from public.vpn_accounts));

insert into public.vpn_secrets (vpn_account_id, ciphertext, nonce)
values
  (1, '\xdeadbeef', '\x0102030405060708090a0b0c'),
  (2, '\xfeedface', '\x0102030405060708090a0b0d');

insert into public.provisioning_jobs (idempotency_key, vpn_account_id, node_id, job_type, status)
values
  ('idem-test-a-create', 1, 'node-1', 'CREATE_USER', 'done'),
  ('idem-test-b-create', 2, 'node-1', 'CREATE_USER', 'done');

insert into public.stripe_events (stripe_event_id, event_type, payload)
values
  ('evt_test_a', 'invoice.paid', '{"test": true, "user": "a"}'::jsonb),
  ('evt_test_b', 'invoice.paid', '{"test": true, "user": "b"}'::jsonb);

insert into public.abuse_signals (vpn_account_id, distinct_ip_count, window_start, window_end, flagged)
values
  (1, 2, now() - interval '1 day', now(), false),
  (2, 9, now() - interval '1 day', now(), true);
