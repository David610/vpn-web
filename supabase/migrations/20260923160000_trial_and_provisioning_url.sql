-- Close remaining subscription/onboarding gaps:
-- 1) reserve/consume the one free trial per customer account;
-- 2) keep the first-party provisioning URL separately from the legacy
--    sing-box subscription URL, both encrypted at rest.

alter table public.customer_accounts
  add column trial_reserved_at timestamptz,
  add column trial_used_at timestamptz;

alter table public.vpn_secrets
  add column provisioning_ciphertext bytea,
  add column provisioning_nonce bytea;

alter table public.vpn_secrets
  add constraint vpn_secrets_provisioning_pair_check
  check (
    (provisioning_ciphertext is null and provisioning_nonce is null)
    or
    (
      provisioning_ciphertext is not null
      and provisioning_nonce is not null
      and octet_length(provisioning_nonce) = 12
    )
  );

-- These remain service-role-only. Re-state the revoke so this migration is
-- safe even if a project-wide default privilege changes later.
revoke all on public.customer_accounts, public.vpn_secrets from anon, authenticated;
