-- F-02/C-02/C-14: Stripe webhook events are not guaranteed to arrive in the
-- order Stripe generated them (retries, redeliveries, multi-worker fan-out
-- upstream of this app all reorder them in practice). Without a per-row
-- "when was this last synced from Stripe" marker, a late-arriving but
-- stale event (e.g. an out-of-order customer.subscription.updated for a
-- state Stripe has already superseded) can overwrite a newer write with
-- older data. stripe_synced_at lets every handler compare the event's own
-- creation time against the last time this row was written from Stripe and
-- skip the write when the incoming event is not newer.
--
-- F-31/C-04: stripe_price_id records the base subscription item's price id
-- at last sync, so device_entitlement() (and any future caller) can check it
-- against an allowlist instead of trusting whatever price the webhook
-- happened to report. This column was explicitly deferred out of F-01's
-- original migration (20261001000000_device_entitlement.sql) — it is added
-- here instead of reusing that file, per the cross-repo plan's rule against
-- editing merged migrations.
alter table public.subscriptions
  add column if not exists stripe_synced_at timestamptz,
  add column if not exists stripe_price_id text;

comment on column public.subscriptions.stripe_synced_at is
  'Timestamp (from the Stripe event that produced the last write) used to reject out-of-order webhook writes. Null means never synced under this guard (legacy row) — the first sync always proceeds.';
comment on column public.subscriptions.stripe_price_id is
  'The base subscription item price id as of the last sync, used to validate against an allowlist before granting entitlement (F-31).';
