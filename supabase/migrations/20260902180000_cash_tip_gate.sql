-- record_cash_payment() ignored tipping_enabled.
--
-- Every other payment path enforces it. start_order_payment() and
-- start_tab_payment() both raise PAYMENT_TIPPING_DISABLED when a tip
-- arrives at a restaurant with tipping switched off; cash accepted one
-- silently. A restaurant that deliberately does not take tips could still
-- have them recorded against its cash takings, where they would show up in
-- the tips figure on Reports as money it had decided not to accept.
--
-- The UI already hid the field. That is not the same as enforcing it: the
-- function is reachable directly, and a hidden field is a presentation
-- choice, not a rule. The rule belongs here, where every caller meets it.
--
-- Low severity — a staff member adding a tip at their own restaurant, with
-- the order total still summed server-side, so no customer could be
-- overcharged by it. Worth fixing anyway, because a setting that is
-- enforced in three places out of four is worse than one enforced nowhere:
-- it invites the reader to trust it.
--
-- Nothing else about the function changes. The body below is the version
-- from 20260902100000 with the settings lookup restructured to read the
-- row once — it needed two columns from it rather than one — plus the new
-- check, worded and coded exactly as the card paths word it.

create or replace function public.record_cash_payment(
  p_order_ids uuid[],
  p_tip_amount numeric default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_settings public.restaurant_settings%rowtype;
  v_currency text;
  v_total numeric(10, 2);
  v_count integer;
  v_payment_id uuid;
begin
  if p_order_ids is null or array_length(p_order_ids, 1) is null then
    raise exception 'PAYMENT_NO_ORDERS: no orders given' using errcode = '22023';
  end if;

  if p_tip_amount is null or p_tip_amount < 0 then
    raise exception 'Tip cannot be negative' using errcode = '22023';
  end if;

  -- Every order must belong to one restaurant. Mixing them would let a
  -- member of restaurant A settle restaurant B's order in the same call.
  select count(distinct o.restaurant_id) into v_count
  from public.orders o where o.id = any(p_order_ids);

  if v_count = 0 then
    raise exception 'PAYMENT_ORDER_NOT_FOUND: no such order' using errcode = 'P0002';
  end if;
  if v_count > 1 then
    raise exception 'PAYMENT_MIXED_RESTAURANTS: orders belong to different restaurants'
      using errcode = '22023';
  end if;

  select o.restaurant_id into v_restaurant_id
  from public.orders o where o.id = any(p_order_ids) limit 1;

  -- SECURITY DEFINER bypasses RLS, so this membership check IS the access
  -- control. Any member may record cash — see the header of
  -- 20260902100000_cash_payments.sql for why.
  if not public.is_restaurant_member(v_restaurant_id) then
    raise exception 'PAYMENT_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;

  select * into v_settings
  from public.restaurant_settings s
  where s.restaurant_id = v_restaurant_id;

  if not found or not v_settings.accept_cash then
    raise exception 'PAYMENT_CASH_NOT_ACCEPTED: restaurant does not record cash payments'
      using errcode = '22023';
  end if;

  -- The gap this migration exists to close. Same condition, same code and
  -- same wording as start_order_payment() and start_tab_payment(), so the
  -- three paths cannot drift into disagreeing about what the setting means.
  if not v_settings.tipping_enabled and p_tip_amount > 0 then
    raise exception 'PAYMENT_TIPPING_DISABLED: restaurant has tipping switched off'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.orders o
    where o.id = any(p_order_ids) and o.status = 'cancelled'
  ) then
    raise exception 'PAYMENT_ORDER_CANCELLED: order was cancelled' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.payment_orders po
    join public.order_payments p on p.id = po.payment_id
    where po.order_id = any(p_order_ids) and p.status = 'succeeded'
  ) then
    raise exception 'PAYMENT_ALREADY_PAID: order already has a succeeded payment'
      using errcode = '23505';
  end if;

  select sum(o.total), min(o.currency), count(*)
  into v_total, v_currency, v_count
  from public.orders o where o.id = any(p_order_ids);

  if exists (
    select 1 from public.orders o
    where o.id = any(p_order_ids) and o.currency <> v_currency
  ) then
    raise exception 'PAYMENT_MIXED_CURRENCY: orders mix currencies' using errcode = '22023';
  end if;

  insert into public.order_payments (
    restaurant_id, status, method, amount, tip_amount, currency,
    paid_at, recorded_by
  ) values (
    v_restaurant_id, 'succeeded', 'cash', v_total, p_tip_amount, v_currency,
    now(), auth.uid()
  )
  returning id into v_payment_id;

  insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
  select v_payment_id, o.id, v_restaurant_id, o.total
  from public.orders o where o.id = any(p_order_ids);

  return v_payment_id;
end;
$$;

comment on function public.record_cash_payment(uuid[], numeric) is
  'Records cash taken at the table for one order or a whole tab, settled immediately. Any restaurant member may call it; the amount is summed from the orders, never supplied by the caller, and a tip is refused when the restaurant has tipping switched off. See docs/security.md#payments.';
