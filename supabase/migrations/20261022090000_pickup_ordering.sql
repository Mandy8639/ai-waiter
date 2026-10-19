-- Pickup ordering (Feature 1): a diner at a counter orders ahead and picks
-- a pickup time.
--
-- A pickup counter is a new KIND OF TABLE, not a new ordering path. Every
-- customer session, cart, order, RLS policy and SECURITY DEFINER function
-- in this schema assumes a table. A counter row (tables.kind = 'counter')
-- with its own QR code keeps all of that working unchanged: the scan
-- route, submit_order(), the kitchen board, payments. What a counter adds
-- is one rule: its orders carry a pickup time, and the time must be a real,
-- open, not-yet-full slot.
--
-- Payment is unchanged and per diner session, not per table
-- (start_tab_payment() gathers by auth.uid()), so two strangers ordering
-- at the same counter never share a bill. The diner pays by card now or
-- at the counter, exactly as at a table.
--
-- Where the rule lives: a BEFORE INSERT trigger on orders, like the pause
-- (20261015090000_kitchen_busy_mode.sql) and the menu-hours check
-- (20261004090000_multiple_menus.sql). submit_order() is untouched: it is
-- the only thing that inserts orders, and a trigger holds no matter how it
-- changes later. Its idempotent replay returns before inserting, so a
-- retried submit returns the original order even after its slot filled.
--
-- The diner's chosen time and name wait on their cart (set_cart_pickup())
-- until the order is placed, so the choice survives a reload and the AI
-- waiter's submit path sees it too.

-- 1. Counters --------------------------------------------------------------

alter table public.tables
  add column kind text not null default 'table',
  add constraint tables_kind_valid check (kind in ('table', 'counter'));

