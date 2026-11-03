-- Tables and functions used by the relayer functions (apps/relayer).
-- Run once in the Supabase SQL editor, or with `supabase db push`.
--
-- Nothing here is readable or writable by the public anon key: Row Level Security is on with no
-- policies, so only the service-role key (held by the server functions) can touch these tables.

-- Daily counters for rate limiting. One row per (key, day).
create table if not exists public.rate_counters (
  key   text    not null,
  day   date    not null,
  n     integer not null default 0 check (n >= 0),
  primary key (key, day)
);
alter table public.rate_counters enable row level security;

-- Atomic: a single statement adds one and returns the new total, so two simultaneous requests can
-- never both read the same value and both slip under a limit.
create or replace function public.rate_increment(p_key text, p_day date)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.rate_counters (key, day, n) values (p_key, p_day, 1)
  on conflict (key, day) do update set n = public.rate_counters.n + 1
  returning n;
$$;

create or replace function public.rate_decrement(p_key text, p_day date)
returns void
language sql
security definer
set search_path = public
as $$
  update public.rate_counters set n = greatest(0, n - 1) where key = p_key and day = p_day;
$$;

-- Anonymous analytics. A random visit id and a time; no address, no account, no personal fields.
create table if not exists public.events (
  id      bigint generated always as identity primary key,
  name    text        not null,
  session text        not null,
  at      timestamptz not null,
  props   jsonb       not null default '{}'::jsonb
);
alter table public.events enable row level security;
create index if not exists events_name_at on public.events (name, at);

-- Only the server (service role) may call the counter functions.
revoke all on function public.rate_increment(text, date) from public, anon, authenticated;
revoke all on function public.rate_decrement(text, date) from public, anon, authenticated;
grant execute on function public.rate_increment(text, date) to service_role;
grant execute on function public.rate_decrement(text, date) to service_role;

-- Old counters are useless after a day or two; keep the table small.
create or replace function public.rate_prune()
returns void language sql security definer set search_path = public as $$
  delete from public.rate_counters where day < (current_date - 2);
$$;
revoke all on function public.rate_prune() from public, anon, authenticated;
grant execute on function public.rate_prune() to service_role;
