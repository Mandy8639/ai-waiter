-- Dish funnel (phase H): for each dish, how many visits opened it, added it
-- to the cart, and ordered it.
--
-- THE PRIVACY SHAPE. A QR scan creates a real anonymous auth user, so a
-- raw event log ("session X opened the burger at 19:42, then...") would be
-- a record of one person's evening. This keeps none of that:
--
--   - dish_daily_stats holds COUNTS ONLY: per dish, per day in the
--     restaurant's own calendar. No session, no user, no table, no time
--     of day. This is what reports read, and it is kept.
--   - dish_visit_marks exists only so a visit is counted once per dish
--     ("opened the burger" is one, however many times they open it). It
--     holds the visit id, and every mark is deleted after 2 days — the
--     length of a visit with a generous margin — as well as the moment
--     the visit itself is deleted.
--
-- AGGREGATED ON WRITE. The "opened → ordered" rate is counted when the
-- order is placed: if this visit opened the dish earlier, ordered_after_open
-- goes up by one. That is the only way to report a true rate once the
-- marks are gone, and it can never pass 100%.
--
-- NEVER IN THE DINER'S WAY. Every counting path swallows its own errors:
-- a failure here must not stop someone adding a dish or placing an order.

create table public.dish_daily_stats (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  menu_item_id uuid not null,
  day date not null,
  opened integer not null default 0,
  added integer not null default 0,
  ordered integer not null default 0,
  ordered_after_open integer not null default 0,

  primary key (restaurant_id, menu_item_id, day),

  constraint dish_daily_stats_item_same_restaurant
    foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id)
    on delete cascade,
  constraint dish_daily_stats_non_negative
    check (opened >= 0 and added >= 0 and ordered >= 0 and ordered_after_open >= 0)
);

comment on table public.dish_daily_stats is
  'Phase H dish funnel. Counts of visits per dish per restaurant-local day — no diner, table or time-of-day data. Written only by record_dish_signal(); read only by get_dish_funnel(). See docs/security.md#dish-funnel-phase-h.';

alter table public.dish_daily_stats enable row level security;
-- No policies: nothing reads or writes this table directly.

create table public.dish_visit_marks (
  customer_session_id uuid not null references public.customer_sessions (id) on delete cascade,
  menu_item_id uuid not null,
  kind text not null,
  created_at timestamptz not null default now(),

  primary key (customer_session_id, menu_item_id, kind),
  constraint dish_visit_marks_kind_valid check (kind in ('open', 'add', 'order'))
);

comment on table public.dish_visit_marks is
  'Phase H: "this visit has already been counted for this dish". Exists only to count each visit once; every row is deleted after 2 days. Never read by reports.';

create index dish_visit_marks_created_at_idx on public.dish_visit_marks (created_at);

alter table public.dish_visit_marks enable row level security;
-- No policies.

