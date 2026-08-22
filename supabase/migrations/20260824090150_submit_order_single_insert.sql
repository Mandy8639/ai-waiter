-- Batch 5's submit_order() created the order row with placeholder zero
-- totals, then UPDATEd it once the cart-validation loop had computed real
-- numbers. That single internal UPDATE now collides with this batch's new
-- `trg_orders_enforce_immutable_fields` trigger (20260824090100_order_status_transitions.sql),
-- which correctly rejects ANY change to subtotal/tax/service_charge/total
-- after a row exists — including this one, which was legitimate but is no
-- longer distinguishable from a hostile one at the trigger level (and
-- shouldn't be special-cased there; "orders never change their totals
-- after creation" should have no exceptions).
--
-- Fixed by restructuring into two passes instead of insert-then-update:
-- validate and price every cart line FIRST (no writes), compute final
-- totals, THEN insert the order row once with its real, final numbers.
-- Everything else about submit_order() — the idempotency handling, the
-- per-line revalidation rules, the transactional all-or-nothing guarantee —
-- is unchanged; see 20260823100600_submit_order_function.sql and
-- docs/database.md#order-submission-submit_order for the full design.
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

  select * into v_cart from public.carts where customer_session_id = v_session.id;
  if not found then
    raise exception 'ORDER_CART_EMPTY: your cart is empty';
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
  -- resolve to the winner's row.
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
    select id, menu_item_id, quantity
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
      unit_price, modifier_total, line_total
    ) values (
      v_restaurant.id, v_order.id, v_menu_item.id, v_menu_item.name, v_cart_item.quantity,
      v_menu_item.price, v_line_modifier_total, v_line_total
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
  'The only path from a cart to an order. Validates and prices every line against current menu data (pass 1), inserts the order once with its final totals, writes order_items/order_item_modifiers (pass 2), then the initial status-history row, then clears the submitted cart. See docs/database.md#order-submission-submit_order and docs/security.md#order-submission.';

grant execute on function public.submit_order(text, text) to authenticated;
