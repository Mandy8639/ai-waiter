-- Tap to Pay: staff take a card, phone or watch tapped on their own phone,
-- in the Tableside staff app (Stripe Terminal, Tap to Pay on Android and
-- iPhone). Unlike "paid by card machine" (20261013090000), this IS a charge
-- Tableside makes: a card-present PaymentIntent created directly on the
-- restaurant's own Stripe account, with the platform fee, exactly like an
-- online card payment. So it is method 'card' — refunds, reports and
-- receipts work unchanged — marked card_present so the two can be told
-- apart.
--
-- Like every card payment, only Stripe may say it succeeded: the staff app
-- reports nothing. mark_tap_to_pay_succeeded() is service_role only and is
-- called after the server has read the PaymentIntent from Stripe (and by
-- the webhook, as a backstop).

alter table public.order_payments
  add column card_present boolean not null default false;

comment on column public.order_payments.card_present is
  'A card payment taken in person with Tap to Pay in the staff app (a Stripe card-present PaymentIntent), rather than online. recorded_by is the staff member who took it.';

alter table public.restaurant_payment_accounts
  add column terminal_location_id text;

comment on column public.restaurant_payment_accounts.terminal_location_id is
  'The Stripe Terminal Location on the restaurant''s connected account that Tap to Pay readers register to. Created on first use.';

