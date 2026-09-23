-- True VPN credential rotation is distinct from subscription-token rotation.
-- ROTATE_SUBSCRIPTION_TOKEN only invalidates the fetch URL; already imported
-- VLESS/Hysteria2 credentials keep working. ROTATE_CREDENTIALS rotates both
-- transport credentials and therefore matches the "regenerate VPN profile"
-- product action.

alter table public.provisioning_jobs
  drop constraint provisioning_jobs_job_type_check;

alter table public.provisioning_jobs
  add constraint provisioning_jobs_job_type_check
  check (
    job_type in (
      'CREATE_USER',
      'SET_EXPIRY',
      'ENABLE_USER',
      'DISABLE_USER',
      'ROTATE_SUBSCRIPTION_TOKEN',
      'ROTATE_CREDENTIALS'
    )
  );
