-- Paid at the register on the restaurant's own card machine.
--
-- Many restaurants never let the diner pay on their phone: the guest walks
-- to the counter and taps a card on the restaurant's own terminal (Square,
-- Clover, the bank's machine). Tableside had no way to say so. Settle up
-- offered cash or nothing, so those tables stayed "unpaid" forever and
-- Reports undercounted the day.
--
-- A card-machine payment is, to Tableside, the same kind of thing as cash:
-- a RECORD of money a person says was already taken, not a charge we make.
-- No Stripe object, settled at once, recorded by a named member, and
-- reversible (owner/manager, with a reason) rather than refundable — the
-- refund, if there is one, happens on the machine, which we can't reach.
-- So it shares cash's code path instead of copying it: one function,
-- record_in_person_payment(), takes the method, and record_cash_payment()
-- becomes a thin wrapper so nothing calling it changes.
--
-- Its own setting, accept_card_terminal, off by default like accept_cash:
-- a restaurant that takes card only through Tableside shouldn't have staff
-- able to mark a table "paid by card machine" when it has none.
--
-- The tip rule is the cash one, unchanged: a tip is refused while the
-- restaurant has tipping switched off (see 20260902180000_cash_tip_gate.sql
-- for why every path must enforce it).
--
-- start_refund() already refuses anything but 'card' (REFUND_NOT_CARD), so
-- a card-machine payment can never be pushed back through Stripe.

alter table public.restaurant_settings
  add column accept_card_terminal boolean not null default false;

comment on column public.restaurant_settings.accept_card_terminal is
  'Whether staff may record payments taken on the restaurant''s own card machine at the register. A record, not a charge: nothing goes through Stripe.';

alter table public.order_payments
  drop constraint order_payments_method_valid;

alter table public.order_payments
  add constraint order_payments_method_valid check (
    method in ('card', 'cash', 'card_terminal')
  );

comment on column public.order_payments.recorded_by is
  'The staff member who recorded a cash or card-machine payment. Null for card, where Stripe is the actor rather than a person.';


-- Records money already taken in person — cash, or the restaurant's own
-- card machine — for one order or a whole tab. Settled immediately.
--
-- The body is record_cash_payment() as of 20260902180000 with the method
-- as a parameter and the matching setting checked for it.
create function public.record_in_person_payment(
  p_order_ids uuid[],
  p_method text,
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
  -- 'card' is Stripe's alone: only its signed webhook may say a card
  -- payment happened.
  if p_method is null or p_method not in ('cash', 'card_terminal') then
    raise exception 'PAYMENT_INVALID_METHOD: record cash or a card-machine payment'
      using errcode = '22023';
  end if;

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
  -- control. Any member may record a payment — see the header of
  -- 20260902100000_cash_payments.sql for why.
  if not public.is_restaurant_member(v_restaurant_id) then
    raise exception 'PAYMENT_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;

  select * into v_settings
  from public.restaurant_settings s
  where s.restaurant_id = v_restaurant_id;

  if p_method = 'cash' and (not found or not v_settings.accept_cash) then
    raise exception 'PAYMENT_CASH_NOT_ACCEPTED: restaurant does not record cash payments'
      using errcode = '22023';
  end if;

  if p_method = 'card_terminal' and (not found or not v_settings.accept_card_terminal) then
    raise exception 'PAYMENT_CARD_TERMINAL_NOT_ACCEPTED: restaurant does not record card-machine payments'
      using errcode = '22023';
  end if;

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
    v_restaurant_id, 'succeeded', p_method, v_total, p_tip_amount, v_currency,
    now(), auth.uid()
  )
  returning id into v_payment_id;

  insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
  select v_payment_id, o.id, v_restaurant_id, o.total
  from public.orders o where o.id = any(p_order_ids);

  return v_payment_id;
end;
$$;

comment on function public.record_in_person_payment(uuid[], text, numeric) is
  'Records money already taken in person — cash, or the restaurant''s own card machine — for one order or a whole tab, settled immediately. Any restaurant member may call it; the amount is summed from the orders, never supplied by the caller. See docs/security.md#payments.';

revoke execute on function public.record_in_person_payment(uuid[], text, numeric) from public, anon;
grant execute on function public.record_in_person_payment(uuid[], text, numeric) to authenticated;


-- Kept for anything still calling it by name; the rules live in
-- record_in_person_payment() now.
create or replace function public.record_cash_payment(
  p_order_ids uuid[],
  p_tip_amount numeric default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.record_in_person_payment(p_order_ids, 'cash', p_tip_amount);
end;
$$;


-- Reversal now covers both in-person kinds. A card-machine payment
-- recorded against the wrong table is the same bookkeeping mistake as
-- mis-recorded cash, with the same owner/manager gate and required
-- reason. Card (Stripe) payments are still refused: those are refunds.
create or replace function public.reverse_cash_payment(
  p_payment_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
  v_role text;
begin
  select * into v_payment
  from public.order_payments where id = p_payment_id;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: no such payment' using errcode = 'P0002';
  end if;

  v_role := public.current_restaurant_role(v_payment.restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'PAYMENT_FORBIDDEN: only an owner or manager can reverse a payment'
      using errcode = '42501';
  end if;

  if v_payment.method not in ('cash', 'card_terminal') then
    raise exception 'PAYMENT_NOT_CASH: only a cash or card-machine payment can be reversed — refund a card payment instead'
      using errcode = '22023';
  end if;

  if v_payment.status <> 'succeeded' then
    raise exception 'PAYMENT_NOT_REVERSIBLE: only a settled payment can be reversed'
      using errcode = '22023';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'PAYMENT_REASON_REQUIRED: give a reason for the reversal' using errcode = '22023';
  end if;

  -- paid_at is kept deliberately: the money was recorded as received at
  -- that moment, and erasing that loses the only evidence of it.
  update public.order_payments
  set status = 'reversed',
      reversed_at = now(),
      reversed_by = auth.uid(),
      reversal_reason = trim(p_reason)
  where id = p_payment_id;
end;
$$;

comment on function public.reverse_cash_payment(uuid, text) is
  'Reverses a mistakenly recorded cash or card-machine payment, owner/manager only, keeping the row and its paid_at as an audit trail. Refuses card (Stripe) payments — undoing one of those is a refund. See docs/security.md#payments.';
