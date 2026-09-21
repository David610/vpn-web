-- supabase/migrations/20260921140000_cancel_at_period_end.sql
-- Tracks Stripe's cancel_at_period_end flag so the dashboard can show
-- "cancels on <date>" instead of just a status string. Written only by
-- handleSubscriptionUpdated (functions/lib/stripe-events.js), mirroring
-- every other subscriptions column.
alter table public.subscriptions
  add column cancel_at_period_end boolean not null default false;
