-- Kitchen push notifications (phase F, first half)
--
-- Until now the kitchen learned about a new order through the kitchen
-- board's Realtime subscription: a sound and a badge, which only exist
-- while that tab is open and in front. A tablet that went to sleep, or a
-- cook who switched to another app, heard nothing. Web Push reaches a
-- device whose tab is closed — the browser's own push service wakes a
-- service worker (public/sw.js), which shows the notification.
--
-- WHAT A SUBSCRIPTION IS. A browser, once the person on it has pressed
-- "Turn on alerts" and allowed notifications, hands back an endpoint URL
-- at its push service plus two keys (p256dh, auth) used to encrypt what we
-- send. Whoever holds all three can put a notification on that device. So
-- a subscription is a small credential, and this table is shaped around
-- keeping it away from anyone who is not the device's own staff member:
--
--   - RLS allows reading your OWN subscriptions and nothing else — not
--     even a colleague's at the same restaurant.
--   - Writes go through save_push_subscription() / delete_push_subscription()
--     below, which re-check that the caller is a member of the restaurant.
--   - A diner — including a diner whose order is about to trigger a push —
--     never reads a single row. The sender runs server-side with the
--     service-role key (src/lib/push/dispatch.ts) precisely so that the
--     diner's session, which creates the order, never has to touch this
--     table. See docs/security.md#kitchen-push.
--
-- TIED TO MEMBERSHIP. The composite foreign key onto restaurant_users
-- cascades: remove someone from the staff page and every device they
-- turned alerts on for stops getting that restaurant's orders, with no
-- cleanup job to forget.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  user_id uuid not null,

  endpoint text not null,
  p256dh text not null,
  auth text not null,

  -- Shown on the kitchen page ("this iPad", "Chrome on Windows") so a
  -- member can tell their devices apart. Informational only.
  user_agent text,

  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  -- Consecutive delivery failures that were NOT "gone" responses. A
  -- 404/410 from the push service deletes the row outright; this counts
  -- the ambiguous ones so a device that has quietly died can be told apart
  -- from one that had a bad minute.
  failure_count integer not null default 0,

  constraint push_subscriptions_member
    foreign key (user_id, restaurant_id)
    references public.restaurant_users (user_id, restaurant_id)
    on delete cascade,
  -- One row per device per restaurant. An owner of two restaurants can
  -- turn alerts on for both on the same tablet.
  constraint push_subscriptions_unique_device
    unique (endpoint, restaurant_id),
  -- Push services are https, always. Anything else is not a subscription
  -- this app made, and sending to it would be sending our payload to an
  -- arbitrary URL.
  constraint push_subscriptions_endpoint_https
    check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  constraint push_subscriptions_keys_shape
    check (length(p256dh) between 20 and 200 and length(auth) between 8 and 100),
  constraint push_subscriptions_user_agent_length
    check (user_agent is null or length(user_agent) <= 300)
);

comment on table public.push_subscriptions is
  'A staff member''s device that has opted in to kitchen push alerts for one restaurant. Each row is a small credential (endpoint + keys can put a notification on that device), so RLS shows a member only their own rows and diners nothing. Cascades away when the member is removed.';

create index push_subscriptions_restaurant_idx
  on public.push_subscriptions (restaurant_id);

alter table public.push_subscriptions enable row level security;

-- Your own devices, for the kitchen page's "alerts are on" state.
create policy "push_subscriptions_select_own"
  on public.push_subscriptions
  for select
  to authenticated
  using (user_id = auth.uid());

-- No insert/update/delete policies: writes go through the functions below.

-- What has already been announced --------------------------------------------

-- submit_order() is idempotent: a double tap, a retried request or an
-- AI turn that submits the same confirmed cart returns the SAME order. The
-- sender claims (kind, source_id) here before sending, so the second call
-- finds it taken and sends nothing. Without this a flaky connection would
-- ring the kitchen twice for one order.
create table public.push_dispatches (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  kind text not null,
  source_id uuid not null,
  created_at timestamptz not null default now(),
  constraint push_dispatches_kind_valid check (kind in ('order', 'table_request')),
  constraint push_dispatches_once unique (kind, source_id)
);

comment on table public.push_dispatches is
  'One row per order or table request the kitchen has been pushed about, claimed before sending, so an idempotent retry never notifies twice. Written only by the service-role sender.';

-- RLS on, no policies: nothing but the service-role sender reads or
-- writes this, and service_role bypasses RLS.
alter table public.push_dispatches enable row level security;

-- Opting a device in and out -------------------------------------------------

create function public.save_push_subscription(
  target_restaurant_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Any member: a cook's tablet is exactly who this is for. A diner is an
  -- authenticated anonymous user but a member of nothing, so they stop
  -- here.
  if not public.is_restaurant_member(target_restaurant_id) then
    raise exception 'PUSH_NOT_A_MEMBER' using errcode = '42501';
  end if;

  -- The same device re-subscribing (a new browser session, or a different
  -- staff member signing in on the shared kitchen tablet) takes the row
  -- over rather than duplicating it: the device, not the person, is what
  -- receives the alert.
  insert into public.push_subscriptions (
    restaurant_id, user_id, endpoint, p256dh, auth, user_agent
  )
  values (
    target_restaurant_id,
    auth.uid(),
    p_endpoint,
    p_p256dh,
    p_auth,
    left(p_user_agent, 300)
  )
  on conflict (endpoint, restaurant_id) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        failure_count = 0;
end;
$$;

comment on function public.save_push_subscription(uuid, text, text, text, text) is
  'Turns kitchen alerts on for this device at this restaurant. Members only; a device re-subscribing takes over its existing row.';

-- Deletes by endpoint, but only the caller's own rows: turning alerts off
-- on your phone must not be able to turn them off on someone else's.
create function public.delete_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.push_subscriptions
  where endpoint = p_endpoint
    and user_id = auth.uid();
end;
$$;

comment on function public.delete_push_subscription(text) is
  'Turns kitchen alerts off for this device — the caller''s own rows only.';

revoke execute on function public.save_push_subscription(uuid, text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(uuid, text, text, text, text) to authenticated;
revoke execute on function public.delete_push_subscription(text) from public, anon;
grant execute on function public.delete_push_subscription(text) to authenticated;
