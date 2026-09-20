-- The original subscriptions.status CHECK constraint (schema plan,
-- 20260921000000_initial_schema.sql) omitted two routine Stripe Subscription
-- statuses: `incomplete_expired` (fires whenever an initial payment isn't
-- completed within Stripe's 23-hour window — not an edge case, the normal
-- outcome of an abandoned checkout) and `paused` (a Stripe-native pause
-- feature this app doesn't use yet but Stripe can still report). Without
-- this, a webhook delivering either status violates the CHECK constraint
-- and 500-loops until Stripe gives up retrying (~3 days), permanently
-- desyncing that subscription's state.
alter table public.subscriptions drop constraint subscriptions_status_check;
alter table public.subscriptions add constraint subscriptions_status_check check (
  status in (
    'incomplete',
    'incomplete_expired',
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid',
    'paused'
  )
);
