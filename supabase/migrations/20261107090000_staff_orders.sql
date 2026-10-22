-- Staff ring up orders: the POS screen (/dashboard/pos). Until now every
-- order came from a diner's own phone, through their cart and
-- submit_order(). A restaurant that runs entirely on Tableside also needs
-- the walk-in at the counter, the phone order and the table that would
-- rather tell a waiter, typed by staff.
--
-- An order now has a source:
--   'diner'  placed from a diner's session (customer_session_id set), as
--            before. Every existing row.
--   'staff'  rung up by a member of staff (placed_by), with no diner
--            session behind it.
-- Everything after placing is shared: the kitchen board, tickets, push
-- alerts, Settle up and Reports all read orders, not sessions.
--
-- staff_place_order() prices the lines exactly as submit_order() does
-- (current menu prices, add-on rules, tax, service charge), from a list
-- of lines passed in rather than a cart. Refused, each with its own code:
--   ORDER_STAFF_FORBIDDEN       not owner, manager or staff here
--   ORDER_INVALID_INPUT         malformed lines, key or note
--   ORDER_TABLE_UNAVAILABLE     the table isn't this restaurant's, or is off
--   ORDER_RESTAURANT_UNAVAILABLE
--   ORDER_ITEM_UNAVAILABLE / ORDER_MODIFIER_UNAVAILABLE / ORDER_MODIFIER_INVALID
--   ORDER_ITEM_NOT_SERVED_NOW   (order_items_on_menu_now, unchanged)
--
-- Deliberately NOT applied to staff orders:
--   - accepting_orders and the kitchen's busy-mode pause. Both exist to
--     stop QR orders arriving unseen; a waiter typing an order has already
--     talked to the guest and can say there's a wait.
--   - pickup slot capacity. A counter order from staff is "now".
-- Still applied: a lapsed subscription (refuse_order_when_billing_lapsed)
-- and menu hours.

alter table public.orders
  alter column customer_session_id drop not null,
  add column source text not null default 'diner',
  add column placed_by uuid references auth.users (id) on delete set null,
  add constraint orders_source_valid check (source in ('diner', 'staff')),
  add constraint orders_source_matches_session check (
    (source = 'diner' and customer_session_id is not null)
    or (source = 'staff' and customer_session_id is null)
  );

