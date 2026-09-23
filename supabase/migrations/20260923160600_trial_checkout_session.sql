-- Keep the Stripe Checkout Session that owns a live free-trial reservation.
-- This lets a customer who returns via cancel_url resume the SAME Checkout
-- instead of being locked out by the concurrency-safe reservation for up to
-- 24 hours. The session id is not a credential; Stripe remains authoritative
-- for whether it is open, complete, or expired.

alter table public.customer_accounts
  add column trial_checkout_session_id text;

revoke all on public.customer_accounts from anon, authenticated;
