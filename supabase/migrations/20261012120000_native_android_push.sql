-- The native Android app's kitchen alerts.
--
-- The Android app is now a Capacitor app (android/), like the iOS one, so
-- it can ring like a delivery tablet: a looping alarm until the order is
-- touched or accepted. Its phones register Firebase Cloud Messaging
-- tokens in native_push_tokens next to the iPhones' APNs tokens.
--
--   1. native_push_tokens accepts platform 'android'. FCM tokens are not
--      hex and ARE case-sensitive, so only APNs tokens are lower-cased.
--   2. When an order stops waiting, the Android phones still ringing for
--      it are told to stop. The kitchen board's Confirm and Cancel do that
--      straight away (src/lib/orders/transition.ts); every other way an
--      order leaves 'pending' is caught by the next 30-second round:
--      claim_orders_handled() picks orders that were alerted, are no longer
--      pending and haven't had their "stop" sent, and stamps them.
--      order_rings_due() now also wakes the scheduler for those.

-- 1. Android tokens ------------------------------------------------------------

alter table public.native_push_tokens
  drop constraint native_push_tokens_platform_valid,
  drop constraint native_push_tokens_token_shape;

alter table public.native_push_tokens
  add constraint native_push_tokens_platform_valid
    check (platform in ('ios', 'android')),
  add constraint native_push_tokens_token_shape check (
    (platform = 'ios' and token ~ '^[0-9a-f]{64,200}$')
    -- FCM registration tokens: letters, digits, '-', '_' and ':'.
    -- (Postgres caps a regex repeat count at 255, so the length is
    -- checked separately.)
    or (platform = 'android'
        and token ~ '^[A-Za-z0-9_:-]+$'
        and char_length(token) between 100 and 4096)
  );

comment on table public.native_push_tokens is
  'A staff member''s phone or tablet that has opted in to kitchen alerts in the Tableside iOS app (APNs token) or Android app (FCM token), for one restaurant. Each token can put a notification on that device, so RLS shows a member only their own rows. Cascades away with the membership.';

create or replace function public.save_native_push_token(
  target_restaurant_id uuid,
  p_token text,
  p_platform text default 'ios'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
begin
  if not public.is_restaurant_member(target_restaurant_id) then
    raise exception 'PUSH_NOT_A_MEMBER' using errcode = '42501';
  end if;
  if p_platform not in ('ios', 'android') then
    raise exception 'PUSH_BAD_PLATFORM' using errcode = '22023';
  end if;

  -- APNs tokens are hex and case-insensitive; FCM tokens are neither.
  v_token := case when p_platform = 'ios' then lower(p_token) else p_token end;

  insert into public.native_push_tokens (restaurant_id, user_id, platform, token)
  values (target_restaurant_id, auth.uid(), p_platform, v_token)
  on conflict (token, restaurant_id) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        failure_count = 0;
end;
$$;

comment on function public.save_native_push_token(uuid, text, text) is
  'Turns kitchen alerts on for this phone in the iOS or Android app, at this restaurant. Members only; the same phone registering again takes over its row.';

create or replace function public.delete_native_push_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.native_push_tokens
  where token in (p_token, lower(p_token))
    and user_id = auth.uid();
end;
$$;

-- create or replace keeps the existing grants; restated for the record.
revoke execute on function public.save_native_push_token(uuid, text, text) from public, anon;
grant execute on function public.save_native_push_token(uuid, text, text) to authenticated;
revoke execute on function public.delete_native_push_token(text) from public, anon;
grant execute on function public.delete_native_push_token(text) to authenticated;

-- 2. "Stop ringing" ------------------------------------------------------------

alter table public.push_dispatches
  add column handled_notified_at timestamptz;

comment on column public.push_dispatches.handled_notified_at is
  'When the devices were told this order no longer needs ringing (it left pending). Null until then.';

-- Orders the kitchen saw alerts for, that no longer wait, and whose "stop"
-- hasn't gone out. Within an hour: older ones stopped ringing long ago.
create function public.claim_orders_handled(p_window_minutes integer default 60)
returns table (order_id uuid, restaurant_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return query
  update public.push_dispatches d
  set handled_notified_at = now()
  from public.orders o
  where o.id = d.source_id
    and d.kind = 'order'
    and d.handled_notified_at is null
    and o.status <> 'pending'
    and d.created_at > now() - make_interval(mins => p_window_minutes)
  returning d.source_id, d.restaurant_id;
end;
$$;

comment on function public.claim_orders_handled(integer) is
  'Claims the orders whose devices should stop ringing: alerted, no longer pending, stop not yet sent. Stamps each, so it is sent once.';

-- The scheduler's gate now also opens for a pending "stop".
create or replace function public.order_rings_due(
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
      and coalesce(d.last_ring_at, d.created_at)
          <= now() - make_interval(secs => p_interval_seconds - 5)
  ) or exists (
    select 1
    from public.push_dispatches d
    join public.orders o on o.id = d.source_id
    where d.kind = 'order'
      and d.handled_notified_at is null
      and o.status <> 'pending'
      and d.created_at > now() - interval '60 minutes'
  );
end;
$$;

revoke execute on function public.claim_orders_handled(integer) from public, anon, authenticated;
grant execute on function public.claim_orders_handled(integer) to service_role;
revoke execute on function public.order_rings_due(integer, integer) from public, anon, authenticated;
grant execute on function public.order_rings_due(integer, integer) to service_role;
