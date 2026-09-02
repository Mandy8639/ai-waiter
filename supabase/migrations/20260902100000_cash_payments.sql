-- Payments phase 3, step 2 — recording cash.
--
-- `restaurant_settings.accept_cash` has existed since phase 1 with nothing
-- behind it. This gives it a write path.
--
-- Cash is not a charge, it is a RECORD of a charge that already happened
-- at the table. So there is no Stripe object, no pending state and no
-- webhook: the payment is created already settled. That makes it the one
-- payment kind a person asserts rather than a payment processor confirms,
-- which is exactly why it needs to be reversible and attributable.
--
--
-- WHO CAN DO WHAT, AND WHY
--
-- Recording: any restaurant member. The person holding the notes is the
-- waiter, not the manager — restricting this to owner/manager would just
-- be worked around by everyone sharing one login, which is worse.
--
-- Reversing: owner or manager only. A mis-tap should be fixable, but the
-- fix is the part worth controlling, since "unrecord this cash" is how a
-- till is skimmed. Both actions record WHO did them.
--
--
-- REVERSAL IS NOT DELETION
--
-- A reversed payment keeps its row, its amount and its paid_at, and gains
-- `reversed_at`/`reversed_by`/`reversal_reason`. Deleting it, or quietly
-- flipping it to 'cancelled', would destroy the evidence that money was
-- once recorded as received — the single most useful fact when a till does
-- not balance. The audit_log trigger already covers order_payments, so a
-- reversal is recorded there too.

alter table public.order_payments
  drop constraint order_payments_method_valid;

alter table public.order_payments
  add constraint order_payments_method_valid check (method in ('card', 'cash'));

alter table public.order_payments
  drop constraint order_payments_status_valid;

alter table public.order_payments
  add constraint order_payments_status_valid check (
    status in ('pending', 'succeeded', 'failed', 'cancelled', 'reversed')
  );

alter table public.order_payments
  add column reversed_at timestamptz,
  add column reversed_by uuid references auth.users (id) on delete set null,
  add column reversal_reason text,
  -- Who recorded a cash payment. Null for card, where Stripe is the actor.
  add column recorded_by uuid references auth.users (id) on delete set null;

-- A reversed payment was genuinely paid at some point, so paid_at must
-- survive the reversal — the old constraint allowed paid_at only on
-- 'succeeded'.
alter table public.order_payments
  drop constraint order_payments_paid_at_matches_status;

alter table public.order_payments
  add constraint order_payments_paid_at_matches_status check (
    (status in ('succeeded', 'reversed') and paid_at is not null)
    or (status not in ('succeeded', 'reversed') and paid_at is null)
  );

alter table public.order_payments
  add constraint order_payments_reversal_fields_consistent check (
    (status = 'reversed' and reversed_at is not null)
    or (status <> 'reversed' and reversed_at is null)
  );

alter table public.order_payments
  add constraint order_payments_reversal_reason_length check (
    reversal_reason is null or length(trim(reversal_reason)) between 1 and 500
  );

comment on column public.order_payments.recorded_by is
  'The staff member who recorded a cash payment. Null for card, where Stripe is the actor rather than a person.';
comment on column public.order_payments.reversed_at is
  'When a cash payment was reversed. The row keeps its amount and paid_at — a reversal is a correction with an audit trail, not a deletion.';


-- Records cash taken at the table, for one order or a whole tab.
--
-- Settles immediately: there is no processor to wait for. The
-- one-succeeded-payment-per-order trigger still applies, so cash cannot
-- double-settle an order already paid by card, or the reverse.
create function public.record_cash_payment(
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
  -- control. Any member may record cash — see the header for why.
  if not public.is_restaurant_member(v_restaurant_id) then
    raise exception 'PAYMENT_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.restaurant_settings s
    where s.restaurant_id = v_restaurant_id and s.accept_cash
  ) then
    raise exception 'PAYMENT_CASH_NOT_ACCEPTED: restaurant does not record cash payments'
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
  'Records cash taken at the table for one order or a whole tab, settled immediately. Any restaurant member may call it; the amount is summed from the orders, never supplied by the caller. See docs/security.md#payments.';

revoke execute on function public.record_cash_payment(uuid[], numeric) from public;
grant execute on function public.record_cash_payment(uuid[], numeric) to authenticated;


-- Reverses a mistakenly recorded cash payment. Owner/manager only.
--
-- Deliberately refuses card payments: undoing one of those means moving
-- money back through Stripe, which is a refund (step 3), not a bookkeeping
-- correction. Letting this touch card payments would mark an order unpaid
-- while the customer's money stayed taken.
create function public.reverse_cash_payment(
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

  if v_payment.method <> 'cash' then
    raise exception 'PAYMENT_NOT_CASH: only a cash payment can be reversed — refund a card payment instead'
      using errcode = '22023';
  end if;

  if v_payment.status <> 'succeeded' then
    raise exception 'PAYMENT_NOT_REVERSIBLE: only a settled cash payment can be reversed'
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
  'Reverses a mistakenly recorded cash payment, owner/manager only, keeping the row and its paid_at as an audit trail. Refuses card payments — undoing one of those is a refund. See docs/security.md#payments.';

revoke execute on function public.reverse_cash_payment(uuid, text) from public;
grant execute on function public.reverse_cash_payment(uuid, text) to authenticated;