-- Starts a Tap to Pay payment for one order or a whole table. Any member
-- may take payment, as with cash and the card machine; the restaurant must
-- accept card and its Stripe account must be able to take charges.
create function public.start_tap_to_pay_payment(
  p_order_ids uuid[],
  p_tip_amount numeric default 0
)
returns table (
  payment_id uuid,
  amount numeric,
  tip_amount numeric,
  total_amount numeric,
  currency text,
  stripe_account_id text,
  terminal_location_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_settings public.restaurant_settings%rowtype;
  v_account public.restaurant_payment_accounts%rowtype;
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

  -- SECURITY DEFINER bypasses RLS, so this is the access control.
  if not public.is_restaurant_member(v_restaurant_id) then
    raise exception 'PAYMENT_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;

  select * into v_settings
  from public.restaurant_settings s where s.restaurant_id = v_restaurant_id;
  if not found or not v_settings.accept_card then
    raise exception 'PAYMENT_CARD_NOT_ACCEPTED: restaurant does not accept card' using errcode = '22023';
  end if;
  if not v_settings.tipping_enabled and p_tip_amount > 0 then
    raise exception 'PAYMENT_TIPPING_DISABLED: restaurant has tipping switched off'
      using errcode = '22023';
  end if;

  select * into v_account
  from public.restaurant_payment_accounts a where a.restaurant_id = v_restaurant_id;
  if not found or not v_account.charges_enabled then
    raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges'
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

  -- An earlier tap attempt for these orders that never finished (the
  -- server stepped away, the app was closed) is closed off, so a table
  -- never has two live taps waiting. Online checkouts are left alone.
  update public.order_payments p
  set status = 'cancelled'
  where p.status = 'pending'
    and p.card_present
    and p.id in (
      select po.payment_id from public.payment_orders po
      where po.order_id = any(p_order_ids)
    );

  insert into public.order_payments (
    restaurant_id, status, method, card_present, amount, tip_amount, currency,
    recorded_by
  ) values (
    v_restaurant_id, 'pending', 'card', true, v_total, p_tip_amount, v_currency,
    auth.uid()
  )
  returning id into v_payment_id;

  insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
  select v_payment_id, o.id, v_restaurant_id, o.total
  from public.orders o where o.id = any(p_order_ids);

  return query
    select p.id, p.amount, p.tip_amount, p.total_amount, p.currency,
           v_account.stripe_account_id, v_account.terminal_location_id
    from public.order_payments p
    where p.id = v_payment_id;
end;
$$;

comment on function public.start_tap_to_pay_payment(uuid[], numeric) is
  'Opens a pending Tap to Pay (card-present) payment for one order or a table''s orders, taken by the calling member. The charge is made by the server on the restaurant''s Stripe account; only mark_tap_to_pay_succeeded() settles it.';

revoke execute on function public.start_tap_to_pay_payment(uuid[], numeric) from public, anon;
grant execute on function public.start_tap_to_pay_payment(uuid[], numeric) to authenticated;

-- Links the pending payment to the PaymentIntent the server just created,
-- so the webhook and the finish step can find it.
create function public.attach_tap_to_pay_intent(
  p_payment_id uuid,
  p_payment_intent_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
begin
  select * into v_payment from public.order_payments where id = p_payment_id for update;
  if not found or not public.is_restaurant_member(v_payment.restaurant_id) then
    raise exception 'PAYMENT_NOT_FOUND: no such payment' using errcode = 'P0002';
  end if;
  if not v_payment.card_present or v_payment.status <> 'pending'
     or v_payment.stripe_payment_intent_id is not null then
    raise exception 'PAYMENT_NOT_PENDING: payment is not waiting for a tap' using errcode = '22023';
  end if;
  if p_payment_intent_id is null or p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$' then
    raise exception 'PAYMENT_BAD_INTENT: not a PaymentIntent id' using errcode = '22023';
  end if;
  update public.order_payments
  set stripe_payment_intent_id = p_payment_intent_id
  where id = p_payment_id;
end;
$$;

revoke execute on function public.attach_tap_to_pay_intent(uuid, text) from public, anon;
grant execute on function public.attach_tap_to_pay_intent(uuid, text) to authenticated;

-- Settles a Tap to Pay payment once Stripe says the PaymentIntent
-- succeeded. service_role only: called by the server after reading the
-- PaymentIntent from Stripe, and by the webhook. Idempotent; false for an
-- intent this database doesn't know.
create function public.mark_tap_to_pay_succeeded(p_payment_intent_id text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status
  from public.order_payments
  where stripe_payment_intent_id = p_payment_intent_id and card_present
  for update;

  if not found then
    return false;
  end if;
  if v_status = 'succeeded' then
    return true;
  end if;

  update public.order_payments
  set status = 'succeeded', paid_at = now()
  where stripe_payment_intent_id = p_payment_intent_id and card_present;
  return true;
end;
$$;

revoke execute on function public.mark_tap_to_pay_succeeded(text) from public, anon, authenticated;
grant execute on function public.mark_tap_to_pay_succeeded(text) to service_role;

-- The member stopped a tap before it went through. Only a pending tap
-- payment; a succeeded one is refunded, never cancelled.
create function public.cancel_tap_to_pay_payment(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
begin
  select restaurant_id into v_restaurant_id
  from public.order_payments where id = p_payment_id and card_present;
  if not found or not public.is_restaurant_member(v_restaurant_id) then
    raise exception 'PAYMENT_NOT_FOUND: no such payment' using errcode = 'P0002';
  end if;
  update public.order_payments
  set status = 'cancelled'
  where id = p_payment_id and status = 'pending';
  return found;
end;
$$;

revoke execute on function public.cancel_tap_to_pay_payment(uuid) from public, anon;
grant execute on function public.cancel_tap_to_pay_payment(uuid) to authenticated;

-- Stores the Terminal Location created on the restaurant's Stripe account.
-- service_role only: the server creates the location after checking the
-- caller is a member.
create function public.set_terminal_location(
  p_restaurant_id uuid,
  p_location_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_location_id is null or p_location_id !~ '^tml_[A-Za-z0-9]+$' then
    raise exception 'PAYMENT_BAD_LOCATION: not a Terminal Location id' using errcode = '22023';
  end if;
  update public.restaurant_payment_accounts
  set terminal_location_id = p_location_id
  where restaurant_id = p_restaurant_id;
end;
$$;

revoke execute on function public.set_terminal_location(uuid, text) from public, anon, authenticated;
grant execute on function public.set_terminal_location(uuid, text) to service_role;
