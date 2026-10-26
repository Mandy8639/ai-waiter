-- Square restaurants: everything taken at the table reaches Square's own
-- reports, and anything that didn't can be sent again.
--
-- Square phase 3 (20261111090000) copied cash sales into Square. Missing
-- until now, so an owner's Square reports disagreed with Tableside's:
--
--   - Card-machine payments (a reader that isn't Square's). They go to
--     Square as an EXTERNAL payment of type CARD, which Square reports as
--     "other card", so the day's total matches.
--   - Parts of a split bill, cash or card machine (20261115090000). They
--     cover no orders until the whole bill is paid, so Square gets one line
--     for exactly what each part came to.
--   - Refunds of a sale that was copied (cash or card machine,
--     20261114090000), mirrored as a refund of the Square payment.
--   - Copies that failed (Square down, the connection briefly lost): they
--     were reported and then forgotten. square_unsynced() lists them for
--     Settings → Point of sale, which sends them again.
--
-- Only an in-person payment is ever copied: Square already has every card
-- payment it took itself.

-- attach_square_cash_sale() now takes card-machine payments too. The name
-- stays, so nothing calling it changes.
create or replace function public.attach_square_cash_sale(
  p_payment_id uuid,
  p_square_order_id text,
  p_square_payment_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
begin
  select * into v_payment from public.order_payments where id = p_payment_id;
  if not found or not public.is_restaurant_member(v_payment.restaurant_id) then
    raise exception 'PAYMENT_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;
  if v_payment.method not in ('cash', 'card_terminal') or v_payment.status <> 'succeeded' then
    raise exception 'PAYMENT_NOT_IN_PERSON: only a recorded cash or card-machine payment can be sent to Square'
      using errcode = '22023';
  end if;
  if v_payment.square_payment_id is not null then
    return; -- already sent
  end if;
  update public.order_payments
  set square_order_id = p_square_order_id,
      square_payment_id = p_square_payment_id
  where id = p_payment_id;
end;
$$;

-- Records the Square refund a cash or card-machine refund was mirrored as.
-- The refund itself was done (and recorded) when the money was handed back;
-- this only links it, once.
create function public.attach_copied_refund(p_refund_id uuid, p_square_refund_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund public.payment_refunds%rowtype;
  v_method text;
begin
  select * into v_refund from public.payment_refunds where id = p_refund_id for update;
  if not found or coalesce(public.current_restaurant_role(v_refund.restaurant_id), '') not in ('owner', 'manager') then
    raise exception 'REFUND_FORBIDDEN: only an owner or manager can refund a payment' using errcode = '42501';
  end if;
  select p.method into v_method from public.order_payments p where p.id = v_refund.payment_id;
  if v_method not in ('cash', 'card_terminal') or v_refund.status <> 'succeeded' then
    raise exception 'REFUND_NOT_IN_PERSON: only a recorded cash or card-machine refund is copied to Square'
      using errcode = '22023';
  end if;
  if p_square_refund_id is null or length(p_square_refund_id) not between 1 and 192 then
    raise exception 'REFUND_INVALID: missing Square refund id' using errcode = '22023';
  end if;
  update public.payment_refunds
  set square_refund_id = p_square_refund_id
  where id = p_refund_id and square_refund_id is null;
end;
$$;

revoke execute on function public.attach_copied_refund(uuid, text) from public, anon;
grant execute on function public.attach_copied_refund(uuid, text) to authenticated, service_role;

-- What hasn't reached Square: in-person payments and their refunds, since
-- the restaurant connected Square, a couple of minutes old (a copy runs
-- just after the payment, so a newer one is probably still on its way).
create function public.square_unsynced(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_since timestamptz;
begin
  if coalesce(public.current_restaurant_role(p_restaurant_id), '') not in ('owner', 'manager') then
    raise exception 'PAYMENT_FORBIDDEN: only an owner or manager can see this' using errcode = '42501';
  end if;
  if public.restaurant_card_provider(p_restaurant_id) <> 'square' then
    return jsonb_build_object('payments', '[]'::jsonb, 'refunds', '[]'::jsonb);
  end if;
  select greatest(i.connected_at, now() - interval '30 days') into v_since
  from public.restaurant_pos_integrations i
  where i.restaurant_id = p_restaurant_id and i.provider = 'square';

  return jsonb_build_object(
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'method', p.method, 'total', p.total_amount,
        'currency', p.currency, 'paid_at', p.paid_at) order by p.paid_at)
      from public.order_payments p
      where p.restaurant_id = p_restaurant_id
        and p.method in ('cash', 'card_terminal')
        and p.status = 'succeeded'
        and p.square_payment_id is null
        and p.paid_at >= coalesce(v_since, now() - interval '30 days')
        and p.paid_at < now() - interval '2 minutes'
    ), '[]'::jsonb),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'amount', r.amount, 'currency', r.currency,
        'refunded_at', r.refunded_at) order by r.refunded_at)
      from public.payment_refunds r
      join public.order_payments p on p.id = r.payment_id
      where r.restaurant_id = p_restaurant_id
        and r.status = 'succeeded'
        and r.square_refund_id is null
        and p.method in ('cash', 'card_terminal')
        and p.square_payment_id is not null
        and r.refunded_at < now() - interval '2 minutes'
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.square_unsynced(uuid) from public, anon;
grant execute on function public.square_unsynced(uuid) to authenticated, service_role;
