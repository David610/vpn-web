-- Admin grants can reactivate an existing VPN identity whose old expiry
-- has lapsed. Finite grants set a new expiry; indefinite grants explicitly
-- clear it before enabling the user.

alter table public.provisioning_jobs
  drop constraint provisioning_jobs_job_type_check;

alter table public.provisioning_jobs
  add constraint provisioning_jobs_job_type_check
  check (
    job_type in (
      'CREATE_USER',
      'SET_EXPIRY',
      'CLEAR_EXPIRY',
      'ENABLE_USER',
      'DISABLE_USER',
      'ROTATE_SUBSCRIPTION_TOKEN',
      'ROTATE_CREDENTIALS'
    )
  );