-- The single writer. Not callable by any client role: only the functions
-- and triggers below reach it.
create function public.record_dish_signal(
  p_session_id uuid,
  p_restaurant_id uuid,
  p_menu_item_id uuid,
  p_kind text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_counted integer;
  v_after_open integer := 0;
  v_day date;
begin
  -- Forget finished visits. Indexed, and usually nothing to delete.
  delete from public.dish_visit_marks
  where created_at < now() - interval '2 days';

  insert into public.dish_visit_marks (customer_session_id, menu_item_id, kind)
  values (p_session_id, p_menu_item_id, p_kind)
  on conflict do nothing;
  get diagnostics v_counted = row_count;
  if v_counted = 0 then
    return; -- this visit is already counted for this dish
  end if;

  if p_kind = 'order' and exists (
    select 1 from public.dish_visit_marks m
    where m.customer_session_id = p_session_id
      and m.menu_item_id = p_menu_item_id
      and m.kind = 'open'
  ) then
    v_after_open := 1;
  end if;

  select (now() at time zone coalesce(r.timezone, 'UTC'))::date
  into v_day
  from public.restaurants r
  where r.id = p_restaurant_id;

  insert into public.dish_daily_stats as s
    (restaurant_id, menu_item_id, day, opened, added, ordered, ordered_after_open)
  values (
    p_restaurant_id,
    p_menu_item_id,
    coalesce(v_day, current_date),
    (p_kind = 'open')::int,
    (p_kind = 'add')::int,
    (p_kind = 'order')::int,
    v_after_open
  )
  on conflict (restaurant_id, menu_item_id, day) do update
  set opened = s.opened + excluded.opened,
      added = s.added + excluded.added,
      ordered = s.ordered + excluded.ordered,
      ordered_after_open = s.ordered_after_open + excluded.ordered_after_open;
end;
$$;

revoke execute on function public.record_dish_signal(uuid, uuid, uuid, text) from public, anon, authenticated;

-- "Opened": called by the dish page. Counted only for a diner seated at
-- this restaurant — an owner previewing the menu has no visit and is not
-- counted — and only for a dish of the restaurant they are seated at.
-- Silent in every case: a diner never sees an analytics error.
create function public.record_dish_view(p_menu_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session uuid;
  v_restaurant uuid;
begin
  select cs.id, cs.restaurant_id
  into v_session, v_restaurant
  from public.customer_sessions cs
  where cs.user_id = auth.uid()
    and cs.status = 'active'
    and cs.expires_at > now();

  if v_session is null then
    return;
  end if;

  if not exists (
    select 1 from public.menu_items mi
    where mi.id = p_menu_item_id and mi.restaurant_id = v_restaurant
  ) then
    return;
  end if;

  perform public.record_dish_signal(v_session, v_restaurant, p_menu_item_id, 'open');
exception when others then
  return;
end;
$$;

comment on function public.record_dish_view(uuid) is
  'Phase H: counts that the caller''s current visit opened this dish, once per visit. No-op for anyone not seated at the dish''s restaurant. Never raises.';

revoke execute on function public.record_dish_view(uuid) from public, anon;
grant execute on function public.record_dish_view(uuid) to authenticated;

-- "Added": every cart line, whichever path added it (the menu, the dish
-- page, the AI waiter).
create function public.dish_funnel_on_cart_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session uuid;
begin
  if new.menu_item_id is not null then
    select c.customer_session_id into v_session
    from public.carts c
    where c.id = new.cart_id;

    if v_session is not null then
      perform public.record_dish_signal(v_session, new.restaurant_id, new.menu_item_id, 'add');
    end if;
  end if;
  return new;
exception when others then
  return new;
end;
$$;

revoke execute on function public.dish_funnel_on_cart_item() from public, anon, authenticated;

create trigger cart_items_dish_funnel
  after insert on public.cart_items
  for each row execute function public.dish_funnel_on_cart_item();

-- "Ordered": every order line. A split or merge that re-inserts lines for
-- the same visit is not counted twice (the mark already exists).
create function public.dish_funnel_on_order_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session uuid;
begin
  if new.menu_item_id is not null then
    select o.customer_session_id into v_session
    from public.orders o
    where o.id = new.order_id;

    if v_session is not null then
      perform public.record_dish_signal(v_session, new.restaurant_id, new.menu_item_id, 'order');
    end if;
  end if;
  return new;
exception when others then
  return new;
end;
$$;

revoke execute on function public.dish_funnel_on_order_item() from public, anon, authenticated;

create trigger order_items_dish_funnel
  after insert on public.order_items
  for each row execute function public.dish_funnel_on_order_item();

-- The report. Owner/manager only, over the same half-open [p_from, p_to)
-- the other reporting functions take, turned into the restaurant's own
-- calendar days.
create function public.get_dish_funnel(
  target_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 50
)
returns table (
  dish_id uuid,
  dish_name text,
  opened_visits bigint,
  added_visits bigint,
  ordered_visits bigint,
  ordered_after_open_visits bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
begin
  perform public.assert_can_view_reports(target_restaurant_id);

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'REPORT_INVALID_LIMIT: limit must be between 1 and 200'
      using errcode = '22023';
  end if;

  select coalesce(r.timezone, 'UTC') into v_tz
  from public.restaurants r
  where r.id = target_restaurant_id;

  return query
  select
    s.menu_item_id,
    mi.name,
    sum(s.opened)::bigint,
    sum(s.added)::bigint,
    sum(s.ordered)::bigint,
    sum(s.ordered_after_open)::bigint
  from public.dish_daily_stats s
  join public.menu_items mi on mi.id = s.menu_item_id
  where s.restaurant_id = target_restaurant_id
    and s.day >= (p_from at time zone v_tz)::date
    and s.day < (p_to at time zone v_tz)::date
  group by s.menu_item_id, mi.name
  order by sum(s.opened) desc, sum(s.ordered) desc, mi.name
  limit p_limit;
end;
$$;

comment on function public.get_dish_funnel(uuid, timestamptz, timestamptz, integer) is
  'Phase H: per dish, visits that opened it, added it, ordered it, and ordered it after opening it, over a period. Counts only. Owner/manager only.';

revoke execute on function public.get_dish_funnel(uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.get_dish_funnel(uuid, timestamptz, timestamptz, integer) to authenticated;