comment on column public.orders.source is
  '''diner'' (from a diner session, customer_session_id set) or ''staff'' (rung up on the POS screen by placed_by; no session). Written only by submit_order() / staff_place_order().';
comment on column public.orders.placed_by is
  'The staff member who rang up a source = ''staff'' order. Null for diner orders, or if that account was deleted.';

-- A retry of the same send lands on the same order. Keys are random per
-- send, so per restaurant is enough.
create unique index orders_unique_idempotency_staff
  on public.orders (restaurant_id, idempotency_key)
  where source = 'staff';

-- Same rule as before, null-safe now that customer_session_id can be null,
-- and source/placed_by can't be rewritten either.
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
    or new.customer_session_id is distinct from old.customer_session_id
    or new.order_number <> old.order_number
    or new.idempotency_key <> old.idempotency_key
    or new.fulfillment <> old.fulfillment
    or new.pickup_name is distinct from old.pickup_name
    or new.source <> old.source
    or new.placed_by is distinct from old.placed_by
  then
    raise exception 'orders: financial and identity fields are immutable after creation';
  end if;
  return new;
end;
$$;

-- Busy mode pauses QR orders only (see header).
create or replace function public.refuse_order_while_paused()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source = 'staff' then
    return new;
  end if;
  if exists (
    select 1 from public.restaurant_settings s
    where s.restaurant_id = new.restaurant_id
      and s.orders_paused_until > now()
  ) then
    raise exception 'ORDER_PAUSED: the kitchen has paused new orders'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function public.refuse_order_while_paused() from public, anon, authenticated;

-- A staff counter order arrives with its pickup fields already set by
-- staff_place_order(); there is no cart to read them from. Diner orders
-- are handled exactly as before.
create or replace function public.apply_pickup_to_order()
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

  if new.source = 'staff' then
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

-- p_lines: [{ "menu_item_id": uuid, "quantity": 1-99,
--             "modifier_option_ids": [uuid, ...],
--             "notes": text <= 200, "spice_preference": text }, ...]
-- p_pickup_name: the name to call out, for a counter (takeout/phone)
-- order; ignored at a table.
create function public.staff_place_order(
  p_restaurant_id uuid,
  p_table_id uuid,
  p_lines jsonb,
  p_idempotency_key text,
  p_note text default null,
  p_pickup_name text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_restaurant public.restaurants%rowtype;
  v_table public.tables%rowtype;
  v_existing_order public.orders%rowtype;
  v_order public.orders%rowtype;
  v_order_number bigint;
  v_subtotal numeric(10, 2) := 0;
  v_tax numeric(10, 2);
  v_service_charge numeric(10, 2);
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_pickup_name text := nullif(trim(coalesce(p_pickup_name, '')), '');
  v_is_counter boolean;

  v_line jsonb;
  v_line_index integer := 0;
  v_menu_item_id uuid;
  v_quantity integer;
  v_option_ids uuid[];
  v_line_notes text;
  v_spice text;
  v_menu_item record;
  v_category_active boolean;
  v_group record;
  v_selected_count integer;
  v_effective_min integer;
  v_line_modifier_total numeric(10, 2);
  v_line_total numeric(10, 2);
  v_order_item_id uuid;
  v_modifier record;
begin
  v_role := public.current_restaurant_role(p_restaurant_id);
  if v_user_id is null or v_role is null or v_role not in ('owner', 'manager', 'staff') then
    raise exception 'ORDER_STAFF_FORBIDDEN: only owners, managers and staff can ring up orders'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0
    or length(p_idempotency_key) > 100 then
    raise exception 'ORDER_INVALID_INPUT: a valid idempotency key is required';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'ORDER_INVALID_INPUT: the order note is too long (500 characters max)';
  end if;
  if v_pickup_name is not null and length(v_pickup_name) > 60 then
    raise exception 'ORDER_INVALID_INPUT: the name is too long (60 characters max)';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
    or jsonb_array_length(p_lines) = 0 then
    raise exception 'ORDER_INVALID_INPUT: add at least one dish';
  end if;
  if jsonb_array_length(p_lines) > 100 then
    raise exception 'ORDER_INVALID_INPUT: too many lines in one order';
  end if;

  select * into v_existing_order
  from public.orders
  where restaurant_id = p_restaurant_id
    and source = 'staff'
    and idempotency_key = p_idempotency_key;
  if found then
    return v_existing_order;
  end if;

  select * into v_restaurant from public.restaurants where id = p_restaurant_id;
  if not found or not v_restaurant.is_active then
    raise exception 'ORDER_RESTAURANT_UNAVAILABLE: this restaurant is not currently taking orders';
  end if;

  select * into v_table
  from public.tables
  where id = p_table_id and restaurant_id = p_restaurant_id;
  if not found or not v_table.is_active then
    raise exception 'ORDER_TABLE_UNAVAILABLE: that table isn''t available';
  end if;
  v_is_counter := v_table.kind = 'counter';

  -- PASS 1: validate and price every line against the current menu, the
  -- same rules as submit_order(), with no writes.
  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_line_index := v_line_index + 1;
    begin
      v_menu_item_id := (v_line ->> 'menu_item_id')::uuid;
      v_quantity := coalesce((v_line ->> 'quantity')::integer, 1);
      v_option_ids := coalesce(
        array(select jsonb_array_elements_text(coalesce(v_line -> 'modifier_option_ids', '[]'::jsonb))::uuid),
        '{}'
      );
    exception when others then
      raise exception 'ORDER_INVALID_INPUT: line % is malformed', v_line_index;
    end;
    v_line_notes := nullif(trim(coalesce(v_line ->> 'notes', '')), '');
    v_spice := nullif(v_line ->> 'spice_preference', '');

    if v_menu_item_id is null or v_quantity < 1 or v_quantity > 99 then
      raise exception 'ORDER_INVALID_INPUT: line % is malformed', v_line_index;
    end if;
    if v_line_notes is not null and length(v_line_notes) > 200 then
      raise exception 'ORDER_INVALID_INPUT: a dish note is too long (200 characters max)';
    end if;
    if v_spice is not null and v_spice not in ('none', 'mild', 'medium', 'hot', 'very_hot') then
      raise exception 'ORDER_INVALID_INPUT: line % has an unknown spice level', v_line_index;
    end if;
    if cardinality(v_option_ids) <> (select count(distinct x) from unnest(v_option_ids) x) then
      raise exception 'ORDER_INVALID_INPUT: line % repeats an add-on', v_line_index;
    end if;

    select mi.id, mi.name, mi.price, mi.is_available, mi.category_id
    into v_menu_item
    from public.menu_items mi
    where mi.id = v_menu_item_id
      and mi.restaurant_id = p_restaurant_id;

    if not found or not v_menu_item.is_available then
      raise exception 'ORDER_ITEM_UNAVAILABLE: a dish in this order is no longer available';
    end if;

    select is_active into v_category_active
    from public.categories
    where id = v_menu_item.category_id;
    if not found or not v_category_active then
      raise exception 'ORDER_ITEM_UNAVAILABLE: "%" is no longer available', v_menu_item.name;
    end if;

    -- Every chosen option must belong to one of this dish's groups.
    if exists (
      select 1 from unnest(v_option_ids) as opt(id)
      where not exists (
        select 1
        from public.modifier_options mo
        join public.menu_item_modifiers mim on mim.id = mo.modifier_id
        where mo.id = opt.id and mim.menu_item_id = v_menu_item.id
      )
    ) then
      raise exception 'ORDER_MODIFIER_INVALID: an add-on doesn''t belong to "%"', v_menu_item.name;
    end if;

    v_line_modifier_total := 0;
    for v_modifier in
      select mo.price_adjustment, mo.is_available, mo.name as option_name
      from public.modifier_options mo
      where mo.id = any (v_option_ids)
    loop
      if not v_modifier.is_available then
        raise exception 'ORDER_MODIFIER_UNAVAILABLE: "%" is no longer available', v_modifier.option_name;
      end if;
      v_line_modifier_total := v_line_modifier_total + v_modifier.price_adjustment;
    end loop;

    for v_group in
      select id, name, is_required, min_selections, max_selections
      from public.menu_item_modifiers
      where menu_item_id = v_menu_item.id
    loop
      select count(*) into v_selected_count
      from public.modifier_options mo
      where mo.id = any (v_option_ids) and mo.modifier_id = v_group.id;

      v_effective_min := case
        when v_group.is_required then greatest(1, v_group.min_selections)
        else v_group.min_selections
      end;

      if v_selected_count < v_effective_min or v_selected_count > v_group.max_selections then
        raise exception 'ORDER_MODIFIER_INVALID: choose the options for "%" on "%"', v_group.name, v_menu_item.name;
      end if;
    end loop;

    v_line_total := round((v_menu_item.price + v_line_modifier_total) * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;
  end loop;

  v_tax := round(v_subtotal * v_restaurant.tax_rate, 2);
  v_service_charge := round(v_subtotal * v_restaurant.service_charge, 2);

  begin
    insert into public.order_number_counters (restaurant_id, last_number)
    values (p_restaurant_id, 1)
    on conflict (restaurant_id) do update
      set last_number = order_number_counters.last_number + 1
    returning last_number into v_order_number;

    insert into public.orders (
      restaurant_id, table_id, customer_session_id, source, placed_by,
      order_number, status, subtotal, tax, service_charge, total, currency,
      customer_note, idempotency_key,
      fulfillment, pickup_at, pickup_name, ticket_release_at
    ) values (
      p_restaurant_id, p_table_id, null, 'staff', v_user_id,
      v_order_number, 'pending', v_subtotal, v_tax, v_service_charge,
      v_subtotal + v_tax + v_service_charge, v_restaurant.currency,
      v_note, p_idempotency_key,
      case when v_is_counter then 'pickup' else 'dine_in' end,
      case when v_is_counter then now() end,
      case when v_is_counter then coalesce(v_pickup_name, 'Walk-in') end,
      case when v_is_counter then now() end
    )
    returning * into v_order;
  exception when unique_violation then
    -- A concurrent retry of the same send won the race.
    select * into v_existing_order
    from public.orders
    where restaurant_id = p_restaurant_id
      and source = 'staff'
      and idempotency_key = p_idempotency_key;
    if found then
      return v_existing_order;
    end if;
    raise;
  end;

  -- PASS 2: write the lines, re-deriving the same values in the same
  -- snapshot.
  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_menu_item_id := (v_line ->> 'menu_item_id')::uuid;
    v_quantity := coalesce((v_line ->> 'quantity')::integer, 1);
    v_option_ids := coalesce(
      array(select jsonb_array_elements_text(coalesce(v_line -> 'modifier_option_ids', '[]'::jsonb))::uuid),
      '{}'
    );
    v_line_notes := nullif(trim(coalesce(v_line ->> 'notes', '')), '');
    v_spice := nullif(v_line ->> 'spice_preference', '');

    select mi.id, mi.name, mi.price into v_menu_item
    from public.menu_items mi
    where mi.id = v_menu_item_id and mi.restaurant_id = p_restaurant_id;

    select coalesce(sum(mo.price_adjustment), 0) into v_line_modifier_total
    from public.modifier_options mo
    where mo.id = any (v_option_ids);

    v_line_total := round((v_menu_item.price + v_line_modifier_total) * v_quantity, 2);

    insert into public.order_items (
      restaurant_id, order_id, menu_item_id, item_name, quantity,
      unit_price, modifier_total, line_total, spice_preference, notes
    ) values (
      p_restaurant_id, v_order.id, v_menu_item.id, v_menu_item.name, v_quantity,
      v_menu_item.price, v_line_modifier_total, v_line_total, v_spice, v_line_notes
    )
    returning id into v_order_item_id;

    insert into public.order_item_modifiers (
      restaurant_id, order_item_id, modifier_option_id,
      modifier_group_name, modifier_option_name, price_adjustment
    )
    select p_restaurant_id, v_order_item_id, mo.id, mim.name, mo.name, mo.price_adjustment
    from public.modifier_options mo
    join public.menu_item_modifiers mim on mim.id = mo.modifier_id
    where mo.id = any (v_option_ids);
  end loop;

  insert into public.order_status_history (restaurant_id, order_id, status, actor_type, actor_id)
  values (p_restaurant_id, v_order.id, 'pending', v_role, v_user_id);

  return v_order;
end;
$$;

comment on function public.staff_place_order(uuid, uuid, jsonb, text, text, text) is
  'The POS screen: a member of staff (owner, manager or staff) rings up an order for a table, or for a pickup counter under a name. Priced from the current menu like submit_order(); idempotent per (restaurant, key).';

revoke execute on function public.staff_place_order(uuid, uuid, jsonb, text, text, text) from public, anon;
grant execute on function public.staff_place_order(uuid, uuid, jsonb, text, text, text) to authenticated;
