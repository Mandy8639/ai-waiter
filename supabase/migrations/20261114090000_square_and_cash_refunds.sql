-- Settle up, second batch: refunds for every way a table can pay.
--
-- Until now start_refund() took only Stripe card payments. Two gaps:
--
--   - A Square card payment (a diner's payment link, or a Square Terminal)
--     is method 'card' with a square_payment_id and no Stripe charge, so
--     Reports offered a Refund button that start_refund() then refused.
--     It now refunds through Square, back to the same card.
--
--   - Cash and card-machine payments could only be reversed — all of it,
--     as if it was never taken. Handing back $5 of a $40 bill had no
--     record. They can now be refunded in part: no money moves through
--     Tableside (the restaurant hands back the notes, or refunds on its own
--     machine), so the refund is recorded as done at once.
--
-- Reversing stays, for a payment that was recorded by mistake. Comp
-- payments ($0, 20261113090000) have nothing to refund.
--
-- Everything else about refunds is unchanged: owner or manager only,
-- recorded before any money moves, and never more than was charged
-- (enforce_refund_within_payment()).

alter table public.payment_refunds
  add column square_refund_id text unique;

comment on column public.payment_refunds.square_refund_id is
  'The Square refund this row became, for a Square card payment. Set by attach_refund_square_id().';

drop function public.start_refund(uuid, numeric, text);

create function public.start_refund(
  p_payment_id uuid,
  p_amount numeric,
  p_reason text
)
returns table (
  refund_id uuid,
  amount numeric,
  currency text,
  -- 'stripe' or 'square': the server sends the refund there next. 'none':
  -- cash or a card machine, recorded as done; nothing to send.
  provider text,
  stripe_payment_intent_id text,
  stripe_account_id text,
  square_payment_id text,
  restaurant_id uuid,
  payment_total numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
  v_account public.restaurant_payment_accounts%rowtype;
  v_role text;
  v_provider text;
  v_refund_id uuid;
  v_amount numeric(10, 2);
begin
  select * into v_payment from public.order_payments where id = p_payment_id;
  if not found then
    raise exception 'REFUND_PAYMENT_NOT_FOUND: no such payment' using errcode = 'P0002';
  end if;

  v_role := public.current_restaurant_role(v_payment.restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'REFUND_FORBIDDEN: only an owner or manager can refund a payment'
      using errcode = '42501';
  end if;

  if v_payment.method = 'comp' then
    raise exception 'REFUND_NOTHING_CHARGED: nothing was charged for this order'
      using errcode = '22023';
  end if;

  if v_payment.status <> 'succeeded' then
    raise exception 'REFUND_PAYMENT_NOT_SETTLED: only a settled payment can be refunded'
      using errcode = '22023';
  end if;

  v_provider := case
    when v_payment.method in ('cash', 'card_terminal') then 'none'
    when v_payment.stripe_payment_intent_id is not null then 'stripe'
    when v_payment.square_payment_id is not null then 'square'
  end;
  if v_provider is null then
    raise exception 'REFUND_NO_PAYMENT_INTENT: this payment has no card charge to refund'
      using errcode = '22023';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REFUND_REASON_REQUIRED: give a reason for the refund' using errcode = '22023';
  end if;

  v_amount := coalesce(
    p_amount,
    v_payment.total_amount - public.payment_refunded_total(p_payment_id)
  );

  if v_amount <= 0 then
    raise exception 'REFUND_NOTHING_LEFT: this payment is already fully refunded'
      using errcode = '22023';
  end if;

  if public.payment_refunded_total(p_payment_id) + v_amount > v_payment.total_amount then
    raise exception 'REFUND_EXCEEDS_PAYMENT: refunding % would exceed the % charged',
      v_amount, v_payment.total_amount
      using errcode = '22023';
  end if;

  if v_provider = 'stripe' then
    select * into v_account
    from public.restaurant_payment_accounts a
    where a.restaurant_id = v_payment.restaurant_id;
    if not found then
      raise exception 'REFUND_NO_ACCOUNT: restaurant has no connected account' using errcode = '22023';
    end if;
  end if;

  insert into public.payment_refunds (
    payment_id, restaurant_id, amount, currency, reason, status, refunded_at, created_by
  ) values (
    p_payment_id, v_payment.restaurant_id, v_amount, v_payment.currency, trim(p_reason),
    case when v_provider = 'none' then 'succeeded' else 'pending' end,
    case when v_provider = 'none' then now() end,
    auth.uid()
  )
  returning id into v_refund_id;

  return query
    select r.id, r.amount, r.currency, v_provider,
           v_payment.stripe_payment_intent_id, v_account.stripe_account_id,
           v_payment.square_payment_id, v_payment.restaurant_id, v_payment.total_amount
    from public.payment_refunds r
    where r.id = v_refund_id;
end;
$$;

comment on function public.start_refund(uuid, numeric, text) is
  'Opens a refund against a settled payment, owner/manager only. A null amount refunds whatever is left. Card payments come back pending, to be sent to Stripe or Square; cash and card-machine refunds are recorded as done. See docs/security.md#payments.';

revoke execute on function public.start_refund(uuid, numeric, text) from public, anon;
grant execute on function public.start_refund(uuid, numeric, text) to authenticated, service_role;

-- Links a pending refund to the Square refund it became and records what
-- Square said: COMPLETED settles it, REJECTED or FAILED fails it (releasing
-- the amount it held), PENDING leaves it waiting. Called again with a later
-- status when Reports checks on a pending one.
create function public.attach_refund_square_id(
  p_refund_id uuid,
  p_square_refund_id text,
  p_status text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund public.payment_refunds%rowtype;
  v_role text;
begin
  select * into v_refund from public.payment_refunds where id = p_refund_id for update;
  if not found then
    raise exception 'REFUND_NOT_FOUND: no such refund' using errcode = 'P0002';
  end if;

  v_role := public.current_restaurant_role(v_refund.restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'REFUND_FORBIDDEN: only an owner or manager can refund a payment'
      using errcode = '42501';
  end if;

  if p_square_refund_id is null or length(p_square_refund_id) not between 1 and 192 then
    raise exception 'REFUND_INVALID: missing Square refund id' using errcode = '22023';
  end if;
  if v_refund.square_refund_id is not null and v_refund.square_refund_id <> p_square_refund_id then
    raise exception 'REFUND_ALREADY_LINKED: this refund already points at a different Square refund'
      using errcode = '22023';
  end if;

  if v_refund.status <> 'pending' then
    return v_refund.status;
  end if;

  update public.payment_refunds
  set square_refund_id = p_square_refund_id,
      status = case upper(p_status)
        when 'COMPLETED' then 'succeeded'
        when 'REJECTED' then 'failed'
        when 'FAILED' then 'failed'
        else 'pending'
      end,
      refunded_at = case when upper(p_status) = 'COMPLETED' then now() end,
      updated_at = now()
  where id = p_refund_id;

  return (select status from public.payment_refunds where id = p_refund_id);
end;
$$;

revoke execute on function public.attach_refund_square_id(uuid, text, text) from public, anon;
grant execute on function public.attach_refund_square_id(uuid, text, text) to authenticated, service_role;
