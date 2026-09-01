-- Stop a diner being charged twice for one order.
--
-- THE BUG, found by paying for real orders in production rather than by
-- any test: start_order_payment() refused a new payment only when a
-- SUCCEEDED one existed. While a payment sat 'pending' it happily created
-- a second one, and each payment row opens its own Stripe Checkout
-- session. Two sessions means two charges.
--
-- This is not an exotic race. Settlement is asynchronous by design — the
-- order page keeps saying "not paid" until Stripe's signed webhook
-- arrives, which is normally seconds but can be longer. A diner who pays,
-- sees an unpaid screen, and presses Pay again is behaving reasonably, and
-- was charged twice for it. Orders #2 and #3 in production each took two
-- real charges this way.
--
-- What the old code got right is worth stating, because it is easy to
-- conflate: the partial unique index still guaranteed an order could never
-- be RECORDED as paid twice. It could not, and cannot, stop Stripe from
-- TAKING the money twice. Recording and charging are different problems,
-- and only the first was solved.
--
--
-- THE FIX: reuse rather than refuse.
--
-- When a pending payment already exists for the order, hand back that
-- same row instead of creating another. The server action derives its
-- Stripe idempotency key from the payment id
-- (`checkout:<payment_id>`, see src/lib/payments/checkout.ts), so
-- returning the same row makes Stripe return the SAME Checkout session —
-- the diner lands back on the payment they already started, which is
-- exactly what they meant to do. If they had in fact already paid it, that
-- session is complete and Stripe simply sends them to the success page.
--
-- Reuse is conditional on the tip matching. A different tip is a different
-- amount, and silently charging the earlier figure would be its own bug;
-- that case is refused with an error the diner can act on instead.
--
-- Deliberately NOT done: cancelling the old pending payment and starting a
-- fresh one. The pending row may correspond to a session that has already
-- been paid but whose webhook has not landed yet — cancelling it and
-- opening a new session is precisely how the double charge happens.
create or replace function public.start_order_payment(
  p_order_id uuid,
  p_tip_amount numeric default 0
)
returns table (
  payment_id uuid,
  amount numeric,
  tip_amount numeric,
  total_amount numeric,
  currency text,
  stripe_account_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_settings public.restaurant_settings%rowtype;
  v_account public.restaurant_payment_accounts%rowtype;
  v_payment_id uuid;
  v_existing public.order_payments%rowtype;
begin
  if p_tip_amount is null or p_tip_amount < 0 then
    raise exception 'Tip cannot be negative' using errcode = '22023';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'PAYMENT_ORDER_NOT_FOUND: no such order' using errcode = 'P0002';
  end if;

  -- Authorization: only the diner whose session placed this order may pay
  -- for it. SECURITY DEFINER bypasses RLS, so this check is not a
  -- convenience — it IS the access control for this function.
  if not public.order_belongs_to_caller(p_order_id) then
    raise exception 'PAYMENT_NOT_YOUR_ORDER: order belongs to another session' using errcode = '42501';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'PAYMENT_ORDER_CANCELLED: order was cancelled' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.order_payments p
    where p.order_id = p_order_id and p.status = 'succeeded'
  ) then
    raise exception 'PAYMENT_ALREADY_PAID: order already has a succeeded payment' using errcode = '23505';
  end if;

  select * into v_settings
  from public.restaurant_settings s
  where s.restaurant_id = v_order.restaurant_id;

  if not found or not v_settings.accept_card then
    raise exception 'PAYMENT_CARD_NOT_ACCEPTED: restaurant does not accept card' using errcode = '22023';
  end if;

  if not v_settings.tipping_enabled and p_tip_amount > 0 then
    raise exception 'PAYMENT_TIPPING_DISABLED: restaurant has tipping switched off' using errcode = '22023';
  end if;

  select * into v_account
  from public.restaurant_payment_accounts a
  where a.restaurant_id = v_order.restaurant_id;

  if not found or not v_account.charges_enabled then
    raise exception 'PAYMENT_ACCOUNT_NOT_READY: connected account cannot take charges' using errcode = '22023';
  end if;

  -- The fix. Reuse the payment already in flight rather than opening a
  -- second one alongside it. Ordered oldest-first so that if several
  -- somehow exist (rows created before this migration), the earliest —
  -- the one most likely to carry a real Stripe session — wins.
  select * into v_existing
  from public.order_payments p
  where p.order_id = p_order_id
    and p.status = 'pending'
  order by p.created_at
  limit 1;

  if found then
    if v_existing.tip_amount <> p_tip_amount then
      -- A different tip is a different charge. Refuse rather than quietly
      -- charging the earlier amount, and say so in terms a diner can act
      -- on: finish or abandon the payment already open.
      raise exception 'PAYMENT_IN_PROGRESS: a payment for this order is already open with a different tip'
        using errcode = '22023';
    end if;

    return query
      select p.id, p.amount, p.tip_amount, p.total_amount, p.currency,
             v_account.stripe_account_id
      from public.order_payments p
      where p.id = v_existing.id;
    return;
  end if;

  insert into public.order_payments (
    restaurant_id, order_id, status, method, amount, tip_amount, currency
  ) values (
    v_order.restaurant_id, p_order_id, 'pending', 'card',
    v_order.total, p_tip_amount, v_order.currency
  )
  returning id into v_payment_id;

  return query
    select p.id, p.amount, p.tip_amount, p.total_amount, p.currency,
           v_account.stripe_account_id
    from public.order_payments p
    where p.id = v_payment_id;
end;
$$;

comment on function public.start_order_payment(uuid, numeric) is
  'Creates — or reuses — a pending card payment for the caller''s own order and returns what is needed to open a Stripe Checkout session. Reusing the pending row keeps the Stripe idempotency key stable, so a diner who presses Pay twice returns to the same Checkout session instead of being charged twice. Derives the amount from the order, never from the caller. See docs/security.md#payments.';


-- Attaching a session must tolerate being called again for the SAME
-- session. Reuse means the server action re-runs its whole path — Stripe
-- returns the identical session for the identical idempotency key — and
-- the second attach previously raised PAYMENT_NOT_PENDING, turning a
-- correct reuse into a user-facing error.
--
-- Still refuses to point a payment at a DIFFERENT session than the one it
-- already has: that would orphan the first session, which is the exact
-- condition under which a charge goes unrecorded.
create or replace function public.attach_payment_checkout_session(
  p_payment_id uuid,
  p_checkout_session_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing text;
  v_status text;
begin
  if not public.order_belongs_to_caller(
    (select order_id from public.order_payments where id = p_payment_id)
  ) then
    raise exception 'PAYMENT_NOT_YOUR_ORDER: order belongs to another session' using errcode = '42501';
  end if;

  select stripe_checkout_session_id, status into v_existing, v_status
  from public.order_payments
  where id = p_payment_id;

  if not found then
    raise exception 'PAYMENT_NOT_PENDING: no such payment' using errcode = '22023';
  end if;

  -- Idempotent no-op: this exact session is already linked.
  if v_existing is not null and v_existing = p_checkout_session_id then
    return;
  end if;

  if v_status <> 'pending' or v_existing is not null then
    raise exception 'PAYMENT_NOT_PENDING: payment is not pending or already has a different session'
      using errcode = '22023';
  end if;

  update public.order_payments
  set stripe_checkout_session_id = p_checkout_session_id
  where id = p_payment_id;
end;
$$;

comment on function public.attach_payment_checkout_session(uuid, text) is
  'Links a Stripe Checkout session to its pending payment row. Idempotent for the same session id, so reusing a pending payment does not error; still refuses to repoint a payment at a different session. See docs/security.md#payments.';