comment on column public.tables.kind is
  '''table'' (a place diners sit) or ''counter'' (a pickup point: its orders need a pickup time, it takes no reservations, and many unrelated diners share it).';

-- Nobody books a counter.
create function public.refuse_reservation_on_counter()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.tables
    where id = new.table_id and kind = 'counter'
  ) then
    raise exception 'RESERVATION_COUNTER: a pickup counter can''t be reserved';
  end if;
  return new;
end;
$$;

create trigger trg_reservations_refuse_counter
  before insert or update of table_id on public.reservations
  for each row
  execute function public.refuse_reservation_on_counter();

-- 2. The restaurant's slot rules -------------------------------------------

alter table public.restaurant_settings
  add column pickup_slot_minutes integer not null default 15,
  add column pickup_slot_capacity integer not null default 6,
  add column pickup_lead_minutes integer not null default 20,
  -- Every allowed length divides an hour, so slots stay on the grid across
  -- a daylight-saving change (the clock moves by a whole hour).
  add constraint restaurant_settings_pickup_slot_minutes_valid
    check (pickup_slot_minutes in (5, 10, 15, 20, 30)),
  add constraint restaurant_settings_pickup_slot_capacity_range
    check (pickup_slot_capacity between 1 and 100),
  add constraint restaurant_settings_pickup_lead_minutes_range
    check (pickup_lead_minutes between 5 and 240);

comment on column public.restaurant_settings.pickup_slot_minutes is
  'Pickup slots start every this many minutes, on the hour (5, 10, 15, 20 or 30).';
comment on column public.restaurant_settings.pickup_slot_capacity is
  'At most this many pickup orders share one slot. Cancelled orders free their place.';
comment on column public.restaurant_settings.pickup_lead_minutes is
  'How much notice the kitchen needs: the earliest slot offered is at least this far away. Also the cooking time assumed for a pickup order whose dishes have no preparation time.';

-- 3. Where the choice waits, and where it ends up --------------------------

alter table public.carts
  add column pickup_at timestamptz,
  add column pickup_name text,
  add constraint carts_pickup_name_length
    check (pickup_name is null or length(trim(pickup_name)) between 1 and 40);

alter table public.orders
  add column fulfillment text not null default 'dine_in',
  add column pickup_at timestamptz,
  add column pickup_name text,
  add column ticket_release_at timestamptz,
  add constraint orders_fulfillment_valid check (fulfillment in ('dine_in', 'pickup')),
  add constraint orders_pickup_fields check (
    (fulfillment = 'pickup'
      and pickup_at is not null
      and pickup_name is not null
      and ticket_release_at is not null)
    or (fulfillment = 'dine_in'
      and pickup_at is null
      and pickup_name is null
      and ticket_release_at is null)
  );

comment on column public.orders.pickup_at is
  'The slot the diner chose. Staff may move it (change_pickup_time()); nothing else changes it.';
comment on column public.orders.ticket_release_at is
  'When the kitchen should start: pickup_at less the longest preparation time in the order (or the lead time, when no dish has one) and any busy-mode extra.';

create index orders_pickup_slot_idx
  on public.orders (restaurant_id, pickup_at)
  where fulfillment = 'pickup';

-- How an order is collected, and by whom, never changes after it is placed.
-- Same function as 20260824090100_order_status_transitions.sql, plus
-- fulfillment and pickup_name. pickup_at and ticket_release_at stay
-- movable, by change_pickup_time() only (orders has no UPDATE policy).
create or replace function public.enforce_order_immutable_fields()
returns trigger
language plpgsql
as $$
begin
  if new.subtotal <> old.subtotal
    or new.tax <> old.tax
    or new.service_charge <> old.service_charge
    or new.total <> old.total
    or new.currency <> old.currency
    or new.restaurant_id <> old.restaurant_id
    or new.table_id <> old.table_id
    or new.customer_session_id <> old.customer_session_id
    or new.order_number <> old.order_number
    or new.idempotency_key <> old.idempotency_key
    or new.fulfillment <> old.fulfillment
    or new.pickup_name is distinct from old.pickup_name
  then
    raise exception 'orders: financial and identity fields are immutable after creation';
  end if;
  return new;
end;
$$;

-- 4. Opening hours at a given time -----------------------------------------
--
-- menu_on_now() and special_hours_allow_now() answer for "now"; a pickup
-- slot needs the same answer for 12:30. These are the same bodies with the
-- time as a parameter, and the "now" versions become calls to them, so the
-- two can never drift apart. CREATE OR REPLACE keeps the old grants.

create function public.special_hours_allow_at(p_restaurant_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select not s.closed
       and t.local_at::time >= s.opens_at
       and t.local_at::time < s.closes_at
    from public.restaurants r
    cross join lateral (select p_at at time zone coalesce(r.timezone, 'UTC') as local_at) t
    join public.restaurant_special_hours s
      on s.restaurant_id = r.id and s.day = t.local_at::date
    where r.id = p_restaurant_id
  ), true)
$$;

create or replace function public.special_hours_allow_now(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.special_hours_allow_at(p_restaurant_id, now())
$$;

create function public.menu_on_at(p_menu_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select m.is_published
      and public.special_hours_allow_at(m.restaurant_id, p_at)
      and (
        not exists (select 1 from public.menu_hours h where h.menu_id = m.id)
        or exists (
          select 1
          from public.menu_hours h,
               lateral (select p_at at time zone coalesce(r.timezone, 'UTC') as local_at) t
          where h.menu_id = m.id
            and h.day_of_week = extract(dow from t.local_at)::smallint
            and t.local_at::time >= h.opens_at
            and t.local_at::time < h.closes_at
        )
      )
    from public.menus m
    join public.restaurants r on r.id = m.restaurant_id
    where m.id = p_menu_id
  ), false)
$$;

create or replace function public.menu_on_now(p_menu_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.menu_on_at(p_menu_id, now())
$$;

-- 5. The slot rule ---------------------------------------------------------

/** How far ahead a slot may be. Kept under the kitchen board's 12-hour look-back (src/lib/orders/kitchen.ts), so an order is still on the board when its time comes. */
create function public.pickup_max_ahead()
returns interval
language sql
immutable
set search_path = public, pg_temp
as $$ select interval '8 hours' $$;

-- Why p_at can't be a pickup time at this restaurant, as a diner-safe
-- sentence, or null when it can. p_exclude_order_id leaves one order out
-- of the count, for moving an order without it competing with itself.
-- Callers that act on the answer hold pickup_lock() first.
create function public.pickup_slot_problem(
  p_restaurant_id uuid,
  p_at timestamptz,
  p_exclude_order_id uuid default null
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_settings public.restaurant_settings%rowtype;
  v_local timestamp;
  v_taken integer;
begin
  if p_at is null then
    return 'Choose a pickup time.';
  end if;

  select coalesce(timezone, 'UTC') into v_tz from public.restaurants where id = p_restaurant_id;
  select * into v_settings from public.restaurant_settings where restaurant_id = p_restaurant_id;
  if v_tz is null or v_settings.restaurant_id is null then
    return 'This restaurant isn''t taking pickup orders right now.';
  end if;

  v_local := p_at at time zone v_tz;
  if extract(second from v_local) <> 0
    or ((extract(hour from v_local) * 60 + extract(minute from v_local))::integer
        % v_settings.pickup_slot_minutes) <> 0
  then
    return 'That pickup time isn''t one of the restaurant''s times. Please choose again.';
  end if;

  if p_at < now() + make_interval(mins => v_settings.pickup_lead_minutes) then
    return 'That pickup time is too soon now. Please choose a later one.';
  end if;

  if p_at > now() + public.pickup_max_ahead() then
    return 'That pickup time is too far ahead. Please choose an earlier one.';
  end if;

  if not exists (
    select 1 from public.menus m
    where m.restaurant_id = p_restaurant_id
      and public.menu_on_at(m.id, p_at)
  ) then
    return 'The restaurant is closed at that time. Please choose another.';
  end if;

  select count(*) into v_taken
  from public.orders
  where restaurant_id = p_restaurant_id
    and fulfillment = 'pickup'
    and pickup_at = p_at
    and status <> 'cancelled'
    and (p_exclude_order_id is null or id <> p_exclude_order_id);

  if v_taken >= v_settings.pickup_slot_capacity then
    return 'That pickup time just filled up. Please choose another.';
  end if;

  return null;
end;
$$;

-- One lock per restaurant, held to the end of the transaction, around
-- "count the slot, then take a place in it". Without it, two diners who
-- both see one place left both get it.
create function public.pickup_lock(p_restaurant_id uuid)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('pickup:' || p_restaurant_id::text, 0))
$$;

-- When the kitchen should start, for an order collected at p_pickup_at.
create function public.pickup_release_at(
  p_restaurant_id uuid,
  p_pickup_at timestamptz,
  p_prep_minutes integer
)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_pickup_at
    - make_interval(mins => coalesce(nullif(p_prep_minutes, 0), s.pickup_lead_minutes))
    - make_interval(mins => case when s.busy_until > now() then s.busy_extra_minutes else 0 end)
  from public.restaurant_settings s
  where s.restaurant_id = p_restaurant_id
$$;

revoke execute on function public.special_hours_allow_at(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.menu_on_at(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.pickup_max_ahead() from public, anon, authenticated;
revoke execute on function public.pickup_slot_problem(uuid, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.pickup_lock(uuid) from public, anon, authenticated;
revoke execute on function public.pickup_release_at(uuid, timestamptz, integer) from public, anon, authenticated;

-- 6. Every order placed at a counter is a pickup order ---------------------

create function public.apply_pickup_to_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cart public.carts%rowtype;
  v_problem text;
  v_prep integer;
begin
  if not exists (
    select 1 from public.tables
    where id = new.table_id and kind = 'counter'
  ) then
    -- A table's order is a dine-in order, whatever the insert said.
    new.fulfillment := 'dine_in';
    new.pickup_at := null;
    new.pickup_name := null;
    new.ticket_release_at := null;
    return new;
  end if;

  select * into v_cart
  from public.carts
  where customer_session_id = new.customer_session_id;

  if v_cart.pickup_at is null then
    raise exception 'ORDER_PICKUP: Choose a pickup time before placing your order.';
  end if;
  if v_cart.pickup_name is null then
    raise exception 'ORDER_PICKUP: Add the name we should call out at pickup.';
  end if;

  perform public.pickup_lock(new.restaurant_id);
  v_problem := public.pickup_slot_problem(new.restaurant_id, v_cart.pickup_at);
  if v_problem is not null then
    raise exception 'ORDER_PICKUP: %', v_problem;
  end if;

  -- The cart's lines are still there: submit_order() empties the cart
  -- after inserting the order.
  select max(mi.preparation_time) into v_prep
  from public.cart_items ci
  join public.menu_items mi on mi.id = ci.menu_item_id
  where ci.cart_id = v_cart.id;

  new.fulfillment := 'pickup';
  new.pickup_at := v_cart.pickup_at;
  new.pickup_name := trim(v_cart.pickup_name);
  new.ticket_release_at := public.pickup_release_at(new.restaurant_id, v_cart.pickup_at, v_prep);

  -- A later order in the same visit picks its own time.
  update public.carts set pickup_at = null where id = v_cart.id;

  return new;
end;
$$;

create trigger trg_orders_apply_pickup
  before insert on public.orders
  for each row
  execute function public.apply_pickup_to_order();

-- 7. What the diner calls --------------------------------------------------

-- The cart page's one read: whether this visit is at a counter, the
-- restaurant's timezone (to show times), the diner's current choice, and
-- the slots from the earliest allowed to pickup_max_ahead(), each with the
-- places left. Slots when the restaurant is closed are left out; full ones
-- are kept, with 0, so the diner sees why a time is missing.
create function public.get_pickup_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions%rowtype;
  v_tz text;
  v_settings public.restaurant_settings%rowtype;
  v_cart public.carts%rowtype;
  v_step interval;
  v_first timestamptz;
  v_local timestamp;
  v_minutes integer;
  v_slots jsonb := '[]'::jsonb;
  v_at timestamptz;
  v_taken integer;
begin
  select * into v_session
  from public.customer_sessions
  where user_id = auth.uid() and status = 'active' and expires_at > now()
  limit 1;

  if not found or not exists (
    select 1 from public.tables
    where id = v_session.table_id and kind = 'counter'
  ) then
    return jsonb_build_object('is_counter', false);
  end if;

  select coalesce(timezone, 'UTC') into v_tz from public.restaurants where id = v_session.restaurant_id;
  select * into v_settings from public.restaurant_settings where restaurant_id = v_session.restaurant_id;
  select * into v_cart from public.carts where customer_session_id = v_session.id;

  v_step := make_interval(mins => v_settings.pickup_slot_minutes);

  -- The first time on the grid, in the restaurant's own clock, at least
  -- the lead time away. Stepping in absolute time from there stays on the
  -- grid across a daylight-saving change, because every slot length
  -- divides the hour the clock moves by.
  v_local := date_trunc('minute', (now() + make_interval(mins => v_settings.pickup_lead_minutes)) at time zone v_tz);
  if extract(second from ((now() + make_interval(mins => v_settings.pickup_lead_minutes)) at time zone v_tz)) > 0 then
    v_local := v_local + interval '1 minute';
  end if;
  v_minutes := (extract(hour from v_local) * 60 + extract(minute from v_local))::integer;
  if v_minutes % v_settings.pickup_slot_minutes <> 0 then
    v_local := v_local + make_interval(mins => v_settings.pickup_slot_minutes - v_minutes % v_settings.pickup_slot_minutes);
  end if;
  v_first := v_local at time zone v_tz;

  for v_at in
    select g from generate_series(v_first, now() + public.pickup_max_ahead(), v_step) g
  loop
    if exists (
      select 1 from public.menus m
      where m.restaurant_id = v_session.restaurant_id
        and public.menu_on_at(m.id, v_at)
    ) then
      select count(*) into v_taken
      from public.orders
      where restaurant_id = v_session.restaurant_id
        and fulfillment = 'pickup'
        and pickup_at = v_at
        and status <> 'cancelled';

      v_slots := v_slots || jsonb_build_object(
        'at', v_at,
        'places_left', greatest(v_settings.pickup_slot_capacity - v_taken, 0)
      );
    end if;
  end loop;

  return jsonb_build_object(
    'is_counter', true,
    'timezone', v_tz,
    'chosen_at', v_cart.pickup_at,
    'chosen_name', v_cart.pickup_name,
    'slots', v_slots
  );
end;
$$;

-- The diner's choice, checked now so they hear about a bad time before
-- they press "Place order". It is checked again, under the lock, when the
-- order is placed — this answer can be out of date by then.
create function public.set_cart_pickup(p_pickup_at timestamptz, p_pickup_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions%rowtype;
  v_name text := nullif(trim(coalesce(p_pickup_name, '')), '');
  v_problem text;
begin
  select * into v_session
  from public.customer_sessions
  where user_id = auth.uid() and status = 'active' and expires_at > now()
  limit 1;

  if not found then
    raise exception 'ORDER_NO_SESSION: your session has expired — scan the QR code again';
  end if;

  if not exists (
    select 1 from public.tables
    where id = v_session.table_id and kind = 'counter'
  ) then
    raise exception 'ORDER_PICKUP: Pickup times are only for orders placed at a pickup counter.';
  end if;

  if v_name is null then
    raise exception 'ORDER_PICKUP: Add the name we should call out at pickup.';
  end if;
  if length(v_name) > 40 then
    raise exception 'ORDER_PICKUP: Please keep the name to 40 characters.';
  end if;

  v_problem := public.pickup_slot_problem(v_session.restaurant_id, p_pickup_at);
  if v_problem is not null then
    raise exception 'ORDER_PICKUP: %', v_problem;
  end if;

  update public.carts
  set pickup_at = p_pickup_at, pickup_name = v_name
  where customer_session_id = v_session.id;

  if not found then
    raise exception 'ORDER_CART_EMPTY: your cart is empty';
  end if;
end;
$$;

-- 8. What staff call -------------------------------------------------------

-- The kitchen is running late, or the diner rang: move a pickup order to
-- another slot. Any member of the restaurant may, since whoever answers
-- the phone at a counter is often front of house. The new time obeys the
-- same rules as the diner's choice, except the slot it is leaving.
create function public.change_pickup_time(p_order_id uuid, p_pickup_at timestamptz)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_problem text;
  v_prep integer;
begin
  select * into v_order from public.orders where id = p_order_id;

  if not found or not public.is_restaurant_member(v_order.restaurant_id) then
    raise exception 'PICKUP_NOT_FOUND: that order could not be found';
  end if;
  if v_order.fulfillment <> 'pickup' then
    raise exception 'PICKUP_INVALID: that order isn''t a pickup order';
  end if;
  if v_order.status not in ('pending', 'confirmed', 'preparing') then
    raise exception 'PICKUP_INVALID: only an order that isn''t ready yet can be moved';
  end if;

  perform public.pickup_lock(v_order.restaurant_id);
  v_problem := public.pickup_slot_problem(v_order.restaurant_id, p_pickup_at, v_order.id);
  if v_problem is not null then
    raise exception 'PICKUP_INVALID: %', v_problem;
  end if;

  select max(mi.preparation_time) into v_prep
  from public.order_items oi
  join public.menu_items mi on mi.id = oi.menu_item_id
  where oi.order_id = v_order.id;

  update public.orders
  set pickup_at = p_pickup_at,
      ticket_release_at = public.pickup_release_at(v_order.restaurant_id, p_pickup_at, v_prep)
  where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$$;

revoke execute on function public.get_pickup_options() from public, anon;
grant execute on function public.get_pickup_options() to authenticated;
revoke execute on function public.set_cart_pickup(timestamptz, text) from public, anon;
grant execute on function public.set_cart_pickup(timestamptz, text) to authenticated;
revoke execute on function public.change_pickup_time(uuid, timestamptz) from public, anon;
grant execute on function public.change_pickup_time(uuid, timestamptz) to authenticated;
