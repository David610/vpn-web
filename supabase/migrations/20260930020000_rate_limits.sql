-- Web control-plane remediation (F-49, item 11): app-level rate limiting for
-- Telegram linking and the auth proxy. Cloudflare Pages Functions has no
-- KV/D1 binding in this project (see wrangler.toml), so the counter lives in
-- Postgres, using the same fixed-window-counter shape as everything else in
-- this schema that needs an atomic check-and-increment (compare
-- telegram_link_codes' consumed_at CAS in 20260924060000_telegram_linking.sql).
--
-- Internal/service-only table -- callers never read it directly, only
-- through the RPC below, which does the increment and the limit check in
-- one round trip so concurrent requests can't race past the limit.
create table public.rate_limit_buckets (
  bucket_key text primary key,
  window_start timestamptz not null,
  count integer not null default 0
);

alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from anon, authenticated;

-- Fixed-window limiter: `bucket_key` identifies what's being limited (e.g.
-- "telegram-link:<hash-of-ip>" or "login:<email>"), `p_window_seconds` sets
-- how long a window lasts, and `p_limit` is the max count() with the window
--
-- Returns true when the call is allowed (and increments the counter),
-- false when the caller is over the limit for the current window (count is
-- NOT incremented further past the limit, so a hammering caller doesn't
-- inflate the row forever).
--
-- security definer + a fixed search_path: this table has no policies for
-- anon/authenticated, so callers (using the anon/authenticated role through
-- PostgREST, or the service role through the service client) need this
-- function to reach it regardless of caller role -- it never returns rows
-- from the table, only a boolean, so it can't be used to read another
-- caller's bucket contents.
create or replace function public.check_rate_limit(
  p_bucket_key text,
  p_window_seconds integer,
  p_limit integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_row public.rate_limit_buckets;
begin
  insert into public.rate_limit_buckets (bucket_key, window_start, count)
  values (p_bucket_key, v_now, 1)
  on conflict (bucket_key) do update
    set
      -- Window expired: start a fresh window at count 1. Window still
      -- open: bump the count, but only up to p_limit + 1 -- once a caller
      -- is over the limit, further hits inside the same window keep
      -- returning false without the row growing unbounded.
      window_start = case
        when public.rate_limit_buckets.window_start <= v_now - make_interval(secs => p_window_seconds)
          then v_now
        else public.rate_limit_buckets.window_start
      end,
      count = case
        when public.rate_limit_buckets.window_start <= v_now - make_interval(secs => p_window_seconds)
          then 1
        when public.rate_limit_buckets.count > p_limit
          then public.rate_limit_buckets.count
        else public.rate_limit_buckets.count + 1
      end
  returning * into v_row;

  return v_row.count <= p_limit;
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer) from public;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;
