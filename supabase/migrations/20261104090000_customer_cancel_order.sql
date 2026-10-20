-- A diner can cancel their own order while it is still "Order received"
-- (status 'pending'): the kitchen hasn't accepted it, so nothing has been
-- cooked. Before this, an order placed by mistake could only be cancelled
-- by staff. "Change order" in the app is this plus putting the same dishes
-- back in the cart (src/lib/orders/customer-cancel.ts).
--
-- Refused, each with its own code so the app can say why:
--   ORDER_CANCEL_NOT_FOUND  not this diner's order (indistinguishable from
--                           one that doesn't exist, as everywhere else)
--   ORDER_CANCEL_TOO_LATE   the kitchen has accepted it
--   ORDER_CANCEL_ALREADY    already cancelled
--   ORDER_CANCEL_PAID       a card payment covers it, or is in progress:
--                           cancelling would need a refund, which staff do
-- An order in a bill being split is refused by orders_not_cancelled_in_split.

create function public.customer_cancel_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.orders%rowtype;
begin
  if v_user_id is null then
    raise exception 'ORDER_CANCEL_NOT_FOUND: order not found' using errcode = '28000';
  end if;

  -- Row lock: a kitchen tap accepting the order at the same moment is
  -- serialised with this, so exactly one of them wins.
  select * into v_order from public.orders where id = p_order_id for update;

  if not found or not exists (
    select 1 from public.customer_sessions cs
    where cs.id = v_order.customer_session_id and cs.user_id = v_user_id
  ) then
    raise exception 'ORDER_CANCEL_NOT_FOUND: order not found' using errcode = '42501';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'ORDER_CANCEL_ALREADY: order already cancelled' using errcode = '23514';
  end if;
  if v_order.status <> 'pending' then
    raise exception 'ORDER_CANCEL_TOO_LATE: the kitchen has accepted this order' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.payment_orders po
    join public.order_payments p on p.id = po.payment_id
    where po.order_id = v_order.id and p.status in ('pending', 'succeeded')
  ) then
    raise exception 'ORDER_CANCEL_PAID: this order has a card payment' using errcode = '23514';
  end if;

  update public.orders set status = 'cancelled' where id = v_order.id
  returning * into v_order;

  insert into public.order_status_history (
    restaurant_id, order_id, previous_status, status, actor_type, actor_id
  )
  values (v_order.restaurant_id, v_order.id, 'pending', 'cancelled', 'customer', v_user_id);

  return v_order;
end;
$$;

comment on function public.customer_cancel_order(uuid) is
  'A diner cancels their own order while it is still pending (not yet accepted by the kitchen) and not paid. Recorded in order_status_history as actor_type customer.';

revoke execute on function public.customer_cancel_order(uuid) from public, anon;
grant execute on function public.customer_cancel_order(uuid) to authenticated;
