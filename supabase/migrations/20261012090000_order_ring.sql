-- Order alerts that keep ringing until the kitchen accepts.
--
-- A new order sends one push (20260928090000_push_subscriptions.sql). A
-- phone in a pocket buzzes once, and a busy kitchen misses it. So while an
-- order is still 'pending', the kitchen's devices are alerted again every
-- 30 seconds, for up to 10 minutes, until someone confirms or cancels it.
--
-- Three pieces:
--   1. push_dispatches remembers how often, and when, each order last rang.
--   2. claim_order_rings() atomically picks the orders due a ring and
--      stamps them, so two overlapping runs can never ring the same order
--      twice in one round. Service role only.
--   3. A pg_cron job runs every 30 seconds and, ONLY when some order is
--      due, calls the app's /api/cron/order-ring (src/app/api/cron/
--      order-ring/route.ts), which does the sending. The address and the
--      shared secret come from Supabase Vault ('order_ring_url',
--      'order_ring_secret'); until both exist the job calls nothing, so
--      this migration is inert on any project that hasn't been set up
--      (docs/security.md, "Order ring").
--
-- The scheduler pieces are guarded: where pg_cron or pg_net aren't
-- available (the PGlite test harness), they're skipped and everything else
-- still applies.

alter table public.push_dispatches
  add column ring_count integer not null default 0,
  add column last_ring_at timestamptz;

comment on column public.push_dispatches.ring_count is
  'Repeat alerts sent for this order after the first, by claim_order_rings().';
comment on column public.push_dispatches.last_ring_at is
  'When the last repeat alert was claimed; null until the first repeat.';

-- 1 & 2: who rings now ------------------------------------------------------

create function public.order_rings_due(
  p_interval_seconds integer default 30,
  p_window_minutes integer default 10
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return exists (
    select 1
    from public.push_dispatches d
    join public.orders o on o.id = d.source_id
    where d.kind = 'order'
      and o.status = 'pending'
      and o.created_at > now() - make_interval(mins => p_window_minutes)
      -- A few seconds of slack: the scheduler's 30 seconds are not exact,
      -- and a ring due at 29.8s should not wait a whole extra round.
      and coalesce(d.last_ring_at, d.created_at)
          <= now() - make_interval(secs => p_interval_seconds - 5)
  );
end;
$$;

comment on function public.order_rings_due(integer, integer) is
  'True when at least one pending order is due a repeat alert. Lets the scheduler skip calling the app when nothing is waiting.';

create function public.claim_order_rings(
  p_interval_seconds integer default 30,
  p_window_minutes integer default 10
)
returns table (order_id uuid, ring_count integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return query
  update public.push_dispatches d
  set ring_count = d.ring_count + 1,
      last_ring_at = now()
  from public.orders o
  where o.id = d.source_id
    and d.kind = 'order'
    and o.status = 'pending'
    and o.created_at > now() - make_interval(mins => p_window_minutes)
    and coalesce(d.last_ring_at, d.created_at)
        <= now() - make_interval(secs => p_interval_seconds - 5)
  returning d.source_id, d.ring_count;
end;
$$;

comment on function public.claim_order_rings(integer, integer) is
  'Claims this round of repeat alerts: every pending order (within the window) whose last alert is at least the interval old. Each claimed order is stamped, so an overlapping call claims nothing twice.';

-- Only the service-role sender (and the scheduler, which runs as postgres)
-- may call these. Supabase's default privileges grant EXECUTE to anon and
-- authenticated, so both are revoked explicitly.
revoke execute on function public.order_rings_due(integer, integer) from public, anon, authenticated;
grant execute on function public.order_rings_due(integer, integer) to service_role;
revoke execute on function public.claim_order_rings(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_order_rings(integer, integer) to service_role;

-- 3: the scheduler ----------------------------------------------------------

do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'order ring: pg_cron or pg_net not available here; scheduler skipped';
    return;
  end if;

  create extension if not exists pg_cron with schema pg_catalog;
  create extension if not exists pg_net with schema extensions;

  -- Every 30 seconds where pg_cron supports it (1.5+), else every minute.
  begin
    perform cron.schedule('order-ring', '30 seconds', $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'order_ring_url' limit 1),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'order_ring_secret' limit 1)
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 25000
      )
      where exists (select 1 from vault.decrypted_secrets where name = 'order_ring_url')
        and exists (select 1 from vault.decrypted_secrets where name = 'order_ring_secret')
        and public.order_rings_due();
    $job$);
  exception when others then
    perform cron.schedule('order-ring', '* * * * *', $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'order_ring_url' limit 1),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'order_ring_secret' limit 1)
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 25000
      )
      where exists (select 1 from vault.decrypted_secrets where name = 'order_ring_url')
        and exists (select 1 from vault.decrypted_secrets where name = 'order_ring_secret')
        and public.order_rings_due();
    $job$);
  end;
end;
$outer$;
