-- Let a diner say how they want THIS plate cooked.
--
-- menu_items.spice_level says what a dish IS — an aloo paratha is mild.
-- This is the other half: what the person eating it WANTS. They are not
-- the same fact and cannot share a column, because two people at one
-- table order the same dish at different heat, and the kitchen needs to
-- read the request rather than the default.
--
-- Two fields, because "how spicy?" and "anything else?" are different
-- questions. spice_preference is a fixed ladder, so a ticket renders it
-- consistently and the AI can state it back without paraphrasing; notes
-- is free text for what a ladder cannot express ("no onions", "my
-- daughter is sharing this"). A cook can act on the first at a glance;
-- the second has to be read.
--
-- order_items.notes already existed and nothing had ever written to it —
-- submit_order simply did not carry it across. It does now.
--
-- No price adjustment. Asking for a dish hotter is not an upsell, and
-- charging for it would be a surprise at the till. Anything a restaurant
-- genuinely wants to charge for is a modifier option, which already
-- exists and already prices itself.

alter table public.cart_items
  add column spice_preference text,
  add column notes text;

alter table public.cart_items
  add constraint cart_items_spice_preference_valid
  check (
    spice_preference is null
    or spice_preference in ('none', 'mild', 'medium', 'hot', 'very_hot')
  );

-- Bounded for the same reason the order-level note is: an anonymous diner
-- writes this and a kitchen ticket prints it.
alter table public.cart_items
  add constraint cart_items_notes_length
  check (notes is null or char_length(notes) <= 200);

alter table public.order_items
  add column spice_preference text;

alter table public.order_items
  add constraint order_items_spice_preference_valid
  check (
    spice_preference is null
    or spice_preference in ('none', 'mild', 'medium', 'hot', 'very_hot')
  );

comment on column public.cart_items.spice_preference is
  'How this diner wants THIS line cooked, independent of the dish''s own menu_items.spice_level. NULL means "however you normally make it". Copied onto the order line by submit_order.';

comment on column public.cart_items.notes is
  'Free-text request for this line ("no onions"), max 200 chars. Copied to order_items.notes by submit_order. Gated by the restaurant''s allow_customer_notes setting, like the order-level note.';

comment on column public.order_items.spice_preference is
  'The heat this diner asked for on this line, captured at submission. Immutable afterwards, like every other order_items column.';

-- submit_order is recreated verbatim from
-- 20260826100000_submit_order_cart_lock.sql with exactly two changes:
-- pass 2 now selects spice_preference/notes from the cart line and writes
-- them onto the order line. The cart lock, both idempotency checks, the
-- two-pass pricing and the unique_violation catch are untouched — this is
-- the only path from a cart to an order and its concurrency behaviour is
-- load-bearing. Pass 1 is deliberately NOT changed: it prices the order,
-- and neither field affects price.

create or replace function public.submit_order(
  p_idempotency_key text,
  p_customer_note text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.customer_sessions%rowtype;
  v_restaurant public.restaurants%rowtype;
  v_settings public.restaurant_settings%rowtype;
  v_cart public.carts%rowtype;
  v_existing_order public.orders%rowtype;
  v_order public.orders%rowtype;
  v_order_number bigint;
  v_subtotal numeric(10, 2) := 0;
  v_tax numeric(10, 2);
  v_service_charge numeric(10, 2);
  v_note text := p_customer_note;

  v_cart_item record;
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
  if v_user_id is null then
    raise exception 'ORDER_NO_SESSION: sign-in required' using errcode = '28000';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'ORDER_INVALID_INPUT: an idempotency key is required';
  end if;
  if length(p_idempotency_key) > 100 then
    raise exception 'ORDER_INVALID_INPUT: idempotency key is too long';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'ORDER_INVALID_INPUT: customer note is too long (500 characters max)';
  end if;

  select *
  into v_session
  from public.customer_sessions
  where user_id = v_user_id
    and status = 'active'
    and expires_at > now()
  limit 1;

  if not found then
    raise exception 'ORDER_NO_SESSION: your session has expired — scan the table''s QR code again';
  end if;

  -- Fast path: an unlocked pre-check so a genuine sequential retry (by
  -- far the common case) never has to wait on a lock at all. A racing
  -- concurrent retry that slips past this is still caught below, after
  -- the cart lock is acquired.
  select *
  into v_existing_order
  from public.orders
  where customer_session_id = v_session.id
    and idempotency_key = p_idempotency_key;

  if found then
    return v_existing_order;
  end if;

  select * into v_restaurant from public.restaurants where id = v_session.restaurant_id;
  if not found or not v_restaurant.is_active then
    raise exception 'ORDER_RESTAURANT_UNAVAILABLE: this restaurant is not currently accepting orders';
  end if;

  select * into v_settings from public.restaurant_settings where restaurant_id = v_restaurant.id;
  if not found or not v_settings.accepting_orders then
    raise exception 'ORDER_RESTAURANT_UNAVAILABLE: this restaurant is not currently accepting orders';
  end if;

  if v_note is not null and not v_settings.allow_customer_notes then
    v_note := null;
  end if;

  -- Row lock: the actual mechanism behind "two concurrent submissions for
  -- the same cart -> at most one succeeds." A concurrent second caller
  -- blocks here until the first transaction commits (or rolls back), then
  -- proceeds against a now-consistent view — see this migration's header
  -- comment.
  select * into v_cart
  from public.carts
  where customer_session_id = v_session.id
  for update;

  if not found then
    raise exception 'ORDER_CART_EMPTY: your cart is empty';
  end if;

  -- Re-check, now that the cart is locked: a caller that lost a SAME-key
  -- race (its early pre-check above ran before the winner committed) must
  -- still return the winner's order here, not fall through and see the
  -- winner's now-emptied cart as ORDER_CART_EMPTY. A caller with a
  -- genuinely different key finds nothing here (correctly) and falls
  -- through to the cart-emptiness check below.
  select *
  into v_existing_order
  from public.orders
  where customer_session_id = v_session.id
    and idempotency_key = p_idempotency_key;

  if found then
    return v_existing_order;
  end if;

  if not exists (select 1 from public.cart_items where cart_id = v_cart.id) then
    raise exception 'ORDER_CART_EMPTY: your cart is empty';
  end if;

  -- PASS 1 (validate + price only, no writes): re-validate every cart line
  -- against CURRENT menu data — see 20260823100600_submit_order_function.sql's
  -- header comment for why this re-expresses (not duplicates)
  -- src/lib/cart/validate.ts's rules in SQL. Accumulates the real subtotal
  -- so the order row can be inserted once, with final numbers — no
  -- placeholder-then-update.
  for v_cart_item in
    select id, menu_item_id, quantity
    from public.cart_items
    where cart_id = v_cart.id
    order by created_at asc
  loop
    select mi.id, mi.name, mi.price, mi.is_available, mi.category_id
    into v_menu_item
    from public.menu_items mi
    where mi.id = v_cart_item.menu_item_id
      and mi.restaurant_id = v_restaurant.id;

    if not found or not v_menu_item.is_available then
      raise exception 'ORDER_ITEM_UNAVAILABLE: an item in your cart is no longer available — please review your cart';
    end if;

    select is_active into v_category_active
    from public.categories
    where id = v_menu_item.category_id;

    if not found or not v_category_active then
      raise exception 'ORDER_ITEM_UNAVAILABLE: an item in your cart is no longer available — please review your cart';
    end if;

    v_line_modifier_total := 0;
    for v_modifier in
      select mo.price_adjustment, mo.is_available, mo.name as option_name
      from public.cart_item_modifiers cim
      join public.modifier_options mo on mo.id = cim.modifier_option_id
      where cim.cart_item_id = v_cart_item.id
    loop
      if not v_modifier.is_available then
        raise exception 'ORDER_MODIFIER_UNAVAILABLE: "%" is no longer available — please review your cart', v_modifier.option_name;
      end if;
      v_line_modifier_total := v_line_modifier_total + v_modifier.price_adjustment;
    end loop;

    for v_group in
      select id, name, is_required, min_selections, max_selections
      from public.menu_item_modifiers
      where menu_item_id = v_menu_item.id
    loop
      select count(*)
      into v_selected_count
      from public.cart_item_modifiers cim
      join public.modifier_options mo on mo.id = cim.modifier_option_id
      where cim.cart_item_id = v_cart_item.id
        and mo.modifier_id = v_group.id;

      v_effective_min := case
        when v_group.is_required then greatest(1, v_group.min_selections)
        else v_group.min_selections
      end;

      if v_selected_count < v_effective_min or v_selected_count > v_group.max_selections then
        raise exception 'ORDER_MODIFIER_INVALID: the selections for "%" are no longer valid — please review your cart', v_group.name;
      end if;
    end loop;

    v_line_total := round((v_menu_item.price + v_line_modifier_total) * v_cart_item.quantity, 2);
    v_subtotal := v_subtotal + v_line_total;
  end loop;

  v_tax := round(v_subtotal * v_restaurant.tax_rate, 2);
  v_service_charge := round(v_subtotal * v_restaurant.service_charge, 2);

  -- Allocate the order number and create the order row ONCE, with its
  -- final totals already known — no subsequent UPDATE to this row ever
  -- happens again (trg_orders_enforce_immutable_fields now guarantees
  -- that structurally). Scoped exception handling here, and only here:
  -- a concurrent call racing on the same (session, key) pair can lose the
  -- orders_unique_idempotency_per_session constraint, which we catch and
  -- resolve to the winner's row. With the cart lock above, the two
  -- idempotency checks already resolve this for the SAME-key case before
  -- reaching this insert at all — this remains as defense in depth, not
  -- the sole mechanism.
  begin
    insert into public.order_number_counters (restaurant_id, last_number)
    values (v_restaurant.id, 1)
    on conflict (restaurant_id) do update
      set last_number = order_number_counters.last_number + 1
    returning last_number into v_order_number;

    insert into public.orders (
      restaurant_id, table_id, customer_session_id, order_number, status,
      subtotal, tax, service_charge, total, currency, customer_note, idempotency_key
    ) values (
      v_restaurant.id, v_session.table_id, v_session.id, v_order_number, 'pending',
      v_subtotal, v_tax, v_service_charge, v_subtotal + v_tax + v_service_charge,
      v_restaurant.currency, v_note, p_idempotency_key
    )
    returning * into v_order;
  exception when unique_violation then
    select *
    into v_existing_order
    from public.orders
    where customer_session_id = v_session.id
      and idempotency_key = p_idempotency_key;

    if found then
      return v_existing_order;
    end if;
    raise;
  end;

  -- PASS 2: re-derive the identical per-line values (same transaction, same
  -- snapshot — nothing can have changed since pass 1) purely to write the
  -- order_items/order_item_modifiers rows now that v_order.id exists.
  for v_cart_item in
    select id, menu_item_id, quantity, spice_preference, notes
    from public.cart_items
    where cart_id = v_cart.id
    order by created_at asc
  loop
    select mi.id, mi.name, mi.price
    into v_menu_item
    from public.menu_items mi
    where mi.id = v_cart_item.menu_item_id
      and mi.restaurant_id = v_restaurant.id;

    v_line_modifier_total := 0;
    for v_modifier in
      select mo.price_adjustment
      from public.cart_item_modifiers cim
      join public.modifier_options mo on mo.id = cim.modifier_option_id
      where cim.cart_item_id = v_cart_item.id
    loop
      v_line_modifier_total := v_line_modifier_total + v_modifier.price_adjustment;
    end loop;

    v_line_total := round((v_menu_item.price + v_line_modifier_total) * v_cart_item.quantity, 2);

    insert into public.order_items (
      restaurant_id, order_id, menu_item_id, item_name, quantity,
      unit_price, modifier_total, line_total, spice_preference, notes
    ) values (
      v_restaurant.id, v_order.id, v_menu_item.id, v_menu_item.name, v_cart_item.quantity,
      v_menu_item.price, v_line_modifier_total, v_line_total,
      v_cart_item.spice_preference, v_cart_item.notes
    )
    returning id into v_order_item_id;

    for v_modifier in
      select cim.modifier_option_id, mo.price_adjustment, mo.name as option_name, mim.name as group_name
      from public.cart_item_modifiers cim
      join public.modifier_options mo on mo.id = cim.modifier_option_id
      join public.menu_item_modifiers mim on mim.id = mo.modifier_id
      where cim.cart_item_id = v_cart_item.id
    loop
      insert into public.order_item_modifiers (
        restaurant_id, order_item_id, modifier_option_id,
        modifier_group_name, modifier_option_name, price_adjustment
      ) values (
        v_restaurant.id, v_order_item_id, v_modifier.modifier_option_id,
        v_modifier.group_name, v_modifier.option_name, v_modifier.price_adjustment
      );
    end loop;
  end loop;

  insert into public.order_status_history (restaurant_id, order_id, status, actor_type, actor_id)
  values (v_restaurant.id, v_order.id, 'pending', 'customer', v_user_id);

  delete from public.cart_items where cart_id = v_cart.id;

  return v_order;
end;
$$;

comment on function public.submit_order(text, text) is
  'The only path from a cart to an order. Validates and prices every line against current menu data (pass 1), inserts the order once with its final totals, writes order_items/order_item_modifiers including each line''s requested spice level and note (pass 2), then the initial status-history row, then clears the submitted cart. Locks the cart row (for update) before deciding it is non-empty, so concurrent submissions of the same cart with different idempotency keys serialize rather than both succeeding — see 20260826100000_submit_order_cart_lock.sql. See docs/database.md#order-submission-submit_order and docs/security.md#order-submission.';

grant execute on function public.submit_order(text, text) to authenticated;
