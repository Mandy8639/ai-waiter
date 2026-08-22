-- The order engine's single entry point. Mirrors create_restaurant()'s
-- established pattern (20260821131500_create_restaurant_function.sql): one
-- SECURITY DEFINER PL/pgSQL function body, called via the caller's own
-- per-request (RLS-respecting) Supabase client — never the admin/
-- service-role client (docs/security.md#order-submission). The elevated
-- privilege is needed for exactly the same class of reason
-- create_restaurant() needed it: this function writes across six tables
-- (orders, order_items, order_item_modifiers, order_status_history,
-- order_number_counters, cart_items) as one atomic transaction, including
-- order_number_counters, which has no client-facing RLS policy at all.
--
-- Deliberately takes NO order contents as parameters — no cart id, no line
-- items, no prices, nothing about restaurant/table/session. The only
-- inputs are p_idempotency_key and an optional p_customer_note. Everything
-- else — which restaurant, which table, which cart, what's actually in
-- it, what it costs — is derived entirely server-side from auth.uid() and
-- current database state. This is what makes "a customer cannot submit
-- another session's cart," "cannot change the price/total," and "cannot
-- change restaurant_id/table_id/session_id" structurally true rather than
-- merely validated: there is no parameter through which any of those
-- values could even be supplied.
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

  -- The caller's own active session, resolved purely from auth.uid() —
  -- never a client-supplied session id (docs/security.md#secure-customer-sessions).
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

  -- Idempotency fast path: a prior successful call with this exact
  -- (session, key) pair already produced an order — return it unchanged,
  -- no re-validation, no new order number burned. See
  -- docs/security.md#idempotency.
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

  -- A note the restaurant doesn't accept is dropped, not treated as a
  -- reason to fail the whole order.
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

  -- Allocate the order number and create the (initially zero-totaled) order
  -- row now. Scoped exception handling here, and only here: a concurrent
  -- call racing on the same (session, key) pair can lose the
  -- orders_unique_idempotency_per_session constraint below, which we catch
  -- and resolve to the winner's row — "both requests receive the same
  -- logical order result" even under true concurrency, not just sequential
  -- retries (spec section 11). Everything from here to the end of the
  -- function runs OUTSIDE any exception handler: if cart validation fails
  -- below, the RAISE propagates all the way out uncaught, and Postgres
  -- rolls back the entire transaction — this order row and the counter
  -- increment included — so a failed submission never leaves a partial
  -- order visible (spec section 10).
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
      0, 0, 0, 0, v_restaurant.currency, v_note, p_idempotency_key
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
    -- A unique_violation that isn't the idempotency race (e.g. a genuine
    -- order_number collision, which the atomic counter above should make
    -- impossible) is a real failure — surface it rather than mask it.
    raise;
  end;

  -- Re-validate and re-price every cart line against CURRENT menu data —
  -- never the price/availability snapshot cart_items/cart_item_modifiers
  -- captured at add-to-cart time (docs/security.md#price-validation). This
  -- necessarily re-expresses, in SQL, the same predicates
  -- src/lib/cart/validate.ts already applies at add-to-cart/
  -- update-quantity time (item + category availability, modifier group
  -- required/min/max, price = base + adjustments) — the two can't
  -- literally share one function body, since this one must run as a single
  -- atomic transaction across six tables while validateAndPriceSelection()
  -- is a single-item PostgREST-backed check. See
  -- docs/security.md#order-pricing for the full reasoning; both sides are
  -- covered by tests asserting matching behavior, and changing one without
  -- the other is called out there as the thing to watch for.
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

    -- Every currently-selected option must still exist and be available;
    -- price/name are read fresh here — never trusted from
    -- cart_item_modifiers' own add-time snapshot.
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

    -- Re-check each modifier group's CURRENT required/min/max rules
    -- against what's actually selected — a restaurant may have tightened
    -- these after the item was added to the cart (spec section 14).
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

    v_subtotal := v_subtotal + v_line_total;
  end loop;

  -- Tax and service charge use the restaurant's CURRENT rates, snapshotted
  -- into this order now — never recomputed later against a rate the
  -- restaurant subsequently changes (spec section 9).
  v_tax := round(v_subtotal * v_restaurant.tax_rate, 2);
  v_service_charge := round(v_subtotal * v_restaurant.service_charge, 2);

  update public.orders
  set subtotal = v_subtotal,
      tax = v_tax,
      service_charge = v_service_charge,
      total = v_subtotal + v_tax + v_service_charge
  where id = v_order.id
  returning * into v_order;

  insert into public.order_status_history (restaurant_id, order_id, status, actor_type, actor_id)
  values (v_restaurant.id, v_order.id, 'pending', 'customer', v_user_id);

  -- The submitted cart is no longer "active" — cleared, not deleted (see
  -- docs/database.md#cart-to-order-lifecycle-batch-5). The carts row
  -- itself is kept so the customer can start a fresh round immediately
  -- (e.g. ordering dessert after mains) without a new QR scan. The order
  -- is fully independent of the cart from this point on: everything it
  -- needs was already copied into order_items/order_item_modifiers above.
  delete from public.cart_items where cart_id = v_cart.id;

  return v_order;
end;
$$;

comment on function public.submit_order(text, text) is
  'The only path from a cart to an order. Re-validates and re-prices every line against current menu data, inside one transaction, then atomically allocates an order number and writes order + order_items + order_item_modifiers + the initial status-history row, then clears the submitted cart. See docs/database.md#order-submission-submit_order and docs/security.md#order-submission.';

grant execute on function public.submit_order(text, text) to authenticated;
